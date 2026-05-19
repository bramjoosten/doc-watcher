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
  last_sync: string | null;
  last_full_enumeration: string | null;
  pages: Record<string, PageState>;
}

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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
}

// Atomic write: write to a sibling .tmp file, then rename. If the process dies
// mid-write, the original file is intact and the .tmp is orphaned.
export async function writeState(stateDir: string, state: StateFile): Promise<void> {
  const path = stateFilePath(stateDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
