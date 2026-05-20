#!/usr/bin/env -S npx tsx
// Disable TLS cert verification + silence the resulting warning. Must import
// FIRST so it runs before any HTTPS connection is made.
import './disable-tls-check.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pLimit } from './limit.js';
import { loadConfig, type WatchEntry } from './config.js';
import { ConfluenceClient } from './confluence.js';
import { convertStorageFormat } from './converter.js';
import {
  buildConvertOptions,
  buildMarkdownBody,
  downloadPages,
  pickPageRelPath,
  sourceUrlFor,
  titleIndexKey,
} from './downloader.js';
import { log } from './log.js';
import { htmlPathFor } from './pathing.js';
import { emptyState, readState, writeState } from './state.js';
import { planScopes } from './walker.js';

const BENCH_SAMPLE_SIZE = 30;
// Dropped 50 — even when bench's 30-request burst tolerates it, sustained
// load over thousands of pages drains the server's token bucket and the
// real sync hits cascading 429s.
const BENCH_CONCURRENCY_LEVELS = [1, 2, 5, 10, 20];

const FULL_ENUMERATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Set by runBench when it completes; consumed (and cleared) by runSync at the
// end so the bench's decision is restated alongside the sync summary instead
// of being scrolled off the top by all the per-page progress lines.
let lastBenchReport: string[] | null = null;

function buildFullEnumerationCQL(watch: WatchEntry): string {
  return `(id = ${watch} OR ancestor = ${watch}) AND type = page`;
}

async function ensureTuned(): Promise<void> {
  const { config } = await loadConfig();
  if (config.parallel_downloads && config.parallel_downloads > 0) {
    log.info(
      { parallel_downloads: config.parallel_downloads },
      `using configured parallel_downloads = ${config.parallel_downloads}; skipping autotune`,
    );
    return;
  }
  log.info('parallel_downloads not set in config.yaml — running autotune (one-time)');
  try {
    await runBench();
  } catch (err) {
    log.warn({ err }, 'autotune failed; sync will fall back to a heuristic this run');
  }
}

async function runSync(opts: { full: boolean; forceFullEnumeration?: boolean }): Promise<void> {
  await ensureTuned();
  const { config, rootDir } = await loadConfig();
  const outputDir = resolve(rootDir, config.output_dir);
  await mkdir(outputDir, { recursive: true });

  const state = opts.full ? emptyState() : await readState(outputDir);
  const localCount = Object.keys(state.pages).length;
  log.info(
    { localCount, lastSync: state.last_sync ?? '(none)', full: opts.full },
    `state loaded — ${localCount} pages already on disk; last_sync=${state.last_sync ?? '(none)'}`,
  );

  const client = new ConfluenceClient({
    baseUrl: config.base_url,
    pat: config.pat,
  });

  const since = opts.full ? undefined : state.last_sync ?? undefined;
  const scopes = planScopes(config.root_page_ids, since);
  log.info({ scopes: scopes.map((s) => s.cql), full: opts.full }, 'planned scopes');

  const seen = new Map<string, Awaited<ReturnType<typeof client.searchByCQL>>[number]>();
  for (const scope of scopes) {
    const results = await client.searchByCQL(scope.cql, ['version', 'space', 'ancestors']);
    for (const r of results) seen.set(r.id, r);
  }

  // Determine which ids have children so we can emit folder + _index.md.
  const pagesWithChildren = new Set<string>();
  for (const page of seen.values()) {
    for (const a of page.ancestors ?? []) pagesWithChildren.add(a.id);
  }

  // The configured root ids — used by pickPageRelPath to trim ancestor folders
  // above the root so the on-disk tree starts where the user said to.
  const rootPageIds = new Set(config.root_page_ids);

  const knownPagePaths = new Map<string, string>();
  for (const [id, st] of Object.entries(state.pages)) knownPagePaths.set(id, st.path);
  for (const page of seen.values()) {
    knownPagePaths.set(page.id, pickPageRelPath(page, pagesWithChildren, rootPageIds));
  }

  // Title→id map keyed by `${spaceKey}::${title}`. Seed from state (unchanged pages from
  // prior runs) then overlay this run's results so renames win.
  const titleIndex = new Map<string, string>();
  for (const [id, st] of Object.entries(state.pages)) {
    if (st.space && st.title) titleIndex.set(titleIndexKey(st.space, st.title), id);
  }
  for (const page of seen.values()) {
    const sp = page.space?.key;
    if (sp) titleIndex.set(titleIndexKey(sp, page.title), page.id);
  }

  const remaining = [...seen.values()].filter((p) => {
    const prev = state.pages[p.id];
    return !prev || prev.version !== (p.version?.number ?? 0);
  });

  // Split the work into new vs. updated for the post-sync summary.
  const newPageIds = new Set(remaining.filter((p) => !state.pages[p.id]).map((p) => p.id));
  const updatedPageIds = new Set(remaining.filter((p) => state.pages[p.id]).map((p) => p.id));

  // Keep the top-of-state counters fresh on every sync iteration. Both are
  // also re-computed before the final writeState, but flushing them here means
  // a per-page mid-sync state.json already shows current numbers.
  state.total_watched_pages_on_remote = seen.size;
  state.total_pages_downloaded = Object.keys(state.pages).length;

  log.info(
    { candidates: seen.size, remaining: remaining.length, new: newPageIds.size, updated: updatedPageIds.size },
    'sync diff',
  );

  const syncIso = new Date().toISOString();
  const result = await downloadPages(
    remaining,
    {
      config,
      client,
      outputDir,
      state,
      knownPagePaths,
      pagesWithChildren,
      titleIndex,
      rootPageIds,
      // Flush after every successful page so an interrupt is resumable.
      // `last_sync` stays at its previous value until the end of this run,
      // so on resume the same CQL diff is re-issued; pages already in state
      // are skipped via the version check.
      flushState: () => writeState(outputDir, state),
    },
    syncIso,
  );

  // Decide whether to run a full enumeration for delete reconciliation. Three triggers:
  //   - explicit refresh (opts.full)
  //   - first run (no prior last_sync)
  //   - daily cadence: last_full_enumeration is null or older than 24h
  //   - --force-full-enumeration on this invocation
  const lastFull = state.last_full_enumeration ? Date.parse(state.last_full_enumeration) : NaN;
  const daily = Number.isNaN(lastFull) || Date.now() - lastFull > FULL_ENUMERATION_INTERVAL_MS;
  const doFullEnumeration = opts.full || since === undefined || opts.forceFullEnumeration === true || daily;

  let deletedCount = 0;
  if (doFullEnumeration) {
    let allIds: Set<string>;
    if (opts.full || since === undefined) {
      // The incremental query already had no `lastmodified` clause in this case, so `seen` is full.
      allIds = new Set(seen.keys());
    } else {
      const fullSeen = new Set<string>();
      for (const watch of config.root_page_ids) {
        const cql = buildFullEnumerationCQL(watch);
        const results = await client.searchByCQL(cql, ['version']);
        for (const r of results) fullSeen.add(r.id);
      }
      allIds = fullSeen;
      log.info({ count: allIds.size }, `daily full page-list refresh done (${allIds.size} pages on Confluence)`);
    }

    const toDelete = Object.keys(state.pages).filter((id) => !allIds.has(id));
    deletedCount = toDelete.length;
    for (const id of toDelete) {
      const st = state.pages[id];
      if (!st) continue;
      const abs = resolve(outputDir, st.path);
      try {
        await rm(abs, { force: true });
        log.info({ id, path: st.path }, 'deleted orphan');
      } catch (err) {
        log.warn({ err, id }, 'orphan delete failed');
      }
      delete state.pages[id];
    }
    state.last_full_enumeration = syncIso;
  }

  // Only advance last_sync on a fully successful run. If any page failed,
  // keep last_sync where it was so the next CQL window still includes the
  // failed pages — their missing state.pages entries will pull them back
  // into remaining via the version diff. Successful pages have matching
  // versions in state and are skipped, so the cost is just re-running the
  // CQL search, not re-downloading completed pages.
  if (result.errors.length === 0) {
    state.last_sync = syncIso;
  } else {
    log.warn(
      { errors: result.errors.length, lastSyncFrozen: state.last_sync ?? '(none)' },
      `last_sync NOT advanced because ${result.errors.length} page(s) failed; they'll be retried on the next run`,
    );
  }
  state.total_pages_downloaded = Object.keys(state.pages).length;
  await writeState(outputDir, state);

  // Count how much of remaining landed successfully, split by new vs updated.
  const writtenSet = new Set(result.written);
  // result.written is relPaths, not ids. Cross-reference via state.pages.
  // Simpler: derive succeeded-by-id from state.pages updates within remaining.
  // After downloadPages, every page it successfully wrote was inserted into
  // state.pages with its new version. We compare against the per-id sets.
  // But remaining's "new" entries didn't exist before, so a successful write
  // is detectable by state.pages[id] being present. Updated entries already
  // existed but got their version bumped — also detectable.
  // We didn't capture the pre-fetch versions for `updated` though. Instead,
  // attribute by ids: successful = ids whose path now matches result.written,
  // and split by membership in newPageIds / updatedPageIds.
  const succeededIds = new Set<string>();
  for (const [id, st] of Object.entries(state.pages)) {
    if (writtenSet.has(st.path)) succeededIds.add(id);
  }
  const addedCount = [...newPageIds].filter((id) => succeededIds.has(id)).length;
  const updatedCount = [...updatedPageIds].filter((id) => succeededIds.has(id)).length;
  const totalChanges = addedCount + updatedCount + deletedCount;
  const isFirstSync = since === undefined;

  // Bucket errors by HTTP status so a sea of failures shows its shape.
  const errorSummary: Record<string, number> = {};
  for (const e of result.errors) {
    const msg = e.error instanceof Error ? e.error.message : String(e.error);
    const code = /\b(40\d|41\d|42\d|43\d|44\d|5\d\d)\b/.exec(msg)?.[1] ?? 'other';
    errorSummary[code] = (errorSummary[code] ?? 0) + 1;
  }

  // Out of `candidates` pages in the CQL window, `downloaded` were actually
  // fetched this run; the rest were skipped because state already had them
  // at the current version.
  const candidates = seen.size;
  const downloaded = result.written.length;
  const skipped = candidates - remaining.length;

  // Build a human-readable headline.
  let headline: string;
  if (isFirstSync) {
    headline = `initial sync complete — ${downloaded} of ${candidates} downloaded`;
  } else if (totalChanges === 0 && result.errors.length === 0) {
    headline = `no changes since your last run — 0 of ${candidates} downloaded (all ${skipped} already up to date)`;
  } else {
    const parts: string[] = [];
    if (addedCount > 0) parts.push(`${addedCount} new`);
    if (updatedCount > 0) parts.push(`${updatedCount} updated`);
    if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    const skippedNote = skipped > 0 ? `; ${skipped} skipped (already up to date)` : '';
    headline = `${totalChanges} change${totalChanges === 1 ? '' : 's'} since your last run${breakdown} — ${downloaded} of ${candidates} downloaded${skippedNote}`;
  }
  if (result.errors.length > 0) {
    const errParts = Object.entries(errorSummary).map(([k, v]) => `${k}=${v}`).join(', ');
    headline += `. ${result.errors.length} error${result.errors.length === 1 ? '' : 's'} (${errParts}) — re-run \`npm start\` to retry; successful pages are skipped.`;
  }

  log.info(
    {
      added: addedCount,
      updated: updatedCount,
      deleted: deletedCount,
      attachments: result.attachments.length,
      errors: result.errors.length,
      ...(result.errors.length > 0 ? { errorSummary } : {}),
    },
    headline,
  );

  // If the autotune ran this turn, restate its decision here — the per-level
  // and "bench winner" lines emitted at startup get pushed off the top of the
  // tail by all the per-page progress lines, so we replay the recap.
  if (lastBenchReport && lastBenchReport.length > 0) {
    const block = ['autotune ran this turn — recap:', ...lastBenchReport.map((l) => `  ${l}`)].join('\n');
    log.info(block);
    lastBenchReport = null;
  }
}

async function runBench(): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const firstScope = config.root_page_ids[0];
  if (!firstScope) {
    log.error('no root_page_ids configured; nothing to bench');
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(rootDir, 'config.yaml');
  if (!existsSync(configPath)) {
    log.error({ configPath }, 'config.yaml not found; copy config.example.yaml to config.yaml first');
    process.exitCode = 1;
    return;
  }

  const client = new ConfluenceClient({
    baseUrl: config.base_url,
    pat: config.pat,
  });

  // Collect a sample of page ids from the first root subtree. We stop after
  // BENCH_SAMPLE_SIZE so a 10k-page space costs one /search call, not the full sweep.
  const cql = buildFullEnumerationCQL(firstScope);
  const params = new URLSearchParams();
  params.set('cql', cql);
  params.set('limit', '100');
  params.set('expand', 'version');
  const searchPath = `/rest/api/content/search?${params.toString()}`;

  const sample: { id: string }[] = [];
  for await (const item of client.paginate<{ id: string }>(searchPath)) {
    sample.push(item);
    if (sample.length >= BENCH_SAMPLE_SIZE) break;
  }
  if (sample.length === 0) {
    log.error({ scope: firstScope }, 'no pages found under the first root_page_id; cannot bench');
    process.exitCode = 1;
    return;
  }
  log.info({ sampleSize: sample.length, levels: BENCH_CONCURRENCY_LEVELS }, 'bench starting');

  interface BenchRow {
    concurrency: number;
    elapsedMs: number;
    errors: number;
    throughputPerSec: number;
    firstError?: string;
  }
  const results: BenchRow[] = [];

  const errToString = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    try {
      return String(err);
    } catch {
      return '(unprintable error)';
    }
  };

  for (const c of BENCH_CONCURRENCY_LEVELS) {
    const limiter = pLimit(c);
    const start = Date.now();
    let errors = 0;
    let firstError: string | undefined;
    await Promise.all(
      sample.map((p) =>
        limiter(async () => {
          try {
            // Bypass the client's 429/503 retry — bench needs to see the
            // rate-limit cliff, not have it smoothed over.
            await client.getPage(p.id, undefined, { retry: false });
          } catch (err) {
            errors++;
            if (!firstError) firstError = errToString(err);
          }
        }),
      ),
    );
    const elapsedMs = Date.now() - start;
    const throughputPerSec = sample.length / (elapsedMs / 1000);
    const rounded = Number(throughputPerSec.toFixed(2));
    results.push({ concurrency: c, elapsedMs, errors, throughputPerSec: rounded, firstError });
    log.info(
      { concurrency: c, elapsedMs, errors, throughputPerSec: rounded, firstError },
      `bench level done — parallel_downloads = ${c} → ${rounded} pages/s` +
        (errors > 0 ? ` (${errors} error(s); first: ${firstError ?? '?'})` : ''),
    );
    if (errors > 0) {
      log.warn({ concurrency: c, errors, firstError }, 'errors at this level; stopping sweep');
      break;
    }
  }

  const candidates = results.filter((r) => r.errors === 0);
  if (candidates.length === 0) {
    const errored = results.find((r) => r.errors > 0);
    log.error(
      { results, firstError: errored?.firstError },
      `every concurrency level produced errors. First error seen: ${errored?.firstError ?? '(none captured)'}. ` +
        `Common causes: 403 = PAT lacks read access to one of the sample pages; ` +
        `429/503 = server is hard-throttling (try again later, or set parallel_downloads = 1 manually); ` +
        `4xx other = malformed request (bug, report it). Not writing config.`,
    );
    process.exitCode = 1;
    return;
  }
  const peak = candidates.reduce((a, b) => (b.throughputPerSec > a.throughputPerSec ? b : a));
  // Step TWO tiers down from the peak for headroom. Bench measures *burst*
  // tolerance on 30 pages; a full sync sustains the load over thousands of
  // pages, and the server's token bucket only drains under sustained
  // pressure. One tier proved too aggressive in practice (cascading 429
  // storms mid-sync); two tiers trades more throughput for much higher
  // reliability. Users who need speed can pin a higher value manually.
  const peakIdx = BENCH_CONCURRENCY_LEVELS.indexOf(peak.concurrency);
  const safeIdx = Math.max(0, peakIdx - 2);
  const safeLevel = BENCH_CONCURRENCY_LEVELS[safeIdx]!;
  const best = candidates.find((r) => r.concurrency === safeLevel) ?? peak;
  log.info(
    {
      peakConcurrency: peak.concurrency,
      peakThroughputPerSec: peak.throughputPerSec,
      chosenConcurrency: best.concurrency,
    },
    `bench: peak was parallel_downloads = ${peak.concurrency} (${peak.throughputPerSec} pages/s); ` +
      `picking ${best.concurrency} (two tiers down) for sustained-load headroom`,
  );

  // Flat YAML: find any existing parallel_downloads line (commented or not)
  // at column 0 and rewrite it. Append at end of file if there's no such line.
  const text = await readFile(configPath, 'utf8');
  const lineRe = /^#?[ \t]*parallel_downloads[ \t]*:[ \t]*\d+[^\n]*$/m;
  const newLine = `parallel_downloads: ${best.concurrency}`;

  const updated = lineRe.test(text)
    ? text.replace(lineRe, newLine)
    : `${text.replace(/\n+$/, '')}\n${newLine}\n`;

  await writeFile(configPath, updated, 'utf8');
  log.info(
    { configPath, value: best.concurrency },
    `wrote parallel_downloads: ${best.concurrency} to config.yaml`,
  );

  // Build a recap that runSync will print at the end of its run. It restates
  // the per-level results, the peak, the safety margin, and the chosen value
  // so the decision is right next to the sync summary, not buried at the top.
  lastBenchReport = [
    `sample size: ${BENCH_SAMPLE_SIZE} pages from root_page_id ${firstScope}`,
    ...results.map(
      (r) =>
        `  level ${r.concurrency.toString().padStart(2)}: ${r.throughputPerSec.toFixed(2)} pages/s` +
        (r.errors > 0 ? ` — ${r.errors} error(s)${r.firstError ? ` (first: ${r.firstError})` : ''}` : ''),
    ),
    `peak: parallel_downloads = ${peak.concurrency} (${peak.throughputPerSec} pages/s)`,
    `chose: parallel_downloads = ${best.concurrency} — two tiers down from peak as headroom for sustained load (bench measures bursts of ${BENCH_SAMPLE_SIZE} pages; full sync sustains the load over thousands)`,
    `wrote to config.yaml; pin a different value by hand if you want to override`,
  ];
}

async function runReconvert(): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const outputDir = resolve(rootDir, config.output_dir);
  const state = await readState(outputDir);

  if (Object.keys(state.pages).length === 0) {
    log.warn('state is empty; nothing to reconvert. Run `sync` or `refresh` first.');
    return;
  }

  // Build the resolver maps the converter needs — no network.
  const knownPagePaths = new Map<string, string>();
  const titleIndex = new Map<string, string>();
  for (const [id, p] of Object.entries(state.pages)) {
    knownPagePaths.set(id, p.path);
    if (p.space && p.title) titleIndex.set(titleIndexKey(p.space, p.title), id);
  }

  let processed = 0;
  let skipped = 0;
  for (const [id, p] of Object.entries(state.pages)) {
    const mdAbs = resolve(outputDir, p.path);
    const htmlAbs = htmlPathFor(mdAbs);
    let html: string;
    try {
      html = await readFile(htmlAbs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.warn({ id, path: htmlPathFor(p.path) }, 'no .html for page; skip (run sync to fetch)');
        skipped++;
        continue;
      }
      throw err;
    }
    const conversion = convertStorageFormat(
      html,
      buildConvertOptions({
        pageId: id,
        pagePath: p.path,
        pageSpace: p.space,
        baseUrl: config.base_url,
        state,
        knownPagePaths,
        titleIndex,
      }),
    );
    const sourceUrl = sourceUrlFor(config.base_url, id);
    const body = buildMarkdownBody(sourceUrl, p.title, conversion.markdown);
    await writeFile(mdAbs, body, 'utf8');
    processed++;
  }
  log.info({ processed, skipped }, 'reconvert complete');
}


function usage(): void {
  console.error('usage: npm start -- <sync|refresh|reconvert> [--force-full-enumeration]');
  console.error('default (no args): sync  (incremental — does the initial download on first run)');
  console.error('autotune runs automatically when parallel_downloads is unset in config.yaml.');
}

const [, , cmd, ...rest] = process.argv;
const forceFullEnumeration = rest.includes('--force-full-enumeration');

(async () => {
  switch (cmd ?? 'sync') {
    case 'sync':
      await runSync({ full: false, forceFullEnumeration });
      break;
    case 'refresh':
      await runSync({ full: true });
      break;
    case 'reconvert':
      await runReconvert();
      break;
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
})().catch((err) => {
  log.error({ err }, 'cli error');
  process.exitCode = 1;
});
