#!/usr/bin/env -S npx tsx
// Disable TLS cert verification + silence the resulting warning. Must import
// FIRST so it runs before any HTTPS connection is made.
import './disable-tls-check.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pLimit } from './limit.js';
import { loadConfig } from './config.js';
import { ConfluenceClient } from './confluence.js';
import { convertStorageFormat } from './converter.js';
import {
  buildConvertOptions,
  buildMarkdownBody,
  downloadPages,
  pickPageRelPath,
  titleIndexKey,
} from './downloader.js';
import { log } from './log.js';
import { htmlPathFor } from './pathing.js';
import {
  emptyState,
  findExistingIndexFile,
  indexFileName,
  readIndex,
  type StateFile,
  writeIndex,
} from './state.js';
import { buildCQL } from './walker.js';

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

// One root being synced. Each root has its own index file on disk.
interface RootContext {
  rootId: string;
  title: string;
  indexPath: string;
  state: StateFile;
}

async function resolveRoot(
  outputDir: string,
  rootId: string,
  client: ConfluenceClient,
  fresh: boolean,
): Promise<RootContext> {
  if (fresh) {
    // refresh wipes per-root state — fetch a current title so the filename is fresh.
    const page = await client.getPage(rootId, ['version']);
    const title = page.title;
    return {
      rootId,
      title,
      indexPath: join(outputDir, indexFileName(rootId, title)),
      state: emptyState(rootId, title),
    };
  }
  const existing = await findExistingIndexFile(outputDir, rootId);
  if (existing) {
    const state = await readIndex(existing, rootId, '(unknown)');
    return { rootId, title: state.root_title, indexPath: existing, state };
  }
  // No prior index for this root — fetch the title once so we can name the file.
  const page = await client.getPage(rootId, ['version']);
  const title = page.title;
  return {
    rootId,
    title,
    indexPath: join(outputDir, indexFileName(rootId, title)),
    state: emptyState(rootId, title),
  };
}

async function runSync(opts: { full: boolean; forceFullEnumeration?: boolean }): Promise<void> {
  await ensureTuned();
  const { config, rootDir } = await loadConfig();
  const outputDir = resolve(rootDir, config.output_dir);
  await mkdir(outputDir, { recursive: true });

  // Migration: warn once if we find the old one-file layout. The new per-root
  // indexes won't see it, so the user would otherwise wonder why their existing
  // state seems to have vanished.
  const oldStatePath = resolve(outputDir, '.state.json');
  if (existsSync(oldStatePath)) {
    log.warn(
      { oldStatePath },
      `found legacy .state.json from before per-root indexes — ignored. Run \`npm start -- refresh\` to rebuild as per-root index files, then delete .state.json.`,
    );
  }

  const client = new ConfluenceClient({
    baseUrl: config.base_url,
    pat: config.pat,
  });

  // Load (or initialise) one index per configured root.
  const roots: RootContext[] = [];
  for (const rootId of config.root_page_ids) {
    roots.push(await resolveRoot(outputDir, rootId, client, opts.full));
  }
  const totalLocal = roots.reduce((acc, r) => acc + Object.keys(r.state.pages).length, 0);
  log.info(
    {
      roots: roots.map((r) => ({
        id: r.rootId,
        title: r.title,
        pages: Object.keys(r.state.pages).length,
        last_sync: r.state.last_sync,
      })),
    },
    `loaded ${roots.length} root index file(s) — ${totalLocal} pages already on disk`,
  );

  // Configured root ids — used by pickPageRelPath to trim ancestor folders
  // above the root so the on-disk tree starts where the user said to.
  const rootPageIds = new Set(config.root_page_ids);

  // Maps shared across all roots so cross-root ac:link references resolve
  // to a local path. Seed from existing state on every root, then per-root
  // sync overlays this run's data.
  const knownPagePaths = new Map<string, string>();
  const titleIndex = new Map<string, string>();
  for (const r of roots) {
    for (const [id, st] of Object.entries(r.state.pages)) {
      knownPagePaths.set(id, st.path);
      if (st.space && st.title) titleIndex.set(titleIndexKey(st.space, st.title), id);
    }
  }

  // Per-root sync, accumulating numbers for the cross-root summary at the end.
  const syncIso = new Date().toISOString();
  let allAdded = 0;
  let allUpdated = 0;
  let allDeleted = 0;
  let allDownloaded = 0;
  let allCandidates = 0;
  let allSkipped = 0;
  let allAttachments = 0;
  let allErrors = 0;
  const allErrorSummary: Record<string, number> = {};

  for (const root of roots) {
    const since = opts.full ? undefined : root.state.last_sync ?? undefined;
    const cql = buildCQL(root.rootId, since);
    log.info({ rootId: root.rootId, title: root.title, cql }, `syncing root "${root.title}" (${root.rootId})`);

    const results = await client.searchByCQL(cql, ['version', 'space', 'ancestors']);
    const seen = new Map<string, (typeof results)[number]>();
    for (const r of results) seen.set(r.id, r);

    const pagesWithChildren = new Set<string>();
    for (const page of seen.values()) for (const a of page.ancestors ?? []) pagesWithChildren.add(a.id);

    for (const page of seen.values()) {
      knownPagePaths.set(page.id, pickPageRelPath(page, pagesWithChildren, rootPageIds));
      const sp = page.space?.key;
      if (sp) titleIndex.set(titleIndexKey(sp, page.title), page.id);
    }

    const remaining = [...seen.values()].filter((p) => {
      const prev = root.state.pages[p.id];
      return !prev || prev.version !== (p.version?.number ?? 0);
    });
    const newPageIds = new Set(remaining.filter((p) => !root.state.pages[p.id]).map((p) => p.id));
    const updatedPageIds = new Set(remaining.filter((p) => root.state.pages[p.id]).map((p) => p.id));

    root.state.total_watched_pages_on_remote = seen.size;
    root.state.total_pages_downloaded = Object.keys(root.state.pages).length;
    log.info(
      { rootId: root.rootId, candidates: seen.size, remaining: remaining.length, new: newPageIds.size, updated: updatedPageIds.size },
      `${root.title}: ${seen.size} pages on remote; ${remaining.length} need fetching`,
    );

    const result = await downloadPages(
      remaining,
      {
        config,
        client,
        outputDir,
        state: root.state,
        knownPagePaths,
        pagesWithChildren,
        titleIndex,
        rootPageIds,
        flushState: () => writeIndex(root.indexPath, root.state),
      },
      syncIso,
    );

    // Delete reconciliation (per root)
    const lastFull = root.state.last_full_enumeration ? Date.parse(root.state.last_full_enumeration) : NaN;
    const daily = Number.isNaN(lastFull) || Date.now() - lastFull > FULL_ENUMERATION_INTERVAL_MS;
    const doFullEnumeration = opts.full || since === undefined || opts.forceFullEnumeration === true || daily;

    let deletedCount = 0;
    if (doFullEnumeration) {
      let allIds: Set<string>;
      if (opts.full || since === undefined) {
        allIds = new Set(seen.keys());
      } else {
        const fullSeen = new Set<string>();
        const fullCql = buildCQL(root.rootId);
        const fullResults = await client.searchByCQL(fullCql, ['version']);
        for (const r of fullResults) fullSeen.add(r.id);
        allIds = fullSeen;
        log.info({ rootId: root.rootId, count: allIds.size }, `${root.title}: daily full page-list refresh done (${allIds.size} on remote)`);
      }
      const toDelete = Object.keys(root.state.pages).filter((id) => !allIds.has(id));
      deletedCount = toDelete.length;
      for (const id of toDelete) {
        const st = root.state.pages[id];
        if (!st) continue;
        // Remove both .md and the .html companion. A page deleted or archived
        // in Confluence no longer appears in CQL results, so it falls into
        // toDelete here — both on-disk files go.
        const mdAbs = resolve(outputDir, st.path);
        const htmlAbs = htmlPathFor(mdAbs);
        try {
          await rm(mdAbs, { force: true });
          await rm(htmlAbs, { force: true });
          log.info({ rootId: root.rootId, id, path: st.path, title: st.title }, `removed deleted/archived page: ${st.title} (${id})`);
        } catch (err) {
          log.warn({ rootId: root.rootId, err, id }, 'orphan delete failed');
        }
        delete root.state.pages[id];
      }
      root.state.last_full_enumeration = syncIso;
    }

    if (result.errors.length === 0) {
      root.state.last_sync = syncIso;
    } else {
      log.warn(
        { rootId: root.rootId, errors: result.errors.length, lastSyncFrozen: root.state.last_sync ?? '(none)' },
        `${root.title}: last_sync NOT advanced because ${result.errors.length} page(s) failed; they'll be retried next run`,
      );
    }
    root.state.total_pages_downloaded = Object.keys(root.state.pages).length;
    await writeIndex(root.indexPath, root.state);

    // Per-root attribution + accumulate into totals.
    const writtenSet = new Set(result.written);
    const succeededIds = new Set<string>();
    for (const [id, st] of Object.entries(root.state.pages)) {
      if (writtenSet.has(st.path)) succeededIds.add(id);
    }
    const addedCount = [...newPageIds].filter((id) => succeededIds.has(id)).length;
    const updatedCount = [...updatedPageIds].filter((id) => succeededIds.has(id)).length;

    for (const e of result.errors) {
      const msg = e.error instanceof Error ? e.error.message : String(e.error);
      const code = /\b(40\d|41\d|42\d|43\d|44\d|5\d\d)\b/.exec(msg)?.[1] ?? 'other';
      allErrorSummary[code] = (allErrorSummary[code] ?? 0) + 1;
    }

    allCandidates += seen.size;
    allSkipped += seen.size - remaining.length;
    allDownloaded += result.written.length;
    allAttachments += result.attachments.length;
    allErrors += result.errors.length;
    allAdded += addedCount;
    allUpdated += updatedCount;
    allDeleted += deletedCount;
  }

  // Aggregate headline across all roots.
  const totalChanges = allAdded + allUpdated + allDeleted;
  const parts: string[] = [];
  if (allAdded > 0) parts.push(`${allAdded} new`);
  if (allUpdated > 0) parts.push(`${allUpdated} updated`);
  if (allDeleted > 0) parts.push(`${allDeleted} deleted`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const skippedNote = allSkipped > 0 ? `; ${allSkipped} skipped (already up to date)` : '';

  let headline: string;
  if (totalChanges === 0 && allErrors === 0) {
    headline = `no changes across ${roots.length} root(s) — 0 of ${allCandidates} downloaded (all ${allSkipped} already up to date)`;
  } else {
    headline = `${totalChanges} change${totalChanges === 1 ? '' : 's'} across ${roots.length} root(s)${breakdown} — ${allDownloaded} of ${allCandidates} downloaded${skippedNote}`;
  }
  if (allErrors > 0) {
    const errParts = Object.entries(allErrorSummary).map(([k, v]) => `${k}=${v}`).join(', ');
    headline += `. ${allErrors} error${allErrors === 1 ? '' : 's'} (${errParts}) — re-run \`npm start\` to retry.`;
  }

  log.info(
    {
      added: allAdded,
      updated: allUpdated,
      deleted: allDeleted,
      attachments: allAttachments,
      errors: allErrors,
      ...(allErrors > 0 ? { errorSummary: allErrorSummary } : {}),
    },
    headline,
  );

  // Bench recap if autotune ran this turn.
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
  const cql = buildCQL(firstScope);
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

  // Load every per-root index, merging into one big map for the resolver.
  // We don't need a client here — reconvert is network-free, working entirely
  // from the saved .html files on disk plus the resolver maps in state.
  const mergedPages: StateFile['pages'] = {};
  const mergedKnown = new Map<string, string>();
  const mergedTitle = new Map<string, string>();
  for (const rootId of config.root_page_ids) {
    const existing = await findExistingIndexFile(outputDir, rootId);
    if (!existing) continue;
    const state = await readIndex(existing, rootId, '(unknown)');
    Object.assign(mergedPages, state.pages);
    for (const [id, p] of Object.entries(state.pages)) {
      mergedKnown.set(id, p.path);
      if (p.space && p.title) mergedTitle.set(titleIndexKey(p.space, p.title), id);
    }
  }

  const allPages = Object.entries(mergedPages);
  if (allPages.length === 0) {
    log.warn('no index files found; nothing to reconvert. Run `sync` or `refresh` first.');
    return;
  }

  // Build a stub state for buildConvertOptions (only state.pages is read).
  const stubState = { ...emptyState('', ''), pages: mergedPages };

  let processed = 0;
  let skipped = 0;
  for (const [id, p] of allPages) {
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
        state: stubState,
        knownPagePaths: mergedKnown,
        titleIndex: mergedTitle,
      }),
    );
    const body = buildMarkdownBody(
      {
        title: p.title,
        version: p.version,
        last_modified: p.last_modified,
        last_modified_by: p.last_modified_by,
        webui_url: p.webui_url,
      },
      conversion.markdown,
    );
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
