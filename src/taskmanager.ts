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
const BENCH_CONCURRENCY_LEVELS = [1, 2, 5, 10, 20, 50];

const FULL_ENUMERATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

function buildFullEnumerationCQL(watch: WatchEntry): string {
  return `(id = ${watch.root_page_id} OR ancestor = ${watch.root_page_id}) AND type = page`;
}

async function ensureTuned(): Promise<void> {
  const { config } = await loadConfig();
  if (config.sync.parallel_downloads && config.sync.parallel_downloads > 0) {
    log.info(
      { parallel_downloads: config.sync.parallel_downloads },
      `using configured parallel_downloads = ${config.sync.parallel_downloads}; skipping autotune`,
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
  const stateDir = resolve(rootDir, config.paths.state_dir);
  const outputDir = resolve(rootDir, config.paths.output_dir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const state = opts.full ? emptyState() : await readState(stateDir);
  const localCount = Object.keys(state.pages).length;
  log.info(
    { localCount, lastSync: state.last_sync ?? '(none)', full: opts.full },
    `state loaded — ${localCount} pages already on disk; last_sync=${state.last_sync ?? '(none)'}`,
  );

  const client = new ConfluenceClient({
    baseUrl: config.confluence.base_url,
    pat: config.confluence.pat,
  });

  const since = opts.full ? undefined : state.last_sync ?? undefined;
  const scopes = planScopes(config.watch, since);
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

  const knownPagePaths = new Map<string, string>();
  for (const [id, st] of Object.entries(state.pages)) knownPagePaths.set(id, st.path);
  for (const page of seen.values()) {
    knownPagePaths.set(page.id, pickPageRelPath(page, pagesWithChildren));
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

  const toFetch = [...seen.values()].filter((p) => {
    const prev = state.pages[p.id];
    return !prev || prev.version !== (p.version?.number ?? 0);
  });

  // Split the work into new vs. updated for the post-sync summary.
  const newPageIds = new Set(toFetch.filter((p) => !state.pages[p.id]).map((p) => p.id));
  const updatedPageIds = new Set(toFetch.filter((p) => state.pages[p.id]).map((p) => p.id));

  log.info(
    { candidates: seen.size, toFetch: toFetch.length, new: newPageIds.size, updated: updatedPageIds.size },
    'sync diff',
  );

  const syncIso = new Date().toISOString();
  const result = await downloadPages(
    toFetch,
    {
      config,
      client,
      outputDir,
      state,
      knownPagePaths,
      pagesWithChildren,
      titleIndex,
      // Flush after every successful page so an interrupt is resumable.
      // `last_sync` stays at its previous value until the end of this run,
      // so on resume the same CQL diff is re-issued; pages already in state
      // are skipped via the version check.
      flushState: () => writeState(stateDir, state),
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
      for (const watch of config.watch) {
        const cql = buildFullEnumerationCQL(watch);
        const results = await client.searchByCQL(cql, ['version']);
        for (const r of results) fullSeen.add(r.id);
      }
      allIds = fullSeen;
      log.info({ count: allIds.size }, 'full enumeration complete');
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
  // into toFetch via the version diff. Successful pages have matching
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
  await writeState(stateDir, state);

  // Count how much of toFetch landed successfully, split by new vs updated.
  const writtenSet = new Set(result.written);
  // result.written is relPaths, not ids. Cross-reference via state.pages.
  // Simpler: derive succeeded-by-id from state.pages updates within toFetch.
  // After downloadPages, every page it successfully wrote was inserted into
  // state.pages with its new version. We compare against the per-id sets.
  // But toFetch's "new" entries didn't exist before, so a successful write
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

  // Build a human-readable headline.
  let headline: string;
  if (isFirstSync) {
    headline = `initial sync complete — ${addedCount} page${addedCount === 1 ? '' : 's'} downloaded`;
  } else if (totalChanges === 0 && result.errors.length === 0) {
    headline = 'no changes since your last run';
  } else {
    const parts: string[] = [];
    if (addedCount > 0) parts.push(`${addedCount} new`);
    if (updatedCount > 0) parts.push(`${updatedCount} updated`);
    if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
    const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    headline = `${totalChanges} change${totalChanges === 1 ? '' : 's'} since your last run${breakdown}`;
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
}

async function runBench(): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const firstScope = config.watch[0];
  if (!firstScope) {
    log.error('no [[watch]] scopes configured; nothing to bench');
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
    baseUrl: config.confluence.base_url,
    pat: config.confluence.pat,
  });

  // Collect a sample of page ids from the first watch scope. We stop after
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
    log.error({ scope: firstScope }, 'no pages found in the first watch scope; cannot bench');
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
  // Step one tier down from the peak for headroom. Bench measures *burst*
  // tolerance on 30 pages; a full sync sustains the load over thousands of
  // pages, and the server's token bucket only drains under sustained
  // pressure. Picking the next tier down trades a slice of peak throughput
  // for a much lower chance of cascading 429s mid-run.
  const peakIdx = BENCH_CONCURRENCY_LEVELS.indexOf(peak.concurrency);
  const safeIdx = Math.max(0, peakIdx - 1);
  const safeLevel = BENCH_CONCURRENCY_LEVELS[safeIdx]!;
  const best = candidates.find((r) => r.concurrency === safeLevel) ?? peak;
  log.info(
    {
      peakConcurrency: peak.concurrency,
      peakThroughputPerSec: peak.throughputPerSec,
      chosenConcurrency: best.concurrency,
    },
    `bench: peak was parallel_downloads = ${peak.concurrency} (${peak.throughputPerSec} pages/s); ` +
      `picking ${best.concurrency} one tier down for sustained-load headroom`,
  );

  // Match any existing line — commented or not — preserving leading indentation
  // (YAML cares). Falls back to inserting under the `sync:` key.
  const text = await readFile(configPath, 'utf8');
  const lineRe = /^([ \t]*)#?[ \t]*parallel_downloads[ \t]*:[ \t]*\d+[^\n]*$/m;
  const syncHeaderRe = /^sync:[ \t]*$/m;

  let updated: string | null = null;
  const lineMatch = text.match(lineRe);
  if (lineMatch) {
    const indent = lineMatch[1] ?? '  ';
    updated = text.replace(lineRe, `${indent}parallel_downloads: ${best.concurrency}`);
  } else if (syncHeaderRe.test(text)) {
    updated = text.replace(syncHeaderRe, `sync:\n  parallel_downloads: ${best.concurrency}`);
  }

  if (updated !== null) {
    await writeFile(configPath, updated, 'utf8');
    log.info(
      { configPath, value: best.concurrency },
      `wrote parallel_downloads: ${best.concurrency} to config.yaml`,
    );
  } else {
    log.warn(
      { value: best.concurrency },
      `config.yaml has no sync: section; add it manually:\nsync:\n  parallel_downloads: ${best.concurrency}`,
    );
  }
}

async function runReconvert(): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const stateDir = resolve(rootDir, config.paths.state_dir);
  const outputDir = resolve(rootDir, config.paths.output_dir);
  const state = await readState(stateDir);

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
        baseUrl: config.confluence.base_url,
        state,
        knownPagePaths,
        titleIndex,
      }),
    );
    const sourceUrl = sourceUrlFor(config.confluence.base_url, id);
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
