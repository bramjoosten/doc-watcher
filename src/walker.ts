import type { WatchEntry } from './config.js';

// Enumerate every page in the subtree rooted at `watch`. We deliberately
// don't narrow by `lastmodified` even on incremental runs: that field
// has proved unreliable for picking up newly-created pages on Confluence
// Server (whether due to search-index lag or because `lastmodified` only
// tracks edits-to-existing-pages, not creation). Paging metadata-only
// CQL results is cheap (~1 request per 100 pages, no body expansion);
// the per-page version diff in the downloader is what actually decides
// what to re-fetch, so the cost is bounded and there's no risk of
// missing new pages.
export function buildCQL(watch: WatchEntry): string {
  return `(id = ${watch} OR ancestor = ${watch}) AND type = page`;
}

