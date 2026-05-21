import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { AdaptiveLimiter } from './adaptive-limiter.ts';
import type { Config } from './config.ts';
import type { ConfluenceClient, ConfluencePage } from './confluence.ts';
import { convertStorageFormat } from './converter.ts';
import { log } from './log.ts';
import { folderIndexPath, htmlPathFor, leafPath, spaceIndexPath } from './pathing.ts';
import type { PageState, StateFile } from './state.ts';

export interface DownloadOptions {
  config: Config;
  client: ConfluenceClient;
  outputDir: string;
  state: StateFile;
  // Pre-built map: page id → relative path. Used to resolve internal ac:link references.
  knownPagePaths: Map<string, string>;
  // Set of page ids known to have children (forces folder + _index.md instead of leaf file).
  pagesWithChildren: Set<string>;
  // Pre-built map: `${spaceKey}::${title}` → page id. Used to resolve ac:link[ri:page] hits.
  titleIndex: Map<string, string>;
  // Configured root page ids. Used to trim Confluence's full ancestor chain
  // so the on-disk tree starts at the user's chosen root, not the space root.
  rootPageIds: Set<string>;
  // Shared adaptive limiter — gates concurrency + inter-request spacing,
  // shrinks on 429, grows on sustained success. One per runSync invocation.
  limiter: AdaptiveLimiter;
  // Called after each successful page write so state is persisted incrementally.
  // The id is the page that was just written; callers can append it to a
  // jsonl rather than re-serialising the full state every time.
  flushState?: (id: string) => Promise<void>;
}

export interface DownloadResult {
  written: string[];
  errors: { id: string; error: unknown }[];
}

// Canonical source-URL for a Confluence page. We always use the /pages/viewpage.action
// form (rather than page._links.webui) so the URL is deterministic — sync and reconvert
// produce identical .md headers.
export function sourceUrlFor(baseUrl: string, pageId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/pages/viewpage.action?pageId=${pageId}`;
}

// Full clickable webUI URL. Prefers Confluence's own `_links.webui` (the
// human-friendly /display/SPACE/Title form) when available, falls back to
// the viewpage.action form. Always absolute so it can be clicked from the
// index file directly.
export function buildWebUiUrl(baseUrl: string, page: ConfluencePage): string {
  const base = baseUrl.replace(/\/$/, '');
  const webui = page._links?.webui;
  if (webui) {
    if (webui.startsWith('http')) return webui;
    return `${base}${webui.startsWith('/') ? '' : '/'}${webui}`;
  }
  return sourceUrlFor(baseUrl, page.id);
}

// Build the body of the .md file. Frontmatter is composed FROM the state
// entry, not from raw page data — so the index file remains the source of
// truth and the frontmatter is a regeneratable view. `reconvert` and the
// online sync both produce identical .md given identical state.
//
// The webui_url already replaces the old "<source-url>" autolink at the top
// of the body, so the header is now just the frontmatter and the H1 title.
export interface MarkdownMetadata {
  title: string;
  version: number;
  last_modified: string | null;
  last_modified_by: string | null;
  webui_url: string;
}

function yamlString(s: string): string {
  // Cheap YAML string escape: wrap in double quotes, escape backslashes + quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMarkdownBody(meta: MarkdownMetadata, markdown: string): string {
  const lines = [
    '---',
    `title: ${yamlString(meta.title)}`,
    `version: ${meta.version}`,
    `last_modified: ${meta.last_modified ? yamlString(meta.last_modified) : 'null'}`,
    `last_modified_by: ${meta.last_modified_by ? yamlString(meta.last_modified_by) : 'null'}`,
    `webui_url: ${yamlString(meta.webui_url)}`,
    '---',
    '',
    `# ${meta.title}`,
    '',
    markdown,
    '',
  ];
  return lines.join('\n');
}

function resolveRelativePagePath(pageRelPath: string, targetRelPath: string): string {
  const fromDir = posix.dirname(pageRelPath);
  const rel = posix.relative(fromDir, targetRelPath);
  return rel || posix.basename(targetRelPath);
}

export function titleIndexKey(spaceKey: string, title: string): string {
  return `${spaceKey}::${title}`;
}

export function pickPageRelPath(
  page: ConfluencePage,
  pagesWithChildren: Set<string>,
  rootPageIds: Set<string>,
): string {
  const spaceKey = page.space?.key ?? 'UNKNOWN';
  const ancestors = (page.ancestors ?? []).map((a) => ({ id: a.id, title: a.title ?? a.id }));
  // Drop the page itself if it appears as ancestor (Confluence sometimes does this).
  let filteredAncestors = ancestors.filter((a) => a.id !== page.id);

  // Skip ancestors above the configured root. Without this, Confluence's full
  // ancestor chain (space-root → intermediate → ... → configured-root → page)
  // produces empty subdirs on disk for every ancestor we don't actually watch.
  // If the page itself is a configured root, drop everything; otherwise find
  // the deepest ancestor that's a configured root and slice from there.
  if (rootPageIds.has(page.id)) {
    filteredAncestors = [];
  } else {
    for (let i = filteredAncestors.length - 1; i >= 0; i--) {
      if (rootPageIds.has(filteredAncestors[i]!.id)) {
        filteredAncestors = filteredAncestors.slice(i);
        break;
      }
    }
  }

  const isSpaceRoot = filteredAncestors.length === 0 && page.title.trim().toLowerCase() === spaceKey.toLowerCase();
  if (isSpaceRoot) return spaceIndexPath(spaceKey);
  if (pagesWithChildren.has(page.id)) {
    return folderIndexPath(spaceKey, filteredAncestors, page.title, page.id);
  }
  return leafPath(spaceKey, filteredAncestors, page.title, page.id);
}

// Shared between fetchAndWriteOne (online sync) and runReconvert (offline rebuild).
// Both need the same resolver behaviour so a sync and a subsequent reconvert produce
// byte-identical .md files.
export function buildConvertOptions(args: {
  pageId: string;
  pagePath: string;
  pageSpace: string;
  baseUrl: string;
  state: StateFile;
  knownPagePaths: Map<string, string>;
  titleIndex: Map<string, string>;
}): Parameters<typeof convertStorageFormat>[1] {
  const { pageId, pagePath, pageSpace, baseUrl, state, knownPagePaths, titleIndex } = args;
  // pagePath/pageSpace currently only relevant for attachment hrefs, which
  // we now render as absolute Confluence URLs instead of local paths.
  void pagePath;
  void pageSpace;
  return {
    pageId,
    // Attachments are out of scope: we don't download them, but we still
    // need to render image hrefs in the markdown. Point them at the live
    // Confluence download URL so they at least resolve when viewed on a
    // network with access to the server.
    resolveImage: (filename: string) =>
      `${baseUrl.replace(/\/$/, '')}/download/attachments/${pageId}/${encodeURIComponent(filename)}`,
    resolvePageLink: (ref) => {
      const targetSpace = ref.spaceKey ?? pageSpace;
      const targetId = titleIndex.get(titleIndexKey(targetSpace, ref.contentTitle));
      if (targetId) {
        const targetPath = knownPagePaths.get(targetId) ?? state.pages[targetId]?.path;
        if (targetPath) return resolveRelativePagePath(pagePath, targetPath);
      }
      const base = baseUrl.replace(/\/$/, '');
      const titleEnc = encodeURIComponent(ref.contentTitle.replace(/\s+/g, '+'));
      return `${base}/display/${encodeURIComponent(targetSpace)}/${titleEnc}`;
    },
  };
}

async function fetchAndWriteOne(
  page: ConfluencePage,
  opts: DownloadOptions,
  limiter: AdaptiveLimiter,
  syncIso: string,
): Promise<{ relPath: string }> {
  const spaceKey = page.space?.key ?? 'UNKNOWN';
  const relPath = pickPageRelPath(page, opts.pagesWithChildren, opts.rootPageIds);
  const absPath = join(opts.outputDir, relPath);

  const html = page.body?.storage?.value ?? '';
  const conversion = convertStorageFormat(
    html,
    buildConvertOptions({
      pageId: page.id,
      pagePath: relPath,
      pageSpace: spaceKey,
      baseUrl: opts.config.base_url,
      state: opts.state,
      knownPagePaths: opts.knownPagePaths,
      titleIndex: opts.titleIndex,
    }),
  );

  // Write the raw storage-format HTML next to the .md so reconvert can rebuild the
  // markdown later without re-hitting Confluence.
  const htmlAbsPath = htmlPathFor(absPath);
  const mdBody = buildMarkdownBody(
    {
      title: page.title,
      version: page.version?.number ?? 0,
      last_modified: page.version?.when ?? null,
      last_modified_by: page.version?.by?.displayName ?? null,
      webui_url: buildWebUiUrl(opts.config.base_url, page),
    },
    conversion.markdown,
  );

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(htmlAbsPath, html, 'utf8');
  await writeFile(absPath, mdBody, 'utf8');

  // Quiet "unused" hint — these args are kept for parity / future fields.
  void limiter;
  void syncIso;

  return { relPath };
}

export async function downloadPages(pages: ConfluencePage[], opts: DownloadOptions, syncIso: string): Promise<DownloadResult> {
  const limiter = opts.limiter;
  const written: string[] = [];
  const errors: { id: string; error: unknown }[] = [];
  // Periodic progress: time-based, every PROGRESS_INTERVAL_MS. Count-based
  // reporting added noise without much signal — the time floor alone gives a
  // reliable heartbeat regardless of throughput.
  const PROGRESS_INTERVAL_MS = 10_000;
  let lastProgressAt = Date.now();
  const total = pages.length;

  await Promise.all(
    pages.map((page) =>
      limiter.wrap(async () => {
        try {
          const detailed = page.body?.storage ? page : await opts.client.getPage(page.id);
          const result = await fetchAndWriteOne(detailed, opts, limiter, syncIso);
          written.push(result.relPath);
          // Update state in place.
          const detailedSpace = detailed.space?.key ?? 'UNKNOWN';
          opts.state.pages[detailed.id] = {
            version: detailed.version?.number ?? 0,
            path: result.relPath,
            title: detailed.title,
            space: detailedSpace,
            ancestors: (detailed.ancestors ?? []).map((a) => a.id),
            last_modified: detailed.version?.when ?? null,
            last_modified_by: detailed.version?.by?.displayName ?? null,
            webui_url: buildWebUiUrl(opts.config.base_url, detailed),
          };
          opts.knownPagePaths.set(detailed.id, result.relPath);
          opts.titleIndex.set(titleIndexKey(detailedSpace, detailed.title), detailed.id);
          // Keep the top-of-state counter up to date even mid-sync, so an
          // interrupted run's per-root index file still reflects the true count.
          opts.state.total_pages_downloaded = Object.keys(opts.state.pages).length;
          // Tell the adaptive limiter we landed one — moves toward bumping capacity.
          opts.limiter.reportSuccess();

          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
            log.info(`progress: ${written.length} of ${total} downloaded`);
            lastProgressAt = now;
          }
          // Persist after every successful page so an interrupt is recoverable.
          // writeIndex is atomic (.tmp + rename); concurrent calls just clobber
          // each other's renames, which is fine — they all write the same in-memory
          // state object's current snapshot.
          if (opts.flushState) {
            try {
              await opts.flushState(detailed.id);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn(`failed to flush state mid-sync for ${detailed.id} (will retry on next page): ${msg}`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`page fetch failed for ${page.id}: ${msg}`);
          errors.push({ id: page.id, error: err });
        }
      }),
    ),
  );

  return { written, errors };
}
