import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
// @ts-expect-error - upstream package ships no type declarations
import { gfm } from '@joplin/turndown-plugin-gfm';

interface AttrNode {
  nodeName: string;
  firstChild?: AttrNode | null;
  textContent?: string | null;
  getAttribute?: (name: string) => string | null;
}

export interface ImageRef {
  filename: string;
  alt?: string;
}

export interface PageLinkRef {
  contentTitle: string;
  spaceKey?: string;
  anchor?: string;
}

export interface ConvertOptions {
  pageId: string;
  // Map of (spaceKey|undefined, pageTitle) → relative href used for ac:link[ri:page] resolution.
  resolvePageLink?: (ref: PageLinkRef) => string | undefined;
  // Map of attachment filename → relative href used for ac:image[ri:attachment].
  resolveImage?: (filename: string) => string;
}

export interface ConvertResult {
  markdown: string;
  images: ImageRef[];
  pageLinks: PageLinkRef[];
  unsupportedMacros: string[];
}

const CALLOUT_TYPE_MAP: Record<string, string> = {
  info: 'NOTE',
  note: 'NOTE',
  tip: 'TIP',
  warning: 'WARNING',
  important: 'IMPORTANT',
  caution: 'CAUTION',
};

// Cheerio v1 is ESM and stricter about XML-flavoured input. We use the loader
// in xml-friendly mode so `ac:` / `ri:` namespaced elements survive parsing.
function loadStorageFormat(html: string) {
  return cheerio.load(`<root>${html}</root>`, { xml: { decodeEntities: false } });
}

function getMacroParameter($: ReturnType<typeof loadStorageFormat>, macro: cheerio.Cheerio<any>, name: string): string | undefined {
  const param = macro.children(`ac\\:parameter[ac\\:name="${name}"]`).first();
  if (param.length === 0) return undefined;
  return param.text();
}

// plain-text-body wraps content in CDATA — cheerio's .html() returns the literal CDATA marker,
// so we read the decoded text instead. rich-text-body holds real XHTML, so we keep .html().
function getPlainTextBody(macro: cheerio.Cheerio<any>): string {
  const body = macro.children('ac\\:plain-text-body').first();
  if (body.length === 0) return '';
  return body.text();
}

function getRichTextBody(macro: cheerio.Cheerio<any>): string {
  const body = macro.children('ac\\:rich-text-body').first();
  if (body.length === 0) return '';
  return body.html() ?? '';
}

export function preprocessStorageFormat(
  html: string,
  opts: ConvertOptions,
): { html: string; images: ImageRef[]; pageLinks: PageLinkRef[]; unsupportedMacros: string[] } {
  const $ = loadStorageFormat(html);
  const images: ImageRef[] = [];
  const pageLinks: PageLinkRef[] = [];
  const unsupportedMacros: string[] = [];

  $('ac\\:structured-macro').each((_, el) => {
    const macro = $(el);
    const name = (macro.attr('ac:name') ?? '').toLowerCase();
    if (name === 'code') {
      const lang = getMacroParameter($, macro, 'language') ?? '';
      const body = getPlainTextBody(macro) || getRichTextBody(macro);
      const pre = $('<pre/>');
      const code = $('<code/>');
      if (lang) code.attr('class', `language-${lang}`);
      code.text(body);
      pre.append(code);
      macro.replaceWith(pre);
      return;
    }
    if (name in CALLOUT_TYPE_MAP) {
      const calloutType = CALLOUT_TYPE_MAP[name]!;
      const body = getRichTextBody(macro) || getPlainTextBody(macro);
      const blockquote = $(`<blockquote data-callout="${calloutType}"></blockquote>`);
      blockquote.html(body);
      macro.replaceWith(blockquote);
      return;
    }
    unsupportedMacros.push(name || '(unnamed)');
    macro.replaceWith(`<!-- unsupported macro: ${name || '(unnamed)'} -->`);
  });

  $('ac\\:image').each((_, el) => {
    const node = $(el);
    const alt = node.attr('ac:alt') ?? node.attr('alt') ?? '';
    const attachment = node.find('ri\\:attachment').first();
    const url = node.find('ri\\:url').first();
    let src = '';
    if (attachment.length > 0) {
      const filename = attachment.attr('ri:filename') ?? '';
      if (filename) {
        images.push({ filename, alt });
        src = opts.resolveImage ? opts.resolveImage(filename) : `attachments/${opts.pageId}/${filename}`;
      }
    } else if (url.length > 0) {
      src = url.attr('ri:value') ?? '';
    }
    const img = $('<img/>');
    if (src) img.attr('src', src);
    if (alt) img.attr('alt', alt);
    node.replaceWith(img);
  });

  $('ac\\:link').each((_, el) => {
    const node = $(el);
    const ripage = node.find('ri\\:page').first();
    const linkBody = node.find('ac\\:link-body, ac\\:plain-text-link-body').first();
    let label = linkBody.text().trim();
    let href = '';
    if (ripage.length > 0) {
      const contentTitle = ripage.attr('ri:content-title') ?? '';
      const spaceKey = ripage.attr('ri:space-key');
      const anchor = node.attr('ac:anchor');
      const ref: PageLinkRef = { contentTitle, spaceKey, anchor };
      pageLinks.push(ref);
      const resolved = opts.resolvePageLink?.(ref);
      href = resolved ?? '';
      if (!label) label = contentTitle;
    } else {
      const url = node.find('ri\\:url').first();
      if (url.length > 0) href = url.attr('ri:value') ?? '';
    }
    const a = $('<a/>');
    a.attr('href', href || '#');
    a.text(label || href || '');
    node.replaceWith(a);
  });

  // Strip remaining ac:/ri: tags so turndown produces clean output.
  $('ac\\:emoticon, ac\\:placeholder, ac\\:task-list, ac\\:inline-comment-marker').each((_, el) => {
    const node = $(el);
    node.replaceWith(node.text());
  });

  const root = $('root').first();
  return { html: root.html() ?? '', images, pageLinks, unsupportedMacros };
}

export function buildTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);

  td.addRule('confluence-fenced-code', {
    filter: (node) => node.nodeName === 'PRE' && (node as unknown as AttrNode).firstChild?.nodeName === 'CODE',
    replacement: (_content, node) => {
      const codeEl = (node as unknown as AttrNode).firstChild ?? null;
      const className = codeEl?.getAttribute?.('class') ?? '';
      const langMatch = /language-([\w+-]+)/.exec(className);
      const lang = langMatch?.[1] ?? '';
      const text = codeEl?.textContent ?? '';
      return `\n\n\`\`\`${lang}\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    },
  });

  td.addRule('confluence-callout', {
    filter: (node) =>
      node.nodeName === 'BLOCKQUOTE' && (node as unknown as AttrNode).getAttribute?.('data-callout') != null,
    replacement: (content, node) => {
      const type = (node as unknown as AttrNode).getAttribute?.('data-callout') ?? 'NOTE';
      const lines = content.trim().split('\n');
      const body = lines.map((l) => `> ${l}`).join('\n');
      return `\n\n> [!${type}]\n${body}\n\n`;
    },
  });

  return td;
}

export function convertStorageFormat(html: string, opts: ConvertOptions): ConvertResult {
  const pre = preprocessStorageFormat(html, opts);
  const td = buildTurndown();
  const markdown = td.turndown(pre.html).trim();
  return {
    markdown,
    images: pre.images,
    pageLinks: pre.pageLinks,
    unsupportedMacros: pre.unsupportedMacros,
  };
}
