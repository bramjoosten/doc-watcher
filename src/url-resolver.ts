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
// either an immediate page id, a "resolve this later" descriptor, or — for
// short links — a "follow the redirect and re-classify" descriptor. The
// network only fires for descriptors, not for URLs that already carry an id.
type Classification =
  | { kind: 'id'; pageId: string }
  | { kind: 'display-page'; spaceKey: string; title: string }
  | { kind: 'space-home'; spaceKey: string }
  | { kind: 'short-link' };

// Pathname normalisation that runs before every regex match:
//   • Strip the /wiki prefix that Confluence Cloud puts on every URL.
//   • Strip a single trailing slash so /spaces/ENG and /spaces/ENG/ match the
//     same regex without each pattern having to repeat `/?` itself.
function normalisePath(pathname: string): string {
  const noWiki = pathname.replace(/^\/wiki(?=\/)/, '');
  if (noWiki.length > 1 && noWiki.endsWith('/')) return noWiki.slice(0, -1);
  return noWiki;
}

function classify(url: URL): Classification | null {
  const path = normalisePath(url.pathname);
  const params = url.searchParams;

  // Any URL carrying a numeric ?pageId= resolves directly. Catches every
  // action endpoint that operates on a single page: viewpage, editpage,
  // copypage, movepage, deletepage, resumedraft, and friends. The exact
  // path doesn't matter — if there's a pageId, that's the page.
  const pageIdParam = params.get('pageId');
  if (pageIdParam && /^\d+$/.test(pageIdParam)) {
    return { kind: 'id', pageId: pageIdParam };
  }

  // Short links — /x/<token> with no query. These are 302 redirects to a
  // canonical page URL; we follow them once, then re-classify the target.
  if (/^\/x\/[A-Za-z0-9_-]+$/.test(path)) {
    return { kind: 'short-link' };
  }

  // /spaces/<SPACE>/pages/<id>[/<slug-or-title>] — the newer "permalink"
  // page URL. Path id wins; we never need the slug.
  const spacesPagesMatch = /^\/spaces\/([^/]+)\/pages\/(\d+)(?:\/|$)/.exec(path);
  if (spacesPagesMatch) return { kind: 'id', pageId: spacesPagesMatch[2]! };

  // /pages/<id> — some Confluence builds expose a flat page-by-id permalink
  // without a space wrapper. Same handling: id wins, ignore anything after.
  const flatPagesMatch = /^\/pages\/(\d+)(?:\/|$)/.exec(path);
  if (flatPagesMatch) return { kind: 'id', pageId: flatPagesMatch[1]! };

  // /spaces/viewspace.action?key=<SPACE> — legacy action-form space home.
  if (path.endsWith('/spaces/viewspace.action')) {
    const key = params.get('key');
    if (key) return { kind: 'space-home', spaceKey: key };
    return null;
  }

  // Newer-UI space-home shapes:
  //   /spaces/<KEY>            — bare space root
  //   /spaces/<KEY>/overview   — explicit overview link
  //   /spaces/<KEY>/pages      — the page-tree view (treated as space home)
  // Must come after the /spaces/<key>/pages/<id> and viewspace.action
  // checks, since [^/]+ would otherwise swallow those keys.
  const spacesHomeMatch = /^\/spaces\/([^/]+)(?:\/(?:overview|pages))?$/.exec(path);
  if (spacesHomeMatch) {
    return { kind: 'space-home', spaceKey: decodeURIComponent(spacesHomeMatch[1]!) };
  }

  // Legacy pretty form. /display/<KEY>/<Title> resolves by title; bare
  // /display/<KEY> is a space homepage. Title is `+`-encoded for spaces;
  // pathname doesn't decode that, so we do it manually.
  const displayMatch = /^\/display\/([^/]+)(?:\/(.+))?$/.exec(path);
  if (displayMatch) {
    const spaceKey = decodeURIComponent(displayMatch[1]!);
    const titleRaw = displayMatch[2];
    if (!titleRaw) return { kind: 'space-home', spaceKey };
    const title = decodeURIComponent(titleRaw.replace(/\+/g, ' '));
    return { kind: 'display-page', spaceKey, title };
  }

  return null;
}

// Follow a /x/<token> short link by issuing a HEAD with manual redirect
// handling and reading the Location header. Recurses once with the
// destination so a target like /pages/viewpage.action?pageId=... or
// /display/<KEY>/<Title> gets classified normally. We cap follows at 3 to
// stop pathological short-link chains from looping the resolver.
async function followShortLink(href: string, depth: number): Promise<string> {
  if (depth > 3) {
    throw new Error(`short link ${href} kept redirecting (>3 hops) — paste the canonical URL instead`);
  }
  const res = await fetch(href, { method: 'HEAD', redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) {
    throw new Error(`short link ${href} did not redirect (status ${res.status}) — paste the canonical URL instead`);
  }
  // Confluence returns absolute URLs in Location for short links, but
  // tolerate the relative form too just in case.
  const target = location.startsWith('http') ? location : new URL(location, href).href;
  return target;
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
  // (display-page, space-home, short-link) and the cost is one request per
  // root, total — not worth parallelising for the rare case of dozens of
  // roots, and sequential keeps error messages tied to the right URL.
  const roots: ResolvedRoot[] = [];
  for (const { href } of parsed) {
    const pageId = await resolveOne(href, client, 0);
    roots.push({ origin: baseUrl, pageId, sourceUrl: href });
  }

  return { baseUrl, roots };
}

async function resolveOne(href: string, client: ConfluenceClient, depth: number): Promise<string> {
  const url = new URL(href);
  const classified = classify(url);
  if (!classified) {
    throw new Error(
      `unrecognised Confluence URL shape: ${href}. Supported: /pages/viewpage.action?pageId=, /spaces/<KEY>/pages/<id>/, /pages/<id>, /spaces/<KEY>/overview, /spaces/<KEY>, /spaces/<KEY>/pages, /display/<KEY>/<Title>, /display/<KEY>, /spaces/viewspace.action?key=<KEY>, /x/<token>. The /wiki prefix (Confluence Cloud) is auto-stripped.`,
    );
  }
  if (classified.kind === 'id') return classified.pageId;
  if (classified.kind === 'display-page') {
    return client.findPageIdByTitle(classified.spaceKey, classified.title);
  }
  if (classified.kind === 'space-home') {
    return client.getSpaceHomepageId(classified.spaceKey);
  }
  // short-link → follow + recurse
  const target = await followShortLink(href, depth);
  return resolveOne(target, client, depth + 1);
}
