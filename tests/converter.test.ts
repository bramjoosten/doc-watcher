import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertStorageFormat } from '../src/converter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

async function fixture(name: string): Promise<string> {
  return await readFile(join(fixturesDir, name), 'utf8');
}

describe('converter', () => {
  it('converts code macro to fenced block with language', async () => {
    const xhtml = await fixture('code-macro.xhtml');
    const out = convertStorageFormat(xhtml, { pageId: '1' });
    expect(out.markdown).toContain('```typescript');
    expect(out.markdown).toContain('const greet =');
    expect(out.markdown).toContain('```');
    expect(out.unsupportedMacros).toEqual([]);
  });

  it('converts info macro to GFM-style callout blockquote', async () => {
    const xhtml = await fixture('info-callout.xhtml');
    const out = convertStorageFormat(xhtml, { pageId: '1' });
    expect(out.markdown).toContain('> [!NOTE]');
    expect(out.markdown).toContain('rate-limited');
  });

  it('rewrites ac:image with ri:attachment to a markdown image referencing attachments dir', async () => {
    const xhtml = await fixture('ac-image.xhtml');
    const out = convertStorageFormat(xhtml, { pageId: '42' });
    expect(out.images).toEqual([{ filename: 'diagram.png', alt: 'System architecture' }]);
    expect(out.markdown).toMatch(/!\[System architecture\]\(attachments\/42\/diagram\.png\)/);
  });

  it('resolves ac:link with ri:page using resolver, falls back to confluence display URL otherwise', async () => {
    const xhtml = await fixture('ac-link.xhtml');
    const resolved = convertStorageFormat(xhtml, {
      pageId: '1',
      resolvePageLink: (ref) => (ref.contentTitle === 'Setup guide' ? 'ENG/setup-guide--99999.md' : undefined),
    });
    expect(resolved.markdown).toMatch(/\[the setup guide\]\(ENG\/setup-guide--99999\.md\)/);
    expect(resolved.pageLinks[0]?.contentTitle).toBe('Setup guide');

    const unresolved = convertStorageFormat(xhtml, { pageId: '1' });
    expect(unresolved.markdown).toContain('[the setup guide]');
  });

  it('resolves ac:link via a title-id map keyed by `${spaceKey}::${title}`', async () => {
    const xhtml = await fixture('ac-link.xhtml');
    const titleIndex = new Map<string, string>([['ENG::Setup guide', '99999']]);
    const pagePaths = new Map<string, string>([['99999', 'ENG/setup-guide--99999.md']]);
    const out = convertStorageFormat(xhtml, {
      pageId: '1',
      resolvePageLink: (ref) => {
        const id = titleIndex.get(`${ref.spaceKey ?? 'ENG'}::${ref.contentTitle}`);
        return id ? pagePaths.get(id) : undefined;
      },
    });
    expect(out.markdown).toMatch(/\[the setup guide\]\(ENG\/setup-guide--99999\.md\)/);
  });

  it('replaces unknown macros with an inert HTML comment and records the name', async () => {
    const xhtml = await fixture('unknown-macro.xhtml');
    const out = convertStorageFormat(xhtml, { pageId: '1' });
    expect(out.unsupportedMacros).toContain('roadmap');
    expect(out.markdown).toContain('Roadmap:');
    expect(out.markdown).toContain('End.');
  });
});
