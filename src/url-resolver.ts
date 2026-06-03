import type { ConfluenceClient } from './confluence.ts';

// One configured root URL once it's been classified and (if needed)
// resolved to a Confluence page id.
export interface ResolvedRoot {
  // Origin part of the URL — e.g. https://confluence.example.com.
  // All roots in a single config must share an origin (one Confluence per run).
  origin: string;
  // Numeric Confluence page id. For action / spaces-path URLs this is parsed
  // straight out of the URL; for display / space-homepage URLs we ask Confluence.
  pageId: string;
  // The original URL the user pasted, kept for error messages.
  sourceUrl: string;
}

// Classify a Confluence URL into one of the shapes we understand, returning
// either an immediate page id or a "resolve this later" descriptor. Network
// only fires for the descriptor cases (display-with-title, space-homepage).
type Classification =
  | { kind: 'id'; pageId: string }
  | { kind: 'display-page'; spaceKey: string; title: string }
  | { kind: 'space-home'; spaceKey: string };

function classify(url: URL): Classification | null {
  const params = url.searchParams;

  // /pages/viewpage.action?pageId=12345
  if (url.pathname.endsWith('/pages/viewpage.action')) {
    const id = params.get('pageId');
    if (id && /^\d+$/.test(id)) return { kind: 'id', pageId: id };
    return null;
  }

  // /spaces/<SPACE>/pages/<id>/<slug-or-title> — newer Confluence URL style.
  // Path id wins; we never need the slug.
  const spacesPagesMatch = /^\/spaces\/([^/]+)\/pages\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (spacesPagesMatch) return { kind: 'id', pageId: spacesPagesMatch[2]! };

  // /spaces/viewspace.action?key=<SPACE> — space homepage, no page id.
  if (url.pathname.endsWith('/spaces/viewspace.action')) {
    const key = params.get('key');
    if (key) return { kind: 'space-home', spaceKey: key };
    return null;
  }

  // /display/<SPACE>/<Title+With+Pluses> — pretty form. No id in URL; resolve by title.
  // /display/<SPACE> on its own is the space homepage.
  const displayMatch = /^\/display\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
  if (displayMatch) {
    const spaceKey = decodeURIComponent(displayMatch[1]!);
    const titleRaw = displayMatch[2];
    if (!titleRaw) return { kind: 'space-home', spaceKey };
    // Confluence encodes spaces in titles as `+`. URLSearchParams handles that;
    // pathname doesn't, so decode manually.
    const title = decodeURIComponent(titleRaw.replace(/\+/g, ' '));
    return { kind: 'display-page', spaceKey, title };
  }

  return null;
}

export async function resolveRoots(
  rootUrls: string[],
  client: ConfluenceClient,
): Promise<{ baseUrl: string; roots: ResolvedRoot[] }> {
  if (rootUrls.length === 0) {
    throw new Error('roots is empty — add at least one Confluence URL to config.ts');
  }

  // Parse every URL up-front; surface bad URLs before any network work.
  const parsed = rootUrls.map((href) => {
    try {
      return { href, url: new URL(href) };
    } catch {
      throw new Error(`invalid URL in roots: ${href}`);
    }
  });

  // One Confluence per run — auth, limiter, and rate-budget headers are all
  // origin-scoped, so a second origin would silently break those.
  const origins = new Set(parsed.map((p) => p.url.origin));
  if (origins.size > 1) {
    throw new Error(
      `roots span multiple origins (${[...origins].join(', ')}); only one Confluence per run`,
    );
  }
  const baseUrl = parsed[0]!.url.origin;

  // Classify + resolve. Sequential because each step might hit the network
  // (display-page and space-home need one API call) and the cost is one
  // request per root, total — not worth parallelising for the rare case of
  // dozens of roots.
  const roots: ResolvedRoot[] = [];
  for (const { href, url } of parsed) {
    const classified = classify(url);
    if (!classified) {
      throw new Error(
        `unrecognised Confluence URL shape: ${href}. Expected /pages/viewpage.action?pageId=, /spaces/<key>/pages/<id>/, /display/<space>/<title>, /display/<space>, or /spaces/viewspace.action?key=<space>`,
      );
    }
    let pageId: string;
    if (classified.kind === 'id') {
      pageId = classified.pageId;
    } else if (classified.kind === 'display-page') {
      pageId = await client.findPageIdByTitle(classified.spaceKey, classified.title);
    } else {
      pageId = await client.getSpaceHomepageId(classified.spaceKey);
    }
    roots.push({ origin: baseUrl, pageId, sourceUrl: href });
  }

  return { baseUrl, roots };
}
