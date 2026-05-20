import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
  try {
    const buf = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(buf) as Partial<StateFile>;
    return {
      total_watched_pages_on_remote: parsed.total_watched_pages_on_remote ?? 0,
      total_pages_downloaded: parsed.total_pages_downloaded ?? 0,
      root_page_id: parsed.root_page_id ?? rootId,
      root_title: parsed.root_title ?? rootTitle,
      last_sync: parsed.last_sync ?? null,
      last_full_enumeration: parsed.last_full_enumeration ?? null,
      pages: parsed.pages ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(rootId, rootTitle);
    throw err;
  }
}

// Atomic write: write to a sibling .tmp file, then rename. If the process dies
// mid-write, the original file is intact and the .tmp is orphaned.
export async function writeIndex(filePath: string, state: StateFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}
