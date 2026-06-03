#!/usr/bin/env node
// Disable TLS cert verification + silence the resulting warning. Must import
// FIRST so it runs before any HTTPS connection is made.
import './disable-tls-check.ts';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AdaptiveLimiter } from './adaptive-limiter.ts';
import { loadConfig } from './config.ts';
import { ConfluenceClient, type ConfluencePage } from './confluence.ts';
import { convertStorageFormat } from './converter.ts';
import {
  buildCommentsSection,
  buildConvertOptions,
  buildMarkdownBody,
  commentsChanged,
  downloadPages,
  pickPageRelPath,
  titleIndexKey,
} from './downloader.ts';
import { log } from './log.ts';
import { htmlPathFor, pruneEmptyParents } from './pathing.ts';
import { resolveRoots } from './url-resolver.ts';
import { enumerateSubtree, enumerateViaCQL } from './walker.ts';
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
} from './state.ts';

// Upper ceiling on parallel page fetches. The adaptive limiter starts at 1
// (slow-start), doubles every 50 successes up to this cap, halves on every
// 429, honours Retry-After, and paces from Confluence's X-RateLimit-* headers
// when the bucket gets low. So this is just the "no higher than" guard rail
// — the limiter does the rest, and 20 is comfortable for any single-user
// PAT. Not configurable: in practice nobody ever needed to tune it.
const MAX_PARALLEL_DOWNLOADS = 20;

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
    // --reset wipes per-root state — fetch a current title so the filename is fresh.
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

// Drop any root whose ancestor chain contains another configured root id —
// that's a nested-root configuration, and the parent root already covers
// everything the child would. We do this AFTER URL resolution so the warning
// shows the URL the user actually pasted, not just an opaque id.
async function dropNestedRoots(
  rootIds: string[],
  rootUrls: Map<string, string>,
  client: ConfluenceClient,
): Promise<string[]> {
  if (rootIds.length < 2) return rootIds;
  const idSet = new Set(rootIds);
  const ancestorsFor = new Map<string, Set<string>>();
  await Promise.all(
    rootIds.map(async (id) => {
      const page = await client.getPage(id, ['ancestors']);
      ancestorsFor.set(id, new Set((page.ancestors ?? []).map((a) => a.id)));
    }),
  );
  const kept: string[] = [];
  for (const id of rootIds) {
    const ancestors = ancestorsFor.get(id)!;
    const nestedUnder = [...idSet].find((other) => other !== id && ancestors.has(other));
    if (nestedUnder) {
      log.warn(
        `dropping nested root ${rootUrls.get(id) ?? id}: it lives under ${rootUrls.get(nestedUnder) ?? nestedUnder}, which already covers it`,
      );
      continue;
    }
    kept.push(id);
  }
  return kept;
}

async function runSync(opts: { reset: boolean; includeNew: boolean }): Promise<void> {
  const { config, rootDir } = await loadConfig();
  const outputDir = resolve(rootDir, config.output_dir);
  await mkdir(outputDir, { recursive: true });

  // Migration: warn once if we find the old one-file layout. The new per-root
  // indexes won't see it, so the user would otherwise wonder why their existing
  // state seems to have vanished.
  const oldStatePath = resolve(outputDir, '.state.json');
  if (existsSync(oldStatePath)) {
    log.warn(
      `found legacy .state.json at ${oldStatePath} from before per-root indexes — ignored. Run \`npm start -- --reset\` to rebuild as per-root index files, then delete .state.json.`,
    );
  }

  const adaptiveLimiter = new AdaptiveLimiter({ max: MAX_PARALLEL_DOWNLOADS, slowStart: true });
  log.info(`adaptive concurrency: starting at ${adaptiveLimiter.currentCapacity}, ramping toward ${MAX_PARALLEL_DOWNLOADS} on sustained success`);

  // Resolve user-pasted URLs to {baseUrl, rootIds}. URLs that already carry
  // a pageId resolve without a network call; pretty /display/SPACE/Title
  // URLs cost one search request each.
  const preClient = new ConfluenceClient({ baseUrl: new URL(config.roots[0]!).origin, pat: config.pat });
  const { baseUrl, roots: resolvedRoots } = await resolveRoots(config.roots, preClient);

  const client = new ConfluenceClient({
    baseUrl,
    pat: config.pat,
    rateLimitObserver: adaptiveLimiter,
  });

  // Detect and drop nested roots before we waste any work on them.
  const rootUrlById = new Map<string, string>();
  for (const r of resolvedRoots) rootUrlById.set(r.pageId, r.sourceUrl);
  const liveRootIds = await dropNestedRoots(resolvedRoots.map((r) => r.pageId), rootUrlById, client);

  // Load (or initialise) one index per live root.
  const roots: RootContext[] = [];
  for (const rootId of liveRootIds) {
    roots.push(await resolveRoot(outputDir, rootId, client, opts.reset));
  }
  const totalLocal = roots.reduce((acc, r) => acc + Object.keys(r.state.pages).length, 0);
  const rootSummary = roots
    .map((r) => `"${r.title}" (${r.rootId}, ${Object.keys(r.state.pages).length} pages, last_sync=${r.state.last_sync ?? 'never'})`)
    .join('; ');
  log.info(`loaded ${roots.length} root index file(s) — ${totalLocal} pages already on disk: ${rootSummary}`);

  // Live root ids — used by pickPageRelPath to trim ancestor folders above
  // the root so the on-disk tree starts where the user said to.
  const rootPageIds = new Set(liveRootIds);

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
  let allErrors = 0;
  const allErrorSummary: Record<string, number> = {};

  for (const root of roots) {
    // For a brand-new root (no prior last_sync) the DB walk is the right
    // default even without --includeNew: CQL depends on Confluence's Lucene
    // index, which often hasn't materialised descendant relationships for a
    // newly-watched root yet, leading to silent zero-result enumerations.
    // The DB walk hits the content table directly and bypasses Lucene.
    const useDbWalk = opts.includeNew || !root.state.last_sync;
    const mode = opts.includeNew
      ? 'DB walk (slow, catches edits + creations + deletions)'
      : !root.state.last_sync
        ? 'DB walk (first run for this root — Lucene lag would risk a silent zero-result)'
        : `CQL incremental, lastmodified >= ${root.state.last_sync} (instant, edits only)`;
    log.info(`syncing root "${root.title}" (${root.rootId}) via ${mode}`);

    const { pages: results, pagesWithChildren } = useDbWalk
      ? await enumerateSubtree(root.rootId, client, adaptiveLimiter)
      : await enumerateViaCQL(root.rootId, client, root.state.last_sync);
    const seen = new Map<string, (typeof results)[number]>();
    for (const r of results) seen.set(r.id, r);

    // Comments for the subtree, fetched once per root via CQL. The list is
    // grouped by container.id so the downloader can render each page's
    // comments inline and the diff loop below can spot comment-only changes.
    const commentList = await client.searchCommentsBySubtree(root.rootId);
    const commentsByPageId = new Map<string, ConfluencePage[]>();
    for (const c of commentList) {
      const pid = c.container?.id;
      if (!pid) continue;
      const arr = commentsByPageId.get(pid) ?? [];
      arr.push(c);
      commentsByPageId.set(pid, arr);
    }
    log.info(`${root.title}: ${commentList.length} comment(s) across ${commentsByPageId.size} page(s)`);

    for (const page of seen.values()) {
      knownPagePaths.set(page.id, pickPageRelPath(page, pagesWithChildren, rootPageIds));
      const sp = page.space?.key;
      if (sp) titleIndex.set(titleIndexKey(sp, page.title), page.id);
    }

    // Pages needing a re-render = body version bumped OR new to us OR comment
    // set changed. Comment-only changes still trigger a full page re-fetch
    // because the body comes back free with `expand=body.storage`, and writing
    // a fresh .md with the same body + new Comments section is the simplest
    // path. On an incremental CQL run we don't see unchanged pages at all, so
    // comment-only changes there are picked up on the next --includeNew sweep
    // or full sync.
    const remaining = [...seen.values()].filter((p) => {
      const prev = root.state.pages[p.id];
      if (!prev) return true;
      if (prev.version !== (p.version?.number ?? 0)) return true;
      const observedComments = commentsByPageId.get(p.id) ?? [];
      return commentsChanged(prev.comments ?? {}, observedComments);
    });
    const newPageIds = new Set(remaining.filter((p) => !root.state.pages[p.id]).map((p) => p.id));
    const updatedPageIds = new Set(remaining.filter((p) => root.state.pages[p.id]).map((p) => p.id));

    // `total_watched_pages_on_remote` is only meaningful after a full
    // enumeration. On a filtered incremental we'd be writing "changed
    // since last_sync" into a field that means "total in subtree" —
    // confusing. Leave the previous value in place on incremental runs.
    if (useDbWalk || opts.reset) {
      root.state.total_watched_pages_on_remote = seen.size;
    }
    root.state.total_pages_downloaded = Object.keys(root.state.pages).length;
    log.info(`${root.title}: ${seen.size} page(s) in enumeration; ${remaining.length} need fetching (${newPageIds.size} new, ${updatedPageIds.size} updated)`);

    // Per-page change logging is useful for incremental runs (you see
    // exactly what got picked up), noisy on a first run / --reset where
    // every page in the corpus would emit a line. `last_sync` is non-null
    // iff a successful sync has already happened, so it's the natural gate.
    const logPerPage = !!root.state.last_sync && !opts.reset;
    const result = await downloadPages(
      remaining,
      {
        config,
        baseUrl,
        client,
        outputDir,
        state: root.state,
        knownPagePaths,
        pagesWithChildren,
        titleIndex,
        rootPageIds,
        limiter: adaptiveLimiter,
        logPerPage,
        commentsByPageId,
        // Cheap per-page persistence: append one line to the sibling .jsonl
        // instead of re-serialising the whole .json. The .json is rewritten
        // (and the .jsonl deleted) at finalizeIndex below.
        flushState: (id: string) =>
          appendIndexEntry(jsonlPathFromIndexPath(root.indexPath), id, root.state.pages[id]!),
      },
      syncIso,
    );

    // Delete reconciliation only runs when we've seen the full subtree —
    // i.e. DB walk (the new default for first-run roots) or --includeNew.
    // On a filtered incremental CQL run we can't tell missing-from-result
    // from never-edited, so we skip it and let the next sweep catch deletes.
    const sawFullSubtree = useDbWalk || opts.reset;
    let deletedCount = 0;
    if (sawFullSubtree) {
      const allIds = new Set(seen.keys());
      const toDelete = Object.keys(root.state.pages).filter((id) => !allIds.has(id));
      deletedCount = toDelete.length;
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
          if (logPerPage) {
            const author = st.last_modified_by ?? 'unknown';
            log.info(`[deleted] "${st.title}" (${id}) — last edited by ${author}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`orphan delete failed for ${id} (root ${root.rootId}): ${msg}`);
        }
        delete root.state.pages[id];
      }
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

  if (!opts.includeNew) {
    log.info(`latest modifications synced. Newly-created and deleted pages take ~1 hour to appear via the index — re-run later, or run \`npm start -- --includeNew\` to pick them up immediately (slower, walks the DB).`);
  }

  // Throttle stats — "of N HTTP requests, M had to back off." Useful to gauge
  // whether the limiter ceiling is set too high for the server.
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
  const baseUrl = new URL(config.roots[0]!).origin;

  // Load every per-root index, merging into one big map for the resolver.
  // We don't need a client here — reconvert is network-free, working entirely
  // from the saved .html files on disk plus the resolver maps in state.
  // Discovery is by glob: every `index-*--<id>.json` next to outputDir gets
  // picked up regardless of which roots are currently in config, so a
  // reconvert after a root removal still rebuilds the on-disk corpus.
  const mergedPages: StateFile['pages'] = {};
  const mergedKnown = new Map<string, string>();
  const mergedTitle = new Map<string, string>();
  const { readdir } = await import('node:fs/promises');
  let entries: string[] = [];
  try {
    entries = await readdir(outputDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const indexFiles = entries.filter((e) => e.startsWith('index-') && e.endsWith('.json'));
  for (const f of indexFiles) {
    // Extract id from the `--<id>.json` suffix to drive readIndex's rootId
    // default; the file's stored root_page_id wins anyway.
    const m = /--([^-]+)\.json$/.exec(f);
    const rootId = m?.[1] ?? '';
    const state = await readIndex(resolve(outputDir, f), rootId, '(unknown)');
    Object.assign(mergedPages, state.pages);
    for (const [id, p] of Object.entries(state.pages)) {
      mergedKnown.set(id, p.path);
      if (p.space && p.title) mergedTitle.set(titleIndexKey(p.space, p.title), id);
    }
  }

  const allPages = Object.entries(mergedPages);
  if (allPages.length === 0) {
    log.warn('no index files found; nothing to reconvert. Run `npm start` first.');
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
    // Reconvert doesn't hit the network, so it can't refresh comment
    // bodies. We have the comment stubs in state.pages[id].comments — keep
    // the count + inline marker handling consistent, but the body of the
    // Comments section will be empty placeholders until the next sync.
    const inlineIds = new Set(
      Object.entries(p.comments ?? {})
        .filter(([, stub]) => stub.location === 'inline')
        .map(([cid]) => cid),
    );
    const conversion = convertStorageFormat(
      html,
      buildConvertOptions({
        pageId: id,
        pagePath: p.path,
        pageSpace: p.space,
        baseUrl,
        state: stubState,
        knownPagePaths: mergedKnown,
        titleIndex: mergedTitle,
        inlineCommentIds: inlineIds,
      }),
    );
    // Build a minimal "## Comments" placeholder from stubs so the .md stays
    // close to the live shape between syncs. Empty section if no comments.
    const placeholderComments = Object.entries(p.comments ?? {}).map(([cid, stub]): ConfluencePage => ({
      id: cid,
      type: 'comment',
      title: '',
      version: { number: stub.version },
      ancestors: stub.parent_id ? [{ id: stub.parent_id, type: 'comment' }] : [],
      extensions: { location: stub.location ?? undefined },
      body: { storage: { value: '<p><em>(reconvert — comment body not on disk; run `npm start` to refresh)</em></p>', representation: 'storage' } },
    }));
    const commentsSection = buildCommentsSection(placeholderComments, conversion.inlineCommentAnchors);
    const body = buildMarkdownBody(
      {
        title: p.title,
        version: p.version,
        last_modified: p.last_modified,
        last_modified_by: p.last_modified_by,
        webui_url: p.webui_url,
        comments: Object.keys(p.comments ?? {}).length,
      },
      conversion.markdown,
      commentsSection,
    );
    await writeFile(mdAbs, body, 'utf8');
    processed++;
  }
  log.info(`reconvert complete: ${processed} processed, ${skipped} skipped`);
  void writeFile;
}


function usage(): void {
  console.error('usage: npm start -- [reconvert] [--includeNew] [--reset]');
  console.error('default (no args): sync — CQL incremental for known roots, DB walk for new roots.');
  console.error('--includeNew: also pick up newly-created and deleted pages on known roots (DB walk).');
  console.error('--reset:      wipe state and re-download every page from scratch.');
  console.error('reconvert:    regenerate every .md from the saved .html (no network).');
}

const [, , maybeCmd, ...rest] = process.argv;
const cmd = maybeCmd && !maybeCmd.startsWith('--') ? maybeCmd : 'sync';
const flags = [maybeCmd, ...rest].filter((a): a is string => typeof a === 'string' && a.startsWith('--'));
const includeNew = flags.includes('--includeNew');
const reset = flags.includes('--reset');
const helpRequested = flags.includes('--help') || flags.includes('-h');

(async () => {
  if (helpRequested) {
    usage();
    return;
  }
  switch (cmd) {
    case 'sync':
      await runSync({ reset, includeNew });
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
  // Print the error and any `cause` chain (undici stacks DNS/TCP/TLS
  // failures under .cause as a TypeError("fetch failed") wrapper). For
  // error paths we deliberately ignore the "one-line logs" convention —
  // structured detail (code, syscall, hostname, stack) is exactly what
  // you need to diagnose a real production failure.
  const lines: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      const node = current as NodeJS.ErrnoException;
      const fields = [
        node.code ? `code=${node.code}` : null,
        (node as unknown as { syscall?: string }).syscall ? `syscall=${(node as unknown as { syscall?: string }).syscall}` : null,
        (node as unknown as { hostname?: string }).hostname ? `hostname=${(node as unknown as { hostname?: string }).hostname}` : null,
        (node as unknown as { address?: string }).address ? `address=${(node as unknown as { address?: string }).address}` : null,
        (node as unknown as { port?: number }).port ? `port=${(node as unknown as { port?: number }).port}` : null,
      ].filter(Boolean).join(' ');
      const label = depth === 0 ? 'cli error' : `caused by (${depth})`;
      lines.push(`${label}: ${node.message}${fields ? ` [${fields}]` : ''}`);
      if (node.stack) lines.push(node.stack);
      current = (node as { cause?: unknown }).cause;
    } else {
      lines.push(`caused by (${depth}): ${String(current)}`);
      current = null;
    }
    depth++;
  }
  log.error(lines.join('\n'));
  process.exitCode = 1;
});
