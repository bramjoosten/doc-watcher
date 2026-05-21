import type { AdaptiveLimiter } from './adaptive-limiter.js';
import type { ConfluenceClient, ConfluencePage } from './confluence.js';
import { log } from './log.js';

export interface SubtreeEnumeration {
  // Every page in the subtree, including the root. Each entry has version
  // (from the API), space (inherited from the root), and a synthesised
  // ancestors chain (parent's ancestors + parent) — populated locally as
  // we descend, so we never need the expensive `expand=ancestors` on
  // /child/page that 500'd /descendant/page.
  pages: ConfluencePage[];
  // Page ids known to have at least one child — anything we recursed into
  // and got non-empty results back for. The downloader uses this to decide
  // whether each page is stored as a folder (`<slug>--<id>/_index.md`) or
  // a flat leaf file.
  pagesWithChildren: Set<string>;
}

// Walk the subtree under `rootId` via the DB-backed /child/page endpoint.
// Streaming pool, not level-by-level: each parent's child-fetch is its
// own task, scheduled into the shared adaptive limiter. As soon as a
// fetch returns, its children become their own pending tasks. There's
// no per-level barrier, so a single slow parent on level N doesn't
// freeze every parent on level N+1.
export async function enumerateSubtree(
  rootId: string,
  client: ConfluenceClient,
  limiter: AdaptiveLimiter,
): Promise<SubtreeEnumeration> {
  const started = Date.now();
  log.info({ rootId }, 'walking subtree via /child/page (DB-backed, streaming pool)');

  // /child/page is a cheap parent_id lookup against the content table —
  // not the heavy body download the limiter's slow-start was designed
  // for. Warm the limiter straight to its configured ceiling so a wide
  // BFS level doesn't drag through one connection. The limiter still
  // halves on any 429 and still throttles from X-RateLimit-* headers,
  // so the safety net is intact.
  limiter.warmUp(limiter.maxCapacity);

  const rootPage = await client.getPage(rootId, ['version', 'space', 'ancestors']);
  // Subtree-internal pages inherit space from the root (descendant queries
  // don't cross spaces), so we don't ask Confluence for `expand=space` per page.
  const inheritedSpace = rootPage.space;
  const pages: ConfluencePage[] = [rootPage];
  const pagesWithChildren = new Set<string>();
  const pending = new Set<Promise<void>>();
  let parentsFetched = 0;

  const scheduleParent = (parent: ConfluencePage): void => {
    const task = (async () => {
      const children = await limiter.wrap(() => client.getChildPages(parent.id, ['version']));
      parentsFetched++;
      if (children.length > 0) pagesWithChildren.add(parent.id);
      const parentAncestors = parent.ancestors ?? [];
      for (const child of children) {
        child.ancestors = [...parentAncestors, { id: parent.id, title: parent.title }];
        child.space = inheritedSpace;
        pages.push(child);
        scheduleParent(child);
      }
    })();
    pending.add(task);
    // Keep `pending` honest as tasks resolve so the outer drain loop terminates.
    task.finally(() => pending.delete(task)).catch(() => {});
  };

  scheduleParent(rootPage);

  // Time-based progress beacon — fires every 5 s for as long as there's
  // in-flight work. Reports enough state to diagnose a stall (is the
  // limiter pinned at capacity 1? are we waiting on the server? are we
  // making forward progress?).
  const progressTimer = setInterval(() => {
    log.info(
      {
        walked: pages.length,
        parentsFetched,
        inFlight: pending.size,
        limiterCapacity: limiter.currentCapacity,
        elapsedMs: Date.now() - started,
      },
      `walking: ${pages.length} pages discovered, ${parentsFetched} parents fetched, ${pending.size} in flight, limiter at ${limiter.currentCapacity}`,
    );
  }, 5000);

  try {
    // Drain. `Promise.race` resumes on the first resolution; the resolved task
    // removes itself from `pending` via .finally before we loop. Tasks spawned
    // by that resolution (children) land in `pending` before the parent's
    // resolution propagates, so they're picked up on the next race.
    while (pending.size > 0) {
      await Promise.race(pending);
    }
  } finally {
    clearInterval(progressTimer);
  }

  log.info(
    {
      rootId,
      total: pages.length,
      parents: pagesWithChildren.size,
      elapsedMs: Date.now() - started,
    },
    `walked ${pages.length} pages (${pagesWithChildren.size} parents) in ${Date.now() - started}ms`,
  );
  return { pages, pagesWithChildren };
}
