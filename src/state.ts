import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

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
  return join(stateDir, 'index.sqlite');
}

function openDb(stateDir: string): Database.Database {
  const path = stateFilePath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pages (
      id              TEXT PRIMARY KEY,
      version         INTEGER NOT NULL,
      path            TEXT NOT NULL,
      title           TEXT NOT NULL,
      space           TEXT NOT NULL,
      ancestors_json  TEXT NOT NULL
    );
  `);
  return db;
}

interface PageRow {
  id: string;
  version: number;
  path: string;
  title: string;
  space: string;
  ancestors_json: string;
}

export async function readState(stateDir: string): Promise<StateFile> {
  const db = openDb(stateDir);
  try {
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));
    const pageRows = db
      .prepare('SELECT id, version, path, title, space, ancestors_json FROM pages')
      .all() as PageRow[];

    const pages: Record<string, PageState> = {};
    for (const r of pageRows) {
      pages[r.id] = {
        version: r.version,
        path: r.path,
        title: r.title,
        space: r.space,
        ancestors: JSON.parse(r.ancestors_json) as string[],
      };
    }

    return {
      last_sync: meta.get('last_sync') ?? null,
      last_full_enumeration: meta.get('last_full_enumeration') ?? null,
      pages,
    };
  } finally {
    db.close();
  }
}

export async function writeState(stateDir: string, state: StateFile): Promise<void> {
  const db = openDb(stateDir);
  try {
    const upsertMeta = db.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const deleteMeta = db.prepare('DELETE FROM meta WHERE key = ?');
    const clearPages = db.prepare('DELETE FROM pages');
    const insertPage = db.prepare(
      'INSERT INTO pages(id, version, path, title, space, ancestors_json) VALUES(?, ?, ?, ?, ?, ?)',
    );

    const tx = db.transaction(() => {
      if (state.last_sync === null) deleteMeta.run('last_sync');
      else upsertMeta.run('last_sync', state.last_sync);

      if (state.last_full_enumeration === null) deleteMeta.run('last_full_enumeration');
      else upsertMeta.run('last_full_enumeration', state.last_full_enumeration);

      clearPages.run();
      for (const [id, p] of Object.entries(state.pages)) {
        insertPage.run(id, p.version, p.path, p.title, p.space, JSON.stringify(p.ancestors));
      }
    });
    tx();
  } finally {
    db.close();
  }
}
