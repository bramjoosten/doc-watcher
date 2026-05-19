#!/usr/bin/env -S npx tsx
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  if (watch.type === 'space') return `space = "${watch.key}" AND type = page`;
  return `(id = ${watch.root_page_id} OR ancestor = ${watch.root_page_id}) AND type = page`;
}

async function ensureTuned(): Promise<void> {
  const { config } = await loadConfig();
  if (config.sync.parallel_downloads && config.sync.parallel_downloads > 0) return;
  log.info('parallel_downloads not set in config.toml — running autotune (one-time)');
  try {
    await runBench();
  } catch (err) {
    log.warn({ err }, 'autotune failed; sync will fall back to a heuristic this run');
  }
}

async function runSync(opts: { full: boolean; forceFullEnumeration?: boolean }): Promise<void> {
  await ensureTuned();
  const { config, pat, rootDir } = await loadConfig();
  const stateDir = resolve(rootDir, config.paths.state_dir);
  const outputDir = resolve(rootDir, config.paths.output_dir);
  await mkdir(outputDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const state = opts.full ? emptyState() : await readState(stateDir);
  const client = new ConfluenceClient({
    baseUrl: config.confluence.base_url,
    pat,
    verifyTls: config.confluence.verify_tls,
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

  log.info({ candidates: seen.size, toFetch: toFetch.length }, 'sync diff');

  const syncIso = new Date().toISOString();
  const result = await downloadPages(
    toFetch,
    { config, client, outputDir, state, knownPagePaths, pagesWithChildren, titleIndex },
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

  state.last_sync = syncIso;
  await writeState(stateDir, state);
  log.info(
    { written: result.written.length, attachments: result.attachments.length, errors: result.errors.length },
    'sync complete',
  );
}

async function runInit(): Promise<void> {
  const cwd = process.cwd();
  const configSrc = resolve(cwd, 'config.example.toml');
  const configDst = resolve(cwd, 'config.toml');
  const envDst = resolve(cwd, '.env');
  if (!existsSync(configSrc)) {
    log.error({ configSrc }, 'config.example.toml not found in cwd; run from project root');
    process.exitCode = 1;
    return;
  }
  if (existsSync(configDst)) {
    log.info({ configDst }, 'config.toml already exists; leaving as-is');
  } else {
    await copyFile(configSrc, configDst);
    log.info({ configDst }, 'created config.toml');
  }
  if (!existsSync(envDst)) {
    await writeFile(envDst, 'CONFLUENCE_PAT=\nCONFLUENCE_BASE_URL=\n', 'utf8');
    log.info({ envDst }, 'created .env');
  }
  for (const dir of ['docs', '.state', '.cache']) {
    await mkdir(resolve(cwd, dir), { recursive: true });
  }
  log.info('init complete; fill in .env and edit config.toml, then run sync');
}

async function runBench(): Promise<void> {
  const { config, pat, rootDir } = await loadConfig();
  const firstScope = config.watch[0];
  if (!firstScope) {
    log.error('no [[watch]] scopes configured; nothing to bench');
    process.exitCode = 1;
    return;
  }

  const configPath = resolve(rootDir, 'config.toml');
  if (!existsSync(configPath)) {
    log.error({ configPath }, 'config.toml not found; run `init` first');
    process.exitCode = 1;
    return;
  }

  const client = new ConfluenceClient({
    baseUrl: config.confluence.base_url,
    pat,
    verifyTls: config.confluence.verify_tls,
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
  }
  const results: BenchRow[] = [];

  for (const c of BENCH_CONCURRENCY_LEVELS) {
    const limiter = pLimit(c);
    const start = Date.now();
    let errors = 0;
    await Promise.all(
      sample.map((p) =>
        limiter(async () => {
          try {
            // Bypass the client's 429/503 retry — bench needs to see the
            // rate-limit cliff, not have it smoothed over.
            await client.getPage(p.id, undefined, { retry: false });
          } catch {
            errors++;
          }
        }),
      ),
    );
    const elapsedMs = Date.now() - start;
    const throughputPerSec = sample.length / (elapsedMs / 1000);
    results.push({ concurrency: c, elapsedMs, errors, throughputPerSec: Number(throughputPerSec.toFixed(2)) });
    log.info({ concurrency: c, elapsedMs, errors, throughputPerSec: throughputPerSec.toFixed(2) }, 'bench level done');
    if (errors > 0) {
      log.warn({ concurrency: c, errors }, 'errors at this level; stopping sweep');
      break;
    }
  }

  const candidates = results.filter((r) => r.errors === 0);
  if (candidates.length === 0) {
    log.error('every concurrency level produced errors; not writing config');
    process.exitCode = 1;
    return;
  }
  const best = candidates.reduce((a, b) => (b.throughputPerSec > a.throughputPerSec ? b : a));
  log.info({ best: best.concurrency, throughputPerSec: best.throughputPerSec }, 'bench winner');

  const text = await readFile(configPath, 'utf8');
  if (/^\s*parallel_downloads\s*=\s*\d+/m.test(text)) {
    const updated = text.replace(/^(\s*parallel_downloads\s*=\s*)\d+/m, `$1${best.concurrency}`);
    await writeFile(configPath, updated, 'utf8');
    log.info({ configPath, value: best.concurrency }, 'wrote parallel_downloads to config.toml');
  } else {
    log.warn({ value: best.concurrency }, 'config.toml has no parallel_downloads line under [sync]; add it manually to persist');
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

async function runPoll(): Promise<void> {
  const { config } = await loadConfig();
  const intervalMs = config.sync.poll_interval_seconds * 1000;
  log.info({ intervalSec: config.sync.poll_interval_seconds }, 'poll daemon starting');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ full: false });
    } catch (err) {
      log.error({ err }, 'sync iteration failed');
    }
    await new Promise<void>((res) => setTimeout(res, intervalMs));
  }
}

function usage(): void {
  console.error('usage: npm start -- <init|sync|refresh|reconvert|bench|poll> [--force-full-enumeration]');
  console.error('default (no args): sync  (incremental — does the initial download on first run)');
}

const [, , cmd, ...rest] = process.argv;
const forceFullEnumeration = rest.includes('--force-full-enumeration');

(async () => {
  switch (cmd ?? 'sync') {
    case 'init':
      await runInit();
      break;
    case 'sync':
      await runSync({ full: false, forceFullEnumeration });
      break;
    case 'refresh':
      await runSync({ full: true });
      break;
    case 'reconvert':
      await runReconvert();
      break;
    case 'bench':
      await runBench();
      break;
    case 'poll':
      await runPoll();
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
