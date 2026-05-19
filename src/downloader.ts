import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import pLimit from 'p-limit';
import type { LimitFunction } from 'p-limit';
import type { Config } from './config.js';
import type { ConfluenceAttachment, ConfluenceClient, ConfluencePage } from './confluence.js';
import { convertStorageFormat } from './converter.js';
import { log } from './log.js';
import {
  attachmentPath,
  attachmentRelativeForPage,
  folderIndexPath,
  leafPath,
  pageBaseName,
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
}

export interface DownloadResult {
  written: string[];
  attachments: string[];
  errors: { id: string; error: unknown }[];
}

function frontmatter(values: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) {
      const arr = v.map((x) => JSON.stringify(x)).join(', ');
      lines.push(`${k}: [${arr}]`);
    } else if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function buildPageUrl(baseUrl: string, page: ConfluencePage): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  const webui = page._links?.webui;
  if (webui) {
    return webui.startsWith('http') ? webui : `${trimmed}${webui.startsWith('/') ? '' : '/'}${webui}`;
  }
  return `${trimmed}/pages/viewpage.action?pageId=${page.id}`;
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
): string {
  const spaceKey = page.space?.key ?? 'UNKNOWN';
  const ancestors = (page.ancestors ?? []).map((a) => ({ id: a.id, title: a.title ?? a.id }));
  // Drop the space root itself if it appears as ancestor.
  const filteredAncestors = ancestors.filter((a) => a.id !== page.id);
  const isSpaceRoot = filteredAncestors.length === 0 && page.title.trim().toLowerCase() === spaceKey.toLowerCase();
  if (isSpaceRoot) return spaceIndexPath(spaceKey);
  if (pagesWithChildren.has(page.id)) {
    return folderIndexPath(spaceKey, filteredAncestors, page.title, page.id);
  }
  return leafPath(spaceKey, filteredAncestors, page.title, page.id);
}

async function fetchAndWriteOne(
  page: ConfluencePage,
  opts: DownloadOptions,
  limiter: LimitFunction,
  syncIso: string,
): Promise<{ relPath: string; attachments: string[] }> {
  const spaceKey = page.space?.key ?? 'UNKNOWN';
  const relPath = pickPageRelPath(page, opts.pagesWithChildren);
  const absPath = join(opts.outputDir, relPath);

  const attachmentRefs: string[] = [];
  const wantAttachments = opts.config.sync.include_attachments;

  const attachments: ConfluenceAttachment[] = wantAttachments ? await opts.client.getAttachments(page.id) : [];
  const attachmentByName = new Map<string, ConfluenceAttachment>();
  for (const a of attachments) attachmentByName.set(a.title, a);

  const html = page.body?.storage?.value ?? '';
  const conversion = convertStorageFormat(html, {
    pageId: page.id,
    resolveImage: (filename) => attachmentRelativeForPage(relPath, spaceKey, page.id, filename),
    resolvePageLink: (ref) => {
      // 1. Title→id map hit → relative local path.
      const targetSpace = ref.spaceKey ?? spaceKey;
      const targetId = opts.titleIndex.get(titleIndexKey(targetSpace, ref.contentTitle));
      if (targetId) {
        const targetPath = opts.knownPagePaths.get(targetId) ?? opts.state.pages[targetId]?.path;
        if (targetPath) return resolveRelativePagePath(relPath, targetPath);
      }
      // 2/3. Out of scope (cross-space or title not found) → absolute Confluence URL.
      const base = opts.config.confluence.base_url.replace(/\/$/, '');
      const titleEnc = encodeURIComponent(ref.contentTitle.replace(/\s+/g, '+'));
      return `${base}/display/${encodeURIComponent(targetSpace)}/${titleEnc}`;
    },
  });

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

  const fm = frontmatter({
    confluence_id: page.id,
    confluence_url: buildPageUrl(opts.config.confluence.base_url, page),
    space: spaceKey,
    title: page.title,
    version: page.version?.number ?? 0,
    last_modified: page.version?.when ?? null,
    ancestors: (page.ancestors ?? []).map((a) => a.id),
    sync_time: syncIso,
  });

  const body = `${fm}# ${page.title}\n\n${conversion.markdown}\n`;
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, body, 'utf8');

  return { relPath, attachments: attachmentRefs };
}

export async function downloadPages(pages: ConfluencePage[], opts: DownloadOptions, syncIso: string): Promise<DownloadResult> {
  const limiter = pLimit(opts.config.sync.parallel_downloads);
  const written: string[] = [];
  const attachments: string[] = [];
  const errors: { id: string; error: unknown }[] = [];

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
        } catch (err) {
          log.error({ err, id: page.id }, 'page fetch failed');
          errors.push({ id: page.id, error: err });
        }
      }),
    ),
  );

  return { written, attachments, errors };
}
