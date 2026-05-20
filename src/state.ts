import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { slugify } from './pathing.js';

export interface PageState {
  version: number;
  path: string;
  title: string;
  space: string;
  ancestors: string[];
  last_modified: string | null;       // ISO timestamp from page.version.when
  last_modified_by: string | null;    // displayName from page.version.by
  webui_url: string;                  // full clickable URL — base + /display/...
}

export interface StateFile {
  // Top-of-file counters for quick eyeball-verification.
  total_watched_pages_on_remote: number;
  total_pages_downloaded: number;
  // Identification of the root subtree this index represents.
  root_page_id: string;
  root_title: string;
  last_sync: string | null;
  last_full_enumeration: string | null;
  pages: Record<string, PageState>;
}

export function emptyState(rootId: string, rootTitle: string): StateFile {
  return {
    total_watched_pages_on_remote: 0,
    total_pages_downloaded: 0,
    root_page_id: rootId,
    root_title: rootTitle,
    last_sync: null,
    last_full_enumeration: null,
    pages: {},
  };
}

// Filename convention: `index-<slug>--<id>.json`. Slug is for readability,
// id is the durable anchor so a title change just renames the file without
// losing state. Glob by the `--<id>.json` suffix to find an existing index
// when we don't know the current title yet.
export function indexFileName(rootId: string, rootTitle: string): string {
  return `index-${slugify(rootTitle)}--${rootId}.json`;
}

export async function findExistingIndexFile(outputDir: string, rootId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const suffix = `--${rootId}.json`;
  const matches = entries.filter((e) => e.startsWith('index-') && e.endsWith(suffix));
  if (matches.length === 0) return null;
  // If a past title change orphaned older index files, prefer the lexically-last
  // match (titles are usually stable; this just gives deterministic behavior).
  matches.sort();
  return join(outputDir, matches[matches.length - 1]!);
}

export async function readIndex(filePath: string, rootId: string, rootTitle: string): Promise<StateFile> {
  let state: StateFile;
  try {
    const buf = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(buf) as Partial<StateFile>;
    state = {
      total_watched_pages_on_remote: parsed.total_watched_pages_on_remote ?? 0,
      total_pages_downloaded: parsed.total_pages_downloaded ?? 0,
      root_page_id: parsed.root_page_id ?? rootId,
      root_title: parsed.root_title ?? rootTitle,
      last_sync: parsed.last_sync ?? null,
      last_full_enumeration: parsed.last_full_enumeration ?? null,
      pages: parsed.pages ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    state = emptyState(rootId, rootTitle);
  }
  // If a .jsonl from a previously interrupted sync exists, overlay each line
  // into pages (last-wins by id) before returning. This restores any pages
  // that were written but not yet collapsed into the .json snapshot.
  await overlayJsonl(jsonlPathFromIndexPath(filePath), state);
  return state;
}

// Atomic write: write to a sibling .tmp file, then rename. If the process dies
// mid-write, the original file is intact and the .tmp is orphaned.
export async function writeIndex(filePath: string, state: StateFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

// ── JSONL append-log for cheap per-page persistence during a sync ──────────
//
// Writing the full .json snapshot on every page flush was ~2 MB per page for
// large states — gross at 10k pages. Instead, each per-page flush appends a
// single line to a sibling `.jsonl` (one PageState entry per line). At the
// end of a successful sync, `finalizeIndex` collapses the in-memory state
// into a fresh `.json` and deletes the `.jsonl`. If a sync is interrupted,
// the `.jsonl` persists; the next `readIndex` overlays its lines onto the
// `.json` (last-wins by id) to recover.

export function jsonlPathFromIndexPath(indexPath: string): string {
  return indexPath.replace(/\.json$/, '.jsonl');
}

export async function appendIndexEntry(jsonlPath: string, id: string, page: PageState): Promise<void> {
  await mkdir(dirname(jsonlPath), { recursive: true });
  // One JSON object per line: { id, ...page }. Read-side splits by newline,
  // parses each line, and last-occurrence-wins by id.
  await appendFile(jsonlPath, `${JSON.stringify({ id, ...page })}\n`, 'utf8');
}

async function overlayJsonl(jsonlPath: string, state: StateFile): Promise<void> {
  let content: string;
  try {
    content = await readFile(jsonlPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { id: string } & PageState;
      const { id, ...page } = obj;
      state.pages[id] = page;
    } catch {
      // Corrupted line (e.g. partial write at interrupt). Skip; next sync
      // will rewrite the missing page entry.
    }
  }
  state.total_pages_downloaded = Object.keys(state.pages).length;
}

// Collapse the current in-memory state into a fresh .json snapshot and
// delete the .jsonl. Call at the end of a per-root sync.
export async function finalizeIndex(filePath: string, state: StateFile): Promise<void> {
  await writeIndex(filePath, state);
  await rm(jsonlPathFromIndexPath(filePath), { force: true });
}

// Derived view of the subtree, written next to the index so the user can
// navigate the page hierarchy via IDE code-folding. Same per-root scoping
// as the index; filename derives from the index path so a title-rename
// keeps both files together.
export interface TreeNode {
  id: string;
  title: string;
  path: string;
  children: TreeNode[];
}

export function treePathFromIndexPath(indexPath: string): string {
  // index-<slug>--<id>.json → tree-<slug>--<id>.json (preserves the dir + suffix)
  return indexPath.replace(/(^|\/)index-([^/]+)$/, '$1tree-$2');
}

export function buildTree(state: StateFile): TreeNode | null {
  const rootId = state.root_page_id;
  const rootPage = state.pages[rootId];
  if (!rootPage) return null;

  // Map immediate parent → child ids in one pass; tree build is then O(n).
  const childrenOf = new Map<string, string[]>();
  for (const [id, page] of Object.entries(state.pages)) {
    const parentId = page.ancestors[page.ancestors.length - 1];
    if (!parentId) continue;
    const arr = childrenOf.get(parentId) ?? [];
    arr.push(id);
    childrenOf.set(parentId, arr);
  }

  const node = (id: string): TreeNode => {
    const page = state.pages[id]!;
    const childIds = (childrenOf.get(id) ?? []).slice().sort((a, b) => {
      const ta = state.pages[a]?.title ?? a;
      const tb = state.pages[b]?.title ?? b;
      return ta.localeCompare(tb);
    });
    return { id, title: page.title, path: page.path, children: childIds.map(node) };
  };

  return node(rootId);
}

export async function writeTree(treePath: string, tree: TreeNode): Promise<void> {
  await mkdir(dirname(treePath), { recursive: true });
  const tmp = `${treePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
  await rename(tmp, treePath);
}
