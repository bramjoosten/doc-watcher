import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Schema v2: PageState now carries `space` (used to key the title→id map for ac:link
// resolution). Existing v1 state without `space` will be missing for older entries;
// they are treated as resolvable only after the next page write refreshes them.
export interface PageState {
  version: number;
  path: string;
  title: string;
  space: string;
  ancestors: string[];
}

export interface StateFile {
  last_sync: string | null;
  last_full_enumeration: string | null;
  pages: Record<string, PageState>;
}

const EMPTY: StateFile = { last_sync: null, last_full_enumeration: null, pages: {} };

export function emptyState(): StateFile {
  return { last_sync: null, last_full_enumeration: null, pages: {} };
}

export function stateFilePath(stateDir: string): string {
  return join(stateDir, 'index.json');
}

export async function readState(stateDir: string): Promise<StateFile> {
  const path = stateFilePath(stateDir);
  try {
    const buf = await readFile(path, 'utf8');
    const parsed = JSON.parse(buf) as Partial<StateFile>;
    return {
      last_sync: parsed.last_sync ?? null,
      last_full_enumeration: parsed.last_full_enumeration ?? null,
      pages: parsed.pages ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, pages: {} };
    throw err;
  }
}

export async function writeState(stateDir: string, state: StateFile): Promise<void> {
  const path = stateFilePath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
