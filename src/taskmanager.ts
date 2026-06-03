#!/usr/bin/env node
// Disable TLS cert verification + silence the resulting warning. Must import
// FIRST so it runs before any HTTPS connection is made.
import './disable-tls-check.ts';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AdaptiveLimiter } from './adaptive-limiter.ts';
import { loadConfig } from './config.ts';
import { ConfluenceClient, type ConfluencePage } from './confluence.ts';
import {
  commentsChanged,
  downloadPages,
  pickPageRelPath,
  titleIndexKey,
} from './downloader.ts';
import { log } from './log.ts';
import { messages } from './messages.ts';
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
      log.warn(messages.url.nestedRootDropped(rootUrls.get(id) ?? id, rootUrls.get(nestedUnder) ?? nestedUnder));
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
    log.warn(messages.config.legacyState(oldStatePath));
  }

  const adaptiveLimiter = new AdaptiveLimiter({ max: MAX_PARALLEL_DOWNLOADS, slowStart: true });

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
    .map((r) => `"${r.title}" (${r.rootId}, ${Object.keys(r.state.pages).length} pages, last sync ${r.state.last_sync ?? 'never'})`)
    .join('; ');
  log.info(messages.sync.loadedRoots(roots.length, totalLocal, rootSummary));

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
    const useDbWalk = opts.includeNew;
    const mode = opts.includeNew
      ? messages.sync.modeFullWalk
      : root.state.last_sync
        ? messages.sync.modeIncremental(root.state.last_sync)
        : messages.sync.modeFirstRun;
    log.info(messages.sync.start(root.title, root.rootId, mode));

    const { pages: results, pagesWithChildren } = useDbWalk
      ? await enumerateSubtree(root.rootId, client, adaptiveLimiter)
      : await enumerateViaCQL(root.rootId, client, root.state.last_sync);
    const seen = new Map<string, (typeof results)[number]>();
    for (const r of results) seen.set(r.id, r);

    // Soft safety net: on a first run, the default sync goes through
    // Confluence's search index, which may not have indexed descendant
    // relationships for a freshly-watched section yet. Don't fall back
    // silently — emit a hint pointing at --includeNew so the user can opt
    // in to the full subtree walk explicitly. Triggers when last_sync was
    // null and we got ≤1 page back (just the root itself or nothing).
    if (!opts.includeNew && !root.state.last_sync && seen.size <= 1) {
      log.warn(messages.sync.firstRunEmpty(root.title, seen.size));
    }

    // Comments for the subtree, fetched once per root regardless of mode.
    // The list is grouped by container (page) id so the downloader can
    // render comments inline and the diff loop can spot comment-only
    // changes — including on pages whose body didn't change at all.
    const commentList = await client.searchCommentsBySubtree(root.rootId);
    const commentsByPageId = new Map<string, ConfluencePage[]>();
    for (const c of commentList) {
      const pid = c.container?.id;
      if (!pid) continue;
      const arr = commentsByPageId.get(pid) ?? [];
      arr.push(c);
      commentsByPageId.set(pid, arr);
    }
    log.info(messages.comments.found(root.title, commentList.length, commentsByPageId.size));

    for (const page of seen.values()) {
      knownPagePaths.set(page.id, pickPageRelPath(page, pagesWithChildren, rootPageIds));
      const sp = page.space?.key;
      if (sp) titleIndex.set(titleIndexKey(sp, page.title), page.id);
    }

    // Pages needing a re-render fall into two buckets:
    //
    //  • In `seen` (returned by enumeration) — body version bumped, new to
    //    us, or the comment set changed since last sync.
    //  • NOT in `seen` (persisted but enumeration didn't return them, e.g.
    //    an old page on an incremental CQL run) — comment set changed.
    //    The comment fetch is global, so we have full visibility into
    //    comment state for the whole subtree on every sync. Without this
    //    second bucket, a new comment on an unedited page would wait
    //    until --includeNew to surface.
    //
    // Both buckets reuse fetchAndWriteOne, which always pulls body+comments
    // together. So the cost of "comment only changed on an old page" is
    // one body fetch + one .md rewrite, no special-case rendering path.
    const seenList = [...seen.values()];
    const inSeenRemaining = seenList.filter((p) => {
      const prev = root.state.pages[p.id];
      if (!prev) return true;
      if (prev.version !== (p.version?.number ?? 0)) return true;
      const observedComments = commentsByPageId.get(p.id) ?? [];
      return commentsChanged(prev.comments ?? {}, observedComments);
    });
    const inSeenIds = new Set(seen.keys());
    const commentOnlyRemaining: typeof seenList = [];
    for (const [id, prev] of Object.entries(root.state.pages)) {
      if (inSeenIds.has(id)) continue;
      const observedComments = commentsByPageId.get(id) ?? [];
      if (commentsChanged(prev.comments ?? {}, observedComments)) {
        // Stub a ConfluencePage-shaped entry so fetchAndWriteOne knows the
        // page id; downloadPages will fetch the full body before rendering.
        commentOnlyRemaining.push({ id, type: 'page', title: prev.title } as (typeof seenList)[number]);
      }
    }
    const remaining = [...inSeenRemaining, ...commentOnlyRemaining];
    const newPageIds = new Set(inSeenRemaining.filter((p) => !root.state.pages[p.id]).map((p) => p.id));
    const updatedPageIds = new Set([
      ...inSeenRemaining.filter((p) => root.state.pages[p.id]).map((p) => p.id),
      ...commentOnlyRemaining.map((p) => p.id),
    ]);

    // `total_watched_pages_on_remote` is only meaningful after a full
    // enumeration. On a filtered incremental we'd be writing "changed
    // since last_sync" into a field that means "total in subtree" —
    // confusing. Leave the previous value in place on incremental runs.
    if (useDbWalk || !root.state.last_sync || opts.reset) {
      root.state.total_watched_pages_on_remote = seen.size;
    }
    root.state.total_pages_downloaded = Object.keys(root.state.pages).length;
    log.info(messages.sync.enumerated(root.title, seen.size, remaining.length, newPageIds.size, updatedPageIds.size));

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
    // i.e. --includeNew (DB walk) or a CQL run without the lastmodified
    // filter (first run / after --reset). On a filtered incremental CQL
    // we can't tell missing-from-result from never-edited, so we skip it
    // and let the next --includeNew sweep catch any deletes.
    const sawFullSubtree = useDbWalk || !root.state.last_sync || opts.reset;
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
            log.info(messages.cleanup.orphanDeleted(st.title, id, author));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(messages.cleanup.orphanFailed(id, root.rootId, msg));
        }
        delete root.state.pages[id];
      }
    }

    if (result.errors.length === 0) {
      root.state.last_sync = syncIso;
    } else {
      log.warn(messages.sync.checkpointFrozen(root.title, result.errors.length, root.state.last_sync));
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

  let headline: string;
  if (totalChanges === 0 && allErrors === 0) {
    headline = messages.summary.noChanges(roots.length, allCandidates, allSkipped);
  } else {
    headline = messages.summary.changes(totalChanges, roots.length, breakdown, allDownloaded, allCandidates, allSkipped);
  }
  if (allErrors > 0) {
    const errParts = Object.entries(allErrorSummary).map(([k, v]) => `${k}=${v}`).join(', ');
    headline += messages.summary.errorSuffix(allErrors, errParts);
  }

  log.info(headline);

  if (!opts.includeNew) {
    log.info(messages.summary.newDeletedHint);
  }

  // Throttle stats — "of N HTTP requests, M had to back off." Useful to gauge
  // whether the limiter ceiling is set too high for the server.
  const total = client.totalRequests;
  const recovered = client.requestsRecoveredAfterBackoff;
  const failedAfterRetries = client.requestsFailedAfterRetries;
  if (recovered > 0 || failedAfterRetries > 0) {
    log.info(messages.speedOptimizer.retried(recovered, total, failedAfterRetries));
  }

}


function usage(): void {
  console.error('usage: npm start -- [--includeNew] [--reset]');
  console.error('default (no args): incremental sync — picks up edits since the last run.');
  console.error('--includeNew: also pick up newly-created and deleted pages (full subtree walk, slower).');
  console.error('--reset:      wipe state and re-download every page from scratch.');
}

const flags = process.argv.slice(2).filter((a): a is string => a.startsWith('--'));
const includeNew = flags.includes('--includeNew');
const reset = flags.includes('--reset');
const helpRequested = flags.includes('--help') || flags.includes('-h');
const unknownFlag = flags.find((f) => !['--includeNew', '--reset', '--help', '-h'].includes(f));

(async () => {
  if (helpRequested) {
    usage();
    return;
  }
  if (unknownFlag) {
    console.error(`unknown flag: ${unknownFlag}`);
    usage();
    process.exit(1);
  }
  await runSync({ reset, includeNew });
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
