import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { AdaptiveLimiter } from './adaptive-limiter.ts';
import type { Config } from './config.ts';
import type { ConfluenceClient, ConfluencePage } from './confluence.ts';
import { convertStorageFormat, type InlineCommentAnchor } from './converter.ts';
import { htmlToMarkdown } from './converter.ts';
import { log } from './log.ts';
import { folderIndexPath, htmlPathFor, leafPath, spaceIndexPath } from './pathing.ts';
import type { CommentStub, PageState, StateFile } from './state.ts';

export interface DownloadOptions {
  config: Config;
  // Derived Confluence origin (e.g. https://confluence.example.com). Lives
  // outside `config` because the user no longer writes it directly — the URL
  // resolver builds it from the first root URL's origin and passes it down.
  baseUrl: string;
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
  // Emit one log line per page indicating whether it was created or modified
  // (and by whom). Suppressed on first run / --reset to avoid spamming the
  // log with thousands of lines when every page looks new.
  logPerPage: boolean;
  // Comments observed in this root's enumeration, grouped by container (page)
  // id. Used to render the Comments section in each page's .md and to diff
  // against the persisted CommentStub map for the "needs re-render" decision.
  commentsByPageId: Map<string, ConfluencePage[]>;
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
  comments: number;
}

function yamlString(s: string): string {
  // Cheap YAML string escape: wrap in double quotes, escape backslashes + quotes.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildMarkdownBody(meta: MarkdownMetadata, markdown: string, commentsSection?: string): string {
  const lines = [
    '---',
    `title: ${yamlString(meta.title)}`,
    `version: ${meta.version}`,
    `last_modified: ${meta.last_modified ? yamlString(meta.last_modified) : 'null'}`,
    `last_modified_by: ${meta.last_modified_by ? yamlString(meta.last_modified_by) : 'null'}`,
    `webui_url: ${yamlString(meta.webui_url)}`,
    `comments: ${meta.comments}`,
    '---',
    '',
    `# ${meta.title}`,
    '',
    markdown,
    '',
  ];
  if (commentsSection) {
    lines.push(commentsSection, '');
  }
  return lines.join('\n');
}

// Build the "## Comments" section: inline comments first (each quoted with
// the page text they anchor to), then footer comments. Both groups are
// threaded — replies nest under their parent with deeper headings. Order
// within a group is chronological by version.when, falling back to id so
// the output is deterministic even when the API doesn't return timestamps.
//
// The `anchors` list ties inline comments back to their `[c<n>]` markers in
// the body, so a reader who clicks `[c3]` lands on `<a name="c3">` here.
export function buildCommentsSection(
  comments: ConfluencePage[],
  anchors: InlineCommentAnchor[],
): string {
  if (comments.length === 0) return '';

  // Index for fast lookup; threading walks ancestors → parent comment id.
  const byId = new Map<string, ConfluencePage>();
  for (const c of comments) byId.set(c.id, c);

  // Parent of a comment = nearest comment id in its ancestors chain. Anything
  // that isn't a comment in that chain (the page itself) makes it top-level.
  const parentOf = (c: ConfluencePage): string | null => {
    const chain = c.ancestors ?? [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i]!;
      if (byId.has(a.id)) return a.id;
    }
    return null;
  };

  const childrenOf = new Map<string, ConfluencePage[]>();
  const tops: ConfluencePage[] = [];
  for (const c of comments) {
    const parent = parentOf(c);
    if (parent) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(c);
      childrenOf.set(parent, arr);
    } else {
      tops.push(c);
    }
  }

  const byTimeThenId = (a: ConfluencePage, b: ConfluencePage): number => {
    const ta = a.version?.when ?? '';
    const tb = b.version?.when ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.id.localeCompare(b.id);
  };
  tops.sort(byTimeThenId);
  for (const arr of childrenOf.values()) arr.sort(byTimeThenId);

  const isInline = (c: ConfluencePage): boolean => c.extensions?.location === 'inline';
  const inlineTops = tops.filter(isInline);
  const footerTops = tops.filter((c) => !isInline(c));

  const renderBody = (c: ConfluencePage): string => {
    const html = c.body?.storage?.value ?? '';
    // Reuse the page converter for comment bodies — they're the same storage
    // format. No inline-comment-markers to worry about (comments on comments
    // aren't a thing in Confluence DC).
    return htmlToMarkdown(html).trim();
  };

  const anchorById = new Map<string, InlineCommentAnchor>();
  for (const a of anchors) anchorById.set(a.commentId, a);

  // Render one comment as a heading + body, then recurse into replies with a
  // deeper heading. Heading depth caps at h6 so the output stays valid even
  // for unusually long reply chains.
  const renderComment = (c: ConfluencePage, depth: number, anchorId?: string): string => {
    const headingLevel = Math.min(6, 2 + depth);
    const heading = '#'.repeat(headingLevel);
    const author = c.version?.by?.displayName ?? c.version?.by?.username ?? 'unknown';
    const when = c.version?.when ?? '';
    const anchorPrefix = anchorId ? `<a name="${anchorId}"></a>` : '';
    const headerLine = `${heading} ${anchorPrefix}${author}${when ? ` — ${when}` : ''}`;
    const body = renderBody(c);
    const out: string[] = [headerLine, '', body, ''];
    const replies = childrenOf.get(c.id) ?? [];
    for (const r of replies) out.push(renderComment(r, depth + 1));
    return out.join('\n');
  };

  const parts: string[] = ['## Comments', ''];
  if (inlineTops.length > 0) {
    parts.push('### Inline', '');
    for (const c of inlineTops) {
      const anchor = anchorById.get(c.id);
      const selection = c.extensions?.inlineProperties?.originalSelection ?? anchor?.anchoredText ?? '';
      const anchorId = anchor ? `c${anchor.order}` : undefined;
      if (selection) {
        parts.push(`> ${selection.replace(/\n/g, ' ')}`, '');
      }
      parts.push(renderComment(c, 1, anchorId));
    }
  }
  if (footerTops.length > 0) {
    parts.push('### Thread', '');
    for (const c of footerTops) parts.push(renderComment(c, 1));
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// Diff helper — does the set of (commentId, version) match between persisted
// state and what we just observed? Returns true when anything changed (add,
// remove, version bump). Cheap because both inputs are small.
export function commentsChanged(
  persisted: Record<string, CommentStub>,
  observed: ConfluencePage[],
): boolean {
  const persistedIds = new Set(Object.keys(persisted));
  if (persistedIds.size !== observed.length) return true;
  for (const c of observed) {
    const stub = persisted[c.id];
    if (!stub) return true;
    if (stub.version !== (c.version?.number ?? 0)) return true;
  }
  return false;
}

// Build the persisted stub map from an observed list. Parent-comment id is
// derived the same way as in buildCommentsSection — last comment-typed
// ancestor in the chain, or '' for top-level.
export function buildCommentStubs(observed: ConfluencePage[]): Record<string, CommentStub> {
  const observedIds = new Set(observed.map((c) => c.id));
  const out: Record<string, CommentStub> = {};
  for (const c of observed) {
    let parent = '';
    const chain = c.ancestors ?? [];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (observedIds.has(chain[i]!.id)) {
        parent = chain[i]!.id;
        break;
      }
    }
    out[c.id] = {
      version: c.version?.number ?? 0,
      parent_id: parent,
      location: c.extensions?.location ?? null,
    };
  }
  return out;
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
  // Inline comment ids that exist for this page in the current sync. The
  // converter uses this set to decide which markers to emit as footnotes;
  // markers referring to resolved/deleted comments fall back to plain text.
  inlineCommentIds?: Set<string>;
}): Parameters<typeof convertStorageFormat>[1] {
  const { pageId, pagePath, pageSpace, baseUrl, state, knownPagePaths, titleIndex, inlineCommentIds } = args;
  // pagePath/pageSpace currently only relevant for attachment hrefs, which
  // we now render as absolute Confluence URLs instead of local paths.
  void pagePath;
  void pageSpace;
  return {
    pageId,
    knownInlineCommentIds: inlineCommentIds,
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

  const comments = opts.commentsByPageId.get(page.id) ?? [];
  const inlineIds = new Set(
    comments.filter((c) => c.extensions?.location === 'inline').map((c) => c.id),
  );

  const html = page.body?.storage?.value ?? '';
  const conversion = convertStorageFormat(
    html,
    buildConvertOptions({
      pageId: page.id,
      pagePath: relPath,
      pageSpace: spaceKey,
      baseUrl: opts.baseUrl,
      state: opts.state,
      knownPagePaths: opts.knownPagePaths,
      titleIndex: opts.titleIndex,
      inlineCommentIds: inlineIds,
    }),
  );

  const commentsSection = buildCommentsSection(comments, conversion.inlineCommentAnchors);

  // Write the raw storage-format HTML next to the .md so reconvert can rebuild the
  // markdown later without re-hitting Confluence.
  const htmlAbsPath = htmlPathFor(absPath);
  const mdBody = buildMarkdownBody(
    {
      title: page.title,
      version: page.version?.number ?? 0,
      last_modified: page.version?.when ?? null,
      last_modified_by: page.version?.by?.displayName ?? null,
      webui_url: buildWebUiUrl(opts.baseUrl, page),
      comments: comments.length,
    },
    conversion.markdown,
    commentsSection,
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
          // Capture before state-mutate so we know if this was a creation or
          // a modification — used by the per-page change log below.
          const previouslyKnown = !!opts.state.pages[detailed.id];
          const result = await fetchAndWriteOne(detailed, opts, limiter, syncIso);
          written.push(result.relPath);
          if (opts.logPerPage) {
            const verb = previouslyKnown ? 'modified' : 'created';
            const author = detailed.version?.by?.displayName ?? 'unknown';
            log.info(`[${verb}] "${detailed.title}" (${detailed.id}) by ${author}`);
          }
          // Update state in place.
          const detailedSpace = detailed.space?.key ?? 'UNKNOWN';
          const pageComments = opts.commentsByPageId.get(detailed.id) ?? [];
          opts.state.pages[detailed.id] = {
            version: detailed.version?.number ?? 0,
            path: result.relPath,
            title: detailed.title,
            space: detailedSpace,
            ancestors: (detailed.ancestors ?? []).map((a) => a.id),
            last_modified: detailed.version?.when ?? null,
            last_modified_by: detailed.version?.by?.displayName ?? null,
            webui_url: buildWebUiUrl(opts.baseUrl, detailed),
            comments: buildCommentStubs(pageComments),
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
