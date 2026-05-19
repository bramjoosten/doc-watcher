#!/usr/bin/env -S npx tsx
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig, type WatchEntry } from './config.js';
import { ConfluenceClient } from './confluence.js';
import { downloadPages, pickPageRelPath, titleIndexKey } from './downloader.js';
import { log } from './log.js';
import { emptyState, readState, writeState } from './state.js';
import { planScopes } from './walker.js';

const FULL_ENUMERATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

function buildFullEnumerationCQL(watch: WatchEntry): string {
  if (watch.type === 'space') return `space = "${watch.key}" AND type = page`;
  return `(id = ${watch.root_page_id} OR ancestor = ${watch.root_page_id}) AND type = page`;
}

async function runSync(opts: { full: boolean; forceFullEnumeration?: boolean }): Promise<void> {
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
  // Cost note: for ~10k pages this is ~100 paginated requests with id+version-only
  // expansion (no body, no ancestors), roughly 10-30s of API time once per day.
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
  void dirname;
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

const program = new Command();
program.name('doc-watcher').description('Mirror a Confluence Server tree to local markdown.').version('0.1.0');

program.command('init').description('Scaffold config.toml, .env, and working directories.').action(async () => {
  await runInit();
});

program
  .command('sync')
  .description('Incremental sync (delta from last_sync).')
  .option('--force-full-enumeration', 'Force a full id enumeration this run regardless of last_full_enumeration timestamp.')
  .action(async (cmdOpts: { forceFullEnumeration?: boolean }) => {
    await runSync({ full: false, forceFullEnumeration: cmdOpts.forceFullEnumeration === true });
  });

program.command('refresh').description('Full re-download; ignores state and reconciles deletes.').action(async () => {
  await runSync({ full: true });
});

program.command('poll').description('Loop sync forever at poll_interval_seconds.').action(async () => {
  await runPoll();
});

program.parseAsync(process.argv).catch((err) => {
  log.error({ err }, 'cli error');
  process.exitCode = 1;
});
