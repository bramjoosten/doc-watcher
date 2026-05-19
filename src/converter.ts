import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';

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

function getMacroParameter($: ReturnType<typeof loadStorageFormat>, macro: cheerio.Cheerio<AnyNode>, name: string): string | undefined {
  const param = macro.children(`ac\\:parameter[ac\\:name="${name}"]`).first();
  if (param.length === 0) return undefined;
  return param.text();
}

function getPlainTextBody(macro: cheerio.Cheerio<AnyNode>): string {
  const body = macro.children('ac\\:plain-text-body').first();
  if (body.length === 0) return '';
  return body.text();
}

function getRichTextBody(macro: cheerio.Cheerio<AnyNode>): string {
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

  $('ac\\:emoticon, ac\\:placeholder, ac\\:task-list, ac\\:inline-comment-marker').each((_, el) => {
    const node = $(el);
    node.replaceWith(node.text());
  });

  const root = $('root').first();
  return { html: root.html() ?? '', images, pageLinks, unsupportedMacros };
}

// ─── HTML → Markdown ───────────────────────────────────────────────────────
// Replaces turndown. Walks the cheerio'd DOM and emits markdown directly.
// Scope: the tag set produced by preprocessStorageFormat — p, h1–h6, ul/ol/li
// (with nesting), strong/b, em/i, s/del, code, pre>code (with language hint),
// a, img, blockquote (incl. data-callout), table (GFM), hr, br.

interface RenderCtx {
  listStack: Array<{ ordered: boolean; index: number }>;
}

function isTag(n: AnyNode | undefined | null): n is Element {
  return !!n && n.type === 'tag';
}
function isText(n: AnyNode | undefined | null): n is Text {
  return !!n && n.type === 'text';
}
function tagName(n: Element): string {
  return n.name.toLowerCase();
}

// Escape the chars that markdown would otherwise interpret as syntax in prose.
// Conservative on purpose — over-escaping uglies normal text.
function escapeText(s: string): string {
  return s.replace(/([\\`*_])/g, '\\$1');
}

function renderInline(node: AnyNode, ctx: RenderCtx): string {
  if (isText(node)) return escapeText(node.data);
  if (!isTag(node)) return '';
  const tag = tagName(node);
  const children = () => (node.children ?? []).map((c) => renderInline(c, ctx)).join('');
  switch (tag) {
    case 'strong':
    case 'b':
      return `**${children()}**`;
    case 'em':
    case 'i':
      return `_${children()}_`;
    case 's':
    case 'del':
    case 'strike':
      return `~~${children()}~~`;
    case 'code': {
      const raw = (node.children ?? []).map((c) => (isText(c) ? c.data : '')).join('');
      return `\`${raw}\``;
    }
    case 'a': {
      const href = node.attribs?.href ?? '';
      const text = children() || href;
      return `[${text}](${href})`;
    }
    case 'img': {
      const src = node.attribs?.src ?? '';
      const alt = node.attribs?.alt ?? '';
      return `![${alt}](${src})`;
    }
    case 'br':
      return '  \n';
    case 'span':
    case 'sub':
    case 'sup':
    case 'u':
    case 'mark':
    case 'small':
      return children();
    default:
      return children();
  }
}

function renderBlock(node: AnyNode, ctx: RenderCtx): string {
  if (isText(node)) return /^\s*$/.test(node.data) ? '' : escapeText(node.data);
  if (!isTag(node)) return '';
  const tag = tagName(node);
  const inlineKids = () => (node.children ?? []).map((c) => renderInline(c, ctx)).join('').trim();
  const blockKids = () => (node.children ?? []).map((c) => renderBlock(c, ctx)).join('');

  switch (tag) {
    case 'p':
      return inlineKids() + '\n\n';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number.parseInt(tag.charAt(1), 10);
      return `${'#'.repeat(level)} ${inlineKids()}\n\n`;
    }
    case 'hr':
      return '---\n\n';
    case 'br':
      return '  \n';
    case 'pre': {
      const code = (node.children ?? []).find((c) => isTag(c) && tagName(c) === 'code');
      if (isTag(code)) {
        const className = code.attribs?.class ?? '';
        const langMatch = /language-([\w+-]+)/.exec(className);
        const lang = langMatch?.[1] ?? '';
        const text = (code.children ?? []).map((c) => (isText(c) ? c.data : '')).join('');
        return `\`\`\`${lang}\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
      }
      const text = (node.children ?? []).map((c) => (isText(c) ? c.data : '')).join('');
      return `\`\`\`\n${text.replace(/\n+$/, '')}\n\`\`\`\n\n`;
    }
    case 'blockquote': {
      const callout = node.attribs?.['data-callout'];
      const content = blockKids().trim();
      const quoted = content.split('\n').map((l) => `> ${l}`).join('\n');
      if (callout) return `> [!${callout}]\n${quoted}\n\n`;
      return `${quoted}\n\n`;
    }
    case 'ul':
    case 'ol':
      return renderList(node, ctx, tag === 'ol');
    case 'table':
      return renderTable(node, ctx);
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
      return blockKids();
    // Inline-ish tags showing up as block-level: emit as inline + paragraph break.
    case 'a':
    case 'strong':
    case 'b':
    case 'em':
    case 'i':
    case 'code':
    case 'img':
    case 's':
    case 'del':
    case 'span':
      return renderInline(node, ctx) + '\n\n';
    default:
      return blockKids();
  }
}

function renderList(node: Element, ctx: RenderCtx, ordered: boolean): string {
  ctx.listStack.push({ ordered, index: 0 });
  const indent = '  '.repeat(ctx.listStack.length - 1);
  let out = '';
  for (const child of node.children ?? []) {
    if (!isTag(child) || tagName(child) !== 'li') continue;
    ctx.listStack[ctx.listStack.length - 1]!.index++;
    const marker = ordered ? `${ctx.listStack[ctx.listStack.length - 1]!.index}. ` : '- ';
    // Split the li into inline content vs. nested lists.
    const inlineParts: string[] = [];
    const nestedParts: string[] = [];
    for (const c of child.children ?? []) {
      if (isTag(c) && (tagName(c) === 'ul' || tagName(c) === 'ol')) {
        nestedParts.push(renderList(c, ctx, tagName(c) === 'ol'));
      } else {
        inlineParts.push(renderInline(c, ctx));
      }
    }
    const inlineText = inlineParts.join('').trim();
    out += `${indent}${marker}${inlineText}\n`;
    out += nestedParts.join('');
  }
  ctx.listStack.pop();
  // Trailing blank line only when we close the outermost list.
  return ctx.listStack.length === 0 ? out + '\n' : out;
}

function renderTable(node: Element, ctx: RenderCtx): string {
  const collectRow = (tr: Element): string[] =>
    (tr.children ?? [])
      .filter((c): c is Element => isTag(c) && (tagName(c) === 'td' || tagName(c) === 'th'))
      .map((cell) =>
        renderInline(cell as AnyNode, ctx)
          .trim()
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' '),
      );

  let header: string[] | null = null;
  const rows: string[][] = [];
  for (const child of node.children ?? []) {
    if (!isTag(child)) continue;
    const name = tagName(child);
    if (name === 'thead') {
      for (const tr of child.children ?? []) {
        if (isTag(tr) && tagName(tr) === 'tr') {
          header = collectRow(tr);
          break;
        }
      }
    } else if (name === 'tbody') {
      for (const tr of child.children ?? []) {
        if (isTag(tr) && tagName(tr) === 'tr') rows.push(collectRow(tr));
      }
    } else if (name === 'tr') {
      const row = collectRow(child);
      if (!header) header = row;
      else rows.push(row);
    }
  }

  if (!header || header.length === 0) return '';
  const cols = header.length;
  const lines: string[] = [
    `| ${header.join(' | ')} |`,
    `| ${Array(cols).fill('---').join(' | ')} |`,
  ];
  for (const row of rows) {
    const padded = row.concat(Array(Math.max(0, cols - row.length)).fill(''));
    lines.push(`| ${padded.slice(0, cols).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n\n`;
}

export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(`<root>${html}</root>`, { xml: { decodeEntities: true } });
  const root = $('root')[0];
  if (!isTag(root)) return '';
  const ctx: RenderCtx = { listStack: [] };
  const out = (root.children ?? []).map((c) => renderBlock(c, ctx)).join('');
  // Collapse 3+ newlines to 2, trim leading/trailing whitespace.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function convertStorageFormat(html: string, opts: ConvertOptions): ConvertResult {
  const pre = preprocessStorageFormat(html, opts);
  return {
    markdown: htmlToMarkdown(pre.html),
    images: pre.images,
    pageLinks: pre.pageLinks,
    unsupportedMacros: pre.unsupportedMacros,
  };
}
