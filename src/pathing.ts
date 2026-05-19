import { posix } from 'node:path';

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

export function attachmentPath(spaceKey: string, pageId: string, filename: string): string {
  return posix.join(spaceKey, 'attachments', pageId, filename);
}

export function attachmentRelativeForPage(pageRelPath: string, spaceKey: string, pageId: string, filename: string): string {
  // Build a relative href from the page's location to the attachment file.
  const pageDir = posix.dirname(pageRelPath);
  const target = attachmentPath(spaceKey, pageId, filename);
  return posix.relative(pageDir, target) || filename;
}
