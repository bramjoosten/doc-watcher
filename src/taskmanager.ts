#!/usr/bin/env -S npx tsx
// Disable TLS cert verification + silence the resulting warning. Must import
// FIRST so it runs before any HTTPS connection is made.
import './disable-tls-check.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AdaptiveLimiter } from './adaptive-limiter.js';
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
import { htmlPathFor, pruneEmptyParents } from './pathing.js';
import { enumerateSubtree, enumerateViaCQL } from './walker.js';
import {
  appendIndexEntry,
  buildTree,
  emptyState,
  finalizeIndex,
  findExistingIndexFile,
  indexFileName,
  jsonlPathFromIndexPath,
  readIndex,
  type StateFile,
  treePathFromIndexPath,
  writeTree,
} from './state.js';

// Default cap when the user hasn't set parallel_downloads in config.yaml.
// The adaptive limiter starts at 1 anyway and ramps based on observed
// X-RateLimit-* headers, so this is just an upper ceiling, not a target.
const DEFAULT_PARALLEL_DOWNLOADS = 20;

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

async function runSync(opts: { full: boolean; walkDb: boolean }): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const outputDir = resolve(rootDir, config.output_dir);
  await mkdir(outputDir, { recursive: true });

  // Migration: warn once if we find the old one-file layout. The new per-root
  // indexes won't see it, so the user would otherwise wonder why their existing
  // state seems to have vanished.
  const oldStatePath = resolve(outputDir, '.state.json');
  if (existsSync(oldStatePath)) {
    log.warn(
      `found legacy .state.json at ${oldStatePath} from before per-root indexes — ignored. Run \`npm start -- refresh\` to rebuild as per-root index files, then delete .state.json.`,
    );
  }

  // Cap from config (or a flat default). Adaptive limiter starts at 1
  // (slow-start), doubles every 50 successes up to this cap, halves on every
  // 429, honours Retry-After, and paces from X-RateLimit-* headers when the
  // server's budget gets low.
  const parallelCap = config.parallel_downloads ?? DEFAULT_PARALLEL_DOWNLOADS;
  const adaptiveLimiter = new AdaptiveLimiter({ max: parallelCap, slowStart: true });
  log.info(`adaptive concurrency: starting at ${adaptiveLimiter.currentCapacity}, ramping toward ${parallelCap} on sustained success`);

  const client = new ConfluenceClient({
    baseUrl: config.base_url,
    pat: config.pat,
    rateLimitObserver: adaptiveLimiter,
  });

  // Load (or initialise) one index per configured root.
  const roots: RootContext[] = [];
  for (const rootId of config.root_page_ids) {
    roots.push(await resolveRoot(outputDir, rootId, client, opts.full));
  }
  const totalLocal = roots.reduce((acc, r) => acc + Object.keys(r.state.pages).length, 0);
  const rootSummary = roots
    .map((r) => `"${r.title}" (${r.rootId}, ${Object.keys(r.state.pages).length} pages, last_sync=${r.state.last_sync ?? 'never'})`)
    .join('; ');
  log.info(`loaded ${roots.length} root index file(s) — ${totalLocal} pages already on disk: ${rootSummary}`);

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
    log.info(`syncing root "${root.title}" (${root.rootId}) via ${opts.walkDb ? 'DB walk (slow, immediate)' : 'CQL/Lucene (fast, ~1h lag on new pages)'}`);

    // Two enumeration strategies. Default is CQL: one paginated call per root,
    // routes through Lucene, so brand-new pages may be invisible for an hour
    // (existing-page edits show up instantly because they trigger a per-page
    // reindex). The `--walkdb` flag opts in to a recursive /child/page walk
    // that hits the DB directly and sees new pages immediately, at the cost
    // of more API calls.
    const { pages: results, pagesWithChildren } = opts.walkDb
      ? await enumerateSubtree(root.rootId, client, adaptiveLimiter)
      : await enumerateViaCQL(root.rootId, client);
    const seen = new Map<string, (typeof results)[number]>();
    for (const r of results) seen.set(r.id, r);

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
    log.info(`${root.title}: ${seen.size} pages on remote; ${remaining.length} need fetching (${newPageIds.size} new, ${updatedPageIds.size} updated)`);

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
        limiter: adaptiveLimiter,
        // Cheap per-page persistence: append one line to the sibling .jsonl
        // instead of re-serialising the whole .json. The .json is rewritten
        // (and the .jsonl deleted) at finalizeIndex below.
        flushState: (id: string) =>
          appendIndexEntry(jsonlPathFromIndexPath(root.indexPath), id, root.state.pages[id]!),
      },
      syncIso,
    );

    // Delete reconciliation. Every sync enumerates the full subtree (we no
    // longer narrow by lastmodified), so anything in state but not in `seen`
    // has been deleted, archived, or moved out of scope on Confluence.
    const allIds = new Set(seen.keys());
    const toDelete = Object.keys(root.state.pages).filter((id) => !allIds.has(id));
    const deletedCount = toDelete.length;
    for (const id of toDelete) {
      const st = root.state.pages[id];
      if (!st) continue;
      const mdAbs = resolve(outputDir, st.path);
      const htmlAbs = htmlPathFor(mdAbs);
      try {
        await rm(mdAbs, { force: true });
        await rm(htmlAbs, { force: true });
        // Collapse any now-empty parent folders. If this page was a parent
        // (`<slug>--<id>/_index.md`) and its children were also deleted in
        // this sync, the whole branch collapses cleanly instead of leaving
        // a chain of empty directories.
        await pruneEmptyParents(mdAbs, outputDir);
        log.info(`removed deleted/archived page: ${st.title} (${id}) at ${st.path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`orphan delete failed for ${id} (root ${root.rootId}): ${msg}`);
      }
      delete root.state.pages[id];
    }

    if (result.errors.length === 0) {
      root.state.last_sync = syncIso;
    } else {
      log.warn(`${root.title}: last_sync NOT advanced (frozen at ${root.state.last_sync ?? 'never'}) because ${result.errors.length} page(s) failed; they'll be retried next run`);
    }
    root.state.total_pages_downloaded = Object.keys(root.state.pages).length;
    // Collapse the per-page .jsonl into a fresh .json snapshot and delete
    // the .jsonl. Interrupted runs leave the .jsonl around for next-run
    // recovery; finalize wipes it because the .json now has everything.
    await finalizeIndex(root.indexPath, root.state);
    // Write the per-root tree.json for human navigation via IDE folding.
    const indexBaseName = root.indexPath.split('/').pop() ?? 'index.json';
    const tree = buildTree(root.state, indexBaseName);
    if (tree) await writeTree(treePathFromIndexPath(root.indexPath), tree);

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

  log.info(headline);

  if (!opts.walkDb) {
    log.info(`re-run this command after ~1 hour to get newly created pages, or run \`npm start -- --walkdb\` to ignore Confluence's index — this might take a bit longer.`);
  }

  // Throttle stats — "of N HTTP requests, M had to back off." Useful to gauge
  // whether parallel_downloads is set too high for the server.
  const total = client.totalRequests;
  const recovered = client.requestsRecoveredAfterBackoff;
  const failedAfterRetries = client.requestsFailedAfterRetries;
  if (recovered > 0 || failedAfterRetries > 0) {
    const pct = total > 0 ? Math.round((recovered / total) * 100) : 0;
    const failedNote = failedAfterRetries > 0 ? `; ${failedAfterRetries} gave up after the retry budget` : '';
    log.info(`throttle: ${recovered} of ${total} requests (${pct}%) had to back off and retry${failedNote}`);
  }

  // Adaptive limiter — where did it end up?
  log.info(`adaptive concurrency settled at ${adaptiveLimiter.currentCapacity} of ${adaptiveLimiter.maxCapacity} max`);

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
        log.warn(`no .html for page ${id} at ${htmlPathFor(p.path)}; skip (run sync to fetch)`);
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
  log.info(`reconvert complete: ${processed} processed, ${skipped} skipped`);
}


function usage(): void {
  console.error('usage: npm start -- <sync|refresh|reconvert> [--walkdb]');
  console.error('default (no args): sync — enumerate the full subtree via CQL/Lucene, fetch only pages whose version changed.');
  console.error('--walkdb: bypass Confluence\'s Lucene index and enumerate directly from the DB via /child/page.');
  console.error('         Slower (one API call per parent page) but sees newly-created pages immediately.');
}

const [, , maybeCmd, ...rest] = process.argv;
// `cmd` is the first non-flag arg; defaults to `sync`. `--walkdb` is a flag,
// allowed alongside any verb (so `npm start -- --walkdb` and
// `npm start -- refresh --walkdb` both work).
const cmd = maybeCmd && !maybeCmd.startsWith('--') ? maybeCmd : 'sync';
const flags = [maybeCmd, ...rest].filter((a): a is string => typeof a === 'string' && a.startsWith('--'));
const walkDb = flags.includes('--walkdb');

(async () => {
  switch (cmd) {
    case 'sync':
      await runSync({ full: false, walkDb });
      break;
    case 'refresh':
      await runSync({ full: true, walkDb });
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
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error(`cli error: ${msg}`);
  process.exitCode = 1;
});
