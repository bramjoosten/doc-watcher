import { posix, dirname, resolve, sep } from 'node:path';
import { readdir, rmdir } from 'node:fs/promises';

export function asciiFold(input: string): string {
  return input.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function slugify(title: string): string {
  const folded = asciiFold(title).toLowerCase();
  const replaced = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return replaced || 'untitled';
}

export function pageBaseName(title: string, id: string): string {
  return `${slugify(title)}--${id}`;
}

export function leafFileName(title: string, id: string): string {
  return `${pageBaseName(title, id)}.md`;
}

export function folderIndexPath(spaceKey: string, ancestorTitlesAndIds: { title: string; id: string }[], title: string, id: string): string {
  const segs = [spaceKey, ...ancestorTitlesAndIds.map((a) => pageBaseName(a.title, a.id)), pageBaseName(title, id), '_index.md'];
  return posix.join(...segs);
}

export function leafPath(spaceKey: string, ancestorTitlesAndIds: { title: string; id: string }[], title: string, id: string): string {
  const segs = [spaceKey, ...ancestorTitlesAndIds.map((a) => pageBaseName(a.title, a.id)), leafFileName(title, id)];
  return posix.join(...segs);
}

export function spaceIndexPath(spaceKey: string): string {
  return posix.join(spaceKey, '_index.md');
}

// Given a markdown path (e.g. "ENG/foo--123.md" or "ENG/foo--123/_index.md"),
// return the sibling .html path. Used to write raw Confluence storage-format
// next to every converted .md so the markdown can be re-derived from disk
// (e.g. after a converter improvement) without re-fetching from Confluence.
export function htmlPathFor(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.html');
}

// Walk up from the directory containing `removedFilePath` and rmdir each
// directory that has become empty, stopping at the first non-empty one or
// when we reach `stopAt` (the configured output dir). Used after deleting
// a page's `.md`/`.html` so that a now-empty `<slug>--<id>/` parent folder
// doesn't get left behind, and so chains of nested empty parents collapse
// cleanly when a whole subtree disappears from Confluence.
export async function pruneEmptyParents(removedFilePath: string, stopAt: string): Promise<void> {
  const stop = resolve(stopAt);
  let dir = resolve(dirname(removedFilePath));
  while (dir !== stop && dir.startsWith(stop + sep)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      await rmdir(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}
