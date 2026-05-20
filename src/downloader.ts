import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { pLimit, type LimitFunction } from './limit.js';
import type { Config } from './config.js';
import type { ConfluenceAttachment, ConfluenceClient, ConfluencePage } from './confluence.js';
import { convertStorageFormat } from './converter.js';
import { log } from './log.js';
import {
  attachmentPath,
  attachmentRelativeForPage,
  folderIndexPath,
  htmlPathFor,
  leafPath,
  spaceIndexPath,
} from './pathing.js';
import type { PageState, StateFile } from './state.js';

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
  // Called after each successful page write so state is persisted incrementally.
  // If the process is interrupted mid-sync, the next run resumes from the last
  // flushed state instead of re-downloading the whole batch.
  flushState?: () => Promise<void>;
}

export interface DownloadResult {
  written: string[];
  attachments: string[];
  errors: { id: string; error: unknown }[];
}

// Canonical source-URL for a Confluence page. We always use the /pages/viewpage.action
// form (rather than page._links.webui) so the URL is deterministic — sync and reconvert
// produce identical .md headers.
export function sourceUrlFor(baseUrl: string, pageId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/pages/viewpage.action?pageId=${pageId}`;
}

// Build the body of the .md file: a one-line markdown autolink to the Confluence
// source, then the title as an H1, then the converted body. No frontmatter — all
// structural metadata lives in SQLite (state).
export function buildMarkdownBody(sourceUrl: string, title: string, markdown: string): string {
  return `<${sourceUrl}>\n\n# ${title}\n\n${markdown}\n`;
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
  return {
    pageId,
    resolveImage: (filename: string) => attachmentRelativeForPage(pagePath, pageSpace, pageId, filename),
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
  limiter: LimitFunction,
  syncIso: string,
): Promise<{ relPath: string; attachments: string[] }> {
  const spaceKey = page.space?.key ?? 'UNKNOWN';
  const relPath = pickPageRelPath(page, opts.pagesWithChildren, opts.rootPageIds);
  const absPath = join(opts.outputDir, relPath);

  const attachmentRefs: string[] = [];
  const wantAttachments = opts.config.include_attachments;

  const attachments: ConfluenceAttachment[] = wantAttachments ? await opts.client.getAttachments(page.id) : [];
  const attachmentByName = new Map<string, ConfluenceAttachment>();
  for (const a of attachments) attachmentByName.set(a.title, a);

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

  if (wantAttachments) {
    await Promise.all(
      conversion.images.map((img) =>
        limiter(async () => {
          const att = attachmentByName.get(img.filename);
          if (!att) return;
          const downloadHref = att._links?.download;
          if (!downloadHref) return;
          const dest = join(opts.outputDir, attachmentPath(spaceKey, page.id, img.filename));
          try {
            const buf = await opts.client.downloadAttachment(downloadHref);
            await mkdir(dirname(dest), { recursive: true });
            await writeFile(dest, Buffer.from(buf));
            attachmentRefs.push(attachmentPath(spaceKey, page.id, img.filename));
          } catch (err) {
            log.warn({ err, page: page.id, filename: img.filename }, 'attachment download failed');
          }
        }),
      ),
    );
  }

  // Write the raw storage-format HTML next to the .md so reconvert can rebuild the
  // markdown later without re-hitting Confluence.
  const htmlAbsPath = htmlPathFor(absPath);
  const sourceUrl = sourceUrlFor(opts.config.base_url, page.id);
  const mdBody = buildMarkdownBody(sourceUrl, page.title, conversion.markdown);

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(htmlAbsPath, html, 'utf8');
  await writeFile(absPath, mdBody, 'utf8');

  // Quiet "unused" hint — syncIso is part of the public signature for future fields.
  void syncIso;

  return { relPath, attachments: attachmentRefs };
}

// Used if autotune hasn't run yet (or failed) and config has no value.
function fallbackParallelDownloads(): number {
  return Math.min(50, Math.max(4, (cpus()?.length ?? 4) * 2));
}

export async function downloadPages(pages: ConfluencePage[], opts: DownloadOptions, syncIso: string): Promise<DownloadResult> {
  const limit = opts.config.parallel_downloads ?? fallbackParallelDownloads();
  const limiter = pLimit(limit);
  const written: string[] = [];
  const attachments: string[] = [];
  const errors: { id: string; error: unknown }[] = [];
  // Periodic progress: log every Nth successful page so the user knows the
  // sync is making progress even when most output is just retry warnings.
  const PROGRESS_EVERY = 100;
  const total = pages.length;

  await Promise.all(
    pages.map((page) =>
      limiter(async () => {
        try {
          const detailed = page.body?.storage ? page : await opts.client.getPage(page.id);
          const result = await fetchAndWriteOne(detailed, opts, limiter, syncIso);
          written.push(result.relPath);
          attachments.push(...result.attachments);
          // Update state in place.
          const detailedSpace = detailed.space?.key ?? 'UNKNOWN';
          const st: PageState = {
            version: detailed.version?.number ?? 0,
            path: result.relPath,
            title: detailed.title,
            space: detailedSpace,
            ancestors: (detailed.ancestors ?? []).map((a) => a.id),
          };
          opts.state.pages[detailed.id] = st;
          opts.knownPagePaths.set(detailed.id, result.relPath);
          opts.titleIndex.set(titleIndexKey(detailedSpace, detailed.title), detailed.id);
          // Keep the top-of-state counter up to date even mid-sync, so an
          // interrupted run's per-root index file still reflects the true count.
          opts.state.total_pages_downloaded = Object.keys(opts.state.pages).length;

          if (written.length % PROGRESS_EVERY === 0) {
            log.info(
              { downloaded: written.length, of: total, lastId: detailed.id, lastTitle: detailed.title },
              `progress: ${written.length} of ${total} downloaded (last: ${detailed.id} — ${detailed.title})`,
            );
          }
          // Persist after every successful page so an interrupt is recoverable.
          // writeIndex is atomic (.tmp + rename); concurrent calls just clobber
          // each other's renames, which is fine — they all write the same in-memory
          // state object's current snapshot.
          if (opts.flushState) {
            try {
              await opts.flushState();
            } catch (err) {
              log.warn({ err, id: detailed.id }, 'failed to flush state mid-sync (will retry on next page)');
            }
          }
        } catch (err) {
          log.error({ err, id: page.id }, 'page fetch failed');
          errors.push({ id: page.id, error: err });
        }
      }),
    ),
  );

  return { written, attachments, errors };
}
