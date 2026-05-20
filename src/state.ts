import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface PageState {
  version: number;
  path: string;
  title: string;
  space: string;
  ancestors: string[];
}

export interface StateFile {
  // Top-of-file counters for quick eyeball-verification. The `pages` map below
  // gets large; these keep the high-level numbers visible at the top of the
  // file without having to parse anything. JSON.stringify preserves insertion
  // order, so as long as these stay declared first, they serialise first too.
  total_watched_pages_on_remote: number;
  total_pages_downloaded: number;
  last_sync: string | null;
  last_full_enumeration: string | null;
  pages: Record<string, PageState>;
}

export function emptyState(): StateFile {
  return {
    total_watched_pages_on_remote: 0,
    total_pages_downloaded: 0,
    last_sync: null,
    last_full_enumeration: null,
    pages: {},
  };
}

// State lives inside the output directory — hidden by the leading dot so it
// doesn't clutter the docs tree, and so a `cp -r docs/ elsewhere/` carries
// the state with it.
export function stateFilePath(outputDir: string): string {
  return join(outputDir, '.state.json');
}

export async function readState(outputDir: string): Promise<StateFile> {
  const path = stateFilePath(outputDir);
  try {
    const buf = await readFile(path, 'utf8');
    const parsed = JSON.parse(buf) as Partial<StateFile>;
    return {
      total_watched_pages_on_remote: parsed.total_watched_pages_on_remote ?? 0,
      total_pages_downloaded: parsed.total_pages_downloaded ?? 0,
      last_sync: parsed.last_sync ?? null,
      last_full_enumeration: parsed.last_full_enumeration ?? null,
      pages: parsed.pages ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
}

// Atomic write: write to a sibling .tmp file, then rename. If the process dies
// mid-write, the original file is intact and the .tmp is orphaned.
export async function writeState(outputDir: string, state: StateFile): Promise<void> {
  const path = stateFilePath(outputDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
