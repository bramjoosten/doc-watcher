// All user-facing log copy lives here, grouped by area. Keeps stdout phrasing
// consistent and editable in one place — change wording without hunting
// through every module. Functions wrap any message that needs interpolation;
// the `n` helper from ./log.ts handles "no foo / 1 foo / N foos" so callers
// don't have to special-case zero or plural.

import { n } from './log.ts';

export const messages = {
  sync: {
    // Top-of-run summary — how many sections we're watching, how full they are.
    loadedRoots: (rootCount: number, totalLocal: number, summary: string) =>
      `loaded ${n(rootCount, 'watched section')} — ${n(totalLocal, 'page')} already on disk: ${summary}`,
    // One line per root explaining how we're going to enumerate it.
    start: (title: string, rootId: string, mode: string) =>
      `syncing "${title}" (${rootId}) — ${mode}`,
    modeIncremental: (lastSync: string) =>
      `incremental, picking up changes since ${lastSync}`,
    modeFirstRun: 'first sync for this section (downloading the whole subtree)',
    modeFullWalk: 'full subtree walk (slower, catches creations and deletions too)',
    // Soft warning when first-run sync looks suspiciously empty — likely
    // Confluence's search index hasn't built descendants for a fresh root.
    firstRunEmpty: (title: string, count: number) =>
      `${title}: first sync returned ${n(count, 'page')}. If you expected more, Confluence's search index may not have indexed this section yet — try \`npm start -- --includeNew\` to walk it directly.`,
    // After enumeration, before downloads: what's there vs what we'll fetch.
    enumerated: (title: string, total: number, remaining: number, newCount: number, updatedCount: number) => {
      if (total === 0) return `${title}: no pages found`;
      if (remaining === 0) return `${title}: ${n(total, 'page')}, all up to date`;
      const parts: string[] = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} updated`);
      const verb = remaining === 1 ? 'needs an update' : 'need an update';
      const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `${title}: ${n(total, 'page')}, ${remaining} ${verb}${breakdown}`;
    },
    // Sync failed for one or more pages — checkpoint stays frozen so the next
    // run retries them. Reads like a heads-up, not a stop-the-world error.
    checkpointFrozen: (title: string, errCount: number, lastSync: string | null) =>
      `${title}: ${n(errCount, 'page')} failed to download; the sync checkpoint stays at ${lastSync ?? 'never'} so they'll retry next run`,
  },

  comments: {
    // Per-root summary of the comment fetch.
    found: (title: string, commentCount: number, pageCount: number) => {
      if (commentCount === 0) return `${title}: no comments in this section`;
      return `${title}: ${n(commentCount, 'comment')} across ${n(pageCount, 'page')}`;
    },
  },

  speedOptimizer: {
    // First time we see Confluence's rate-budget headers. Tells the user
    // what their server permits without exposing token-bucket internals.
    serverBudget: (perSec: number, remaining: number, limit: number) =>
      `speed optimizer: Confluence allows about ${perSec.toFixed(1)} requests per second sustained (${remaining} of ${limit} available right now)`,
    // Warm-up bumps capacity past the slow-start floor — useful for the
    // metadata-only DB walk so a wide tree level doesn't run serially.
    warmedUp: (current: number, cap: number) =>
      `speed optimizer warmed up to ${current} parallel downloads (cap ${cap})`,
    // End-of-sync stat: how often did we have to slow down and wait?
    retried: (recovered: number, total: number, failed: number) => {
      const pct = total > 0 ? Math.round((recovered / total) * 100) : 0;
      const failedNote = failed > 0 ? `; ${n(failed, 'request')} gave up after retrying` : '';
      return `speed optimizer: ${recovered} of ${total} requests (${pct}%) had to slow down and retry${failedNote}`;
    },
  },

  search: {
    // Interim progress for long enumerations — fires every 100 pages so the
    // user sees something is happening on slow searches.
    progress: (count: number, elapsedMs: number) =>
      `still searching — ${n(count, 'page')} so far (${Math.round(elapsedMs / 1000)}s elapsed)`,
  },

  fetch: {
    // Per-page log on incremental runs (suppressed on first run / --reset).
    pageChange: (verb: 'created' | 'modified' | 'deleted', title: string, id: string, author: string) =>
      `[${verb}] "${title}" (${id}) by ${author}`,
    // Periodic download progress every 10s.
    progress: (done: number, total: number) =>
      `progress: ${done} of ${total} downloaded`,
    // After-retry success — useful diagnostic when the server was slow.
    recovered: (url: string, attempt: number) =>
      `recovered after slowing down: ${url} succeeded on attempt ${attempt}`,
    // The server told us to back off; we waited as instructed.
    rateLimited: (status: number, statusText: string, url: string, attempt: number, snippet: string, waitMs: number) =>
      `Confluence asked us to slow down (${status} ${statusText}) for ${url} on attempt ${attempt}: ${snippet || '(no detail)'} — waiting ${waitMs}ms`,
    failed: (id: string, reason: string) =>
      `couldn't fetch page ${id}: ${reason}`,
    flushFailed: (id: string, reason: string) =>
      `couldn't save mid-sync state for ${id} (will retry on next page): ${reason}`,
  },

  cleanup: {
    // A page was deleted in Confluence and we're tidying its local files.
    orphanDeleted: (title: string, id: string, author: string) =>
      `[deleted] "${title}" (${id}) — last edited by ${author}`,
    orphanFailed: (id: string, rootId: string, reason: string) =>
      `couldn't remove deleted page ${id} (root ${rootId}): ${reason}`,
  },

  summary: {
    // End-of-run headline — one of these two lines, never both.
    noChanges: (rootCount: number, candidates: number, skipped: number) =>
      `no changes across ${n(rootCount, 'watched section')} — checked ${n(candidates, 'page')}${skipped > 0 ? `, all ${skipped} already up to date` : ''}`,
    changes: (totalChanges: number, rootCount: number, breakdown: string, downloaded: number, candidates: number, skipped: number) => {
      const skippedNote = skipped > 0 ? `; ${skipped} already up to date` : '';
      return `${n(totalChanges, 'change')} across ${n(rootCount, 'watched section')}${breakdown} — downloaded ${downloaded} of ${candidates}${skippedNote}`;
    },
    errorSuffix: (errors: number, errorBreakdown: string) =>
      `. ${n(errors, 'error')} (${errorBreakdown}) — re-run \`npm start\` to retry.`,
    // Reminder hint at end of incremental sync (not --includeNew).
    newDeletedHint: 'latest edits synced. Newly-created and deleted pages take about an hour to appear in the default search — re-run later, or run `npm start -- --includeNew` to pick them up now (slower, walks the subtree directly).',
  },

  config: {
    // We found a config.yaml/.yml/.json next to config.ts — it's ignored.
    staleConfigFile: (filename: string) =>
      `found ${filename} next to config.ts — this file is IGNORED; only config.ts is read. Move your settings into config.ts.`,
    // Old single-file state from before per-root indexes existed.
    legacyState: (path: string) =>
      `found legacy .state.json at ${path} from before per-section indexes — ignored. Run \`npm start -- --reset\` to rebuild as per-section index files, then delete .state.json.`,
  },

  url: {
    nestedRootDropped: (childUrl: string, parentUrl: string) =>
      `dropping nested section ${childUrl}: it lives under ${parentUrl}, which already covers it`,
  },

};
