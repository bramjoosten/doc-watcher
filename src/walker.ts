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

// Walk the subtree under `rootId` breadth-first via the DB-backed
// /child/page endpoint, one API call per parent page. Calls within a
// BFS level are issued in parallel, gated by the shared adaptive
// limiter so the page-listing work shares the same rate-limit budget
// as the body downloads that follow.
export async function enumerateSubtree(
  rootId: string,
  client: ConfluenceClient,
  limiter: AdaptiveLimiter,
): Promise<SubtreeEnumeration> {
  const started = Date.now();
  log.info({ rootId }, 'enumerating subtree via /child/page (DB-backed, bypasses Lucene)');

  const rootPage = await client.getPage(rootId, ['version', 'space', 'ancestors']);
  // For pages inside the subtree, inherit `space` from the root. Confluence
  // descendant queries don't cross spaces, so this is safe and saves us
  // having to expand=space per page.
  const inheritedSpace = rootPage.space;

  const pages: ConfluencePage[] = [rootPage];
  const pagesWithChildren = new Set<string>();
  let queue: ConfluencePage[] = [rootPage];

  while (queue.length > 0) {
    const level = queue;
    queue = [];
    const childResults = await Promise.all(
      level.map((parent) => limiter.wrap(() => client.getChildPages(parent.id, ['version']))),
    );
    for (let i = 0; i < level.length; i++) {
      const parent = level[i]!;
      const children = childResults[i]!;
      if (children.length > 0) pagesWithChildren.add(parent.id);
      const parentAncestors = parent.ancestors ?? [];
      for (const child of children) {
        // Stitch the chain together locally: child.ancestors = parent.ancestors + parent.
        child.ancestors = [...parentAncestors, { id: parent.id, title: parent.title }];
        child.space = inheritedSpace;
        pages.push(child);
        queue.push(child);
      }
    }
    log.info(
      { walked: pages.length, elapsedMs: Date.now() - started },
      `${pages.length} pages walked so far`,
    );
  }

  log.info(
    { rootId, total: pages.length, parents: pagesWithChildren.size, elapsedMs: Date.now() - started },
    `Confluence returned ${pages.length} pages in ${Date.now() - started}ms`,
  );
  return { pages, pagesWithChildren };
}
