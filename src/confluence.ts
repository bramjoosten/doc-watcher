import { log } from './log.ts';

export interface RateLimitBudget {
  limit: number;            // X-RateLimit-Limit
  remaining: number;        // X-RateLimit-Remaining
  intervalSeconds: number;  // X-RateLimit-Interval-Seconds
  fillRate: number;         // X-RateLimit-FillRate
  // Sustainable rate the server actually permits — fillRate / intervalSeconds.
  sustainableRequestsPerSecond: number;
}

export interface ConfluenceClientOptions {
  baseUrl: string;
  pat: string;
  // Notified once per 429-wave (when the cooldown was not already active).
  // Used by the adaptive limiter to halve concurrency and honour Retry-After.
  rateLimitObserver?: {
    report429: (retryAfterMs: number) => void;
    // Called on every successful response carrying X-RateLimit-* headers.
    // Lets the limiter throttle *proactively* before we deplete the bucket.
    reportBudget?: (budget: RateLimitBudget) => void;
  };
}

export interface PageVersion {
  number: number;
  when?: string;
  by?: { username?: string; displayName?: string };
}

export interface PageAncestor {
  id: string;
  title?: string;
  type?: string;
}

export interface PageSpace {
  key: string;
  name?: string;
}

export interface PageBody {
  storage?: { value: string; representation: string };
}

export interface CommentExtensions {
  // 'inline' on inline comments; absent/other on footer comments.
  location?: string;
  // Confluence returns this on inline comments — the page text the comment
  // was anchored to. Lets us render a `> selected text` blockquote next to
  // the comment body without round-tripping through the inline marker.
  inlineProperties?: { originalSelection?: string };
}

export interface ConfluencePage {
  id: string;
  type: string;
  title: string;
  space?: PageSpace;
  version?: PageVersion;
  ancestors?: PageAncestor[];
  body?: PageBody;
  container?: { id: string; type?: string };
  extensions?: CommentExtensions;
  _links?: { webui?: string; self?: string; base?: string };
}

interface ConfluenceListResponse<T> {
  results: T[];
  start: number;
  limit: number;
  size: number;
  _links?: { next?: string; base?: string };
}

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly pat: string;
  // Client-wide cooldown. When any request gets a 429/503 with Retry-After,
  // we set this to (now + waitMs). Every *other* in-flight request checks
  // this before firing and waits out the cooldown. Without it, parallel
  // requests retry independently and pile onto the rate-limited server,
  // turning a single 429 into a cascading storm.
  private throttledUntilMs = 0;

  // Aggregate request-level retry stats. Reset implicitly each runSync by
  // virtue of constructing a new client per run. Exposed so taskmanager can
  // log "of N requests, M had to back off" at end of sync.
  public totalRequests = 0;
  public requestsRecoveredAfterBackoff = 0;
  public requestsFailedAfterRetries = 0;

  private readonly rateLimitObserver?: ConfluenceClientOptions['rateLimitObserver'];

  constructor(opts: ConfluenceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.pat = opts.pat;
    this.rateLimitObserver = opts.rateLimitObserver;
  }

  // Snag X-RateLimit-* headers from a response and forward to the observer.
  // Confluence Server/DC docs:
  //   X-RateLimit-Limit          — bucket capacity
  //   X-RateLimit-Remaining      — tokens available right now
  //   X-RateLimit-Interval-Seconds — refill interval
  //   X-RateLimit-FillRate       — tokens granted per interval
  // Sustainable rate = FillRate / Interval seconds requests per second.
  private notifyBudget(headers: Headers): void {
    if (!this.rateLimitObserver?.reportBudget) return;
    const limit = Number(headers.get('X-RateLimit-Limit'));
    const remaining = Number(headers.get('X-RateLimit-Remaining'));
    const intervalSeconds = Number(headers.get('X-RateLimit-Interval-Seconds'));
    const fillRate = Number(headers.get('X-RateLimit-FillRate'));
    if ([limit, remaining, intervalSeconds, fillRate].some((n) => Number.isNaN(n))) return;
    if (intervalSeconds <= 0) return;
    this.rateLimitObserver.reportBudget({
      limit,
      remaining,
      intervalSeconds,
      fillRate,
      sustainableRequestsPerSecond: fillRate / intervalSeconds,
    });
  }

  // Parse a Retry-After header. Confluence returns either a seconds count or
  // an HTTP-date; both are valid per RFC 7231. Cap the result at 60s so a
  // misbehaving server can't strand us for hours.
  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (!Number.isNaN(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 60_000));
    return null;
  }

  // fetch wrapper that retries 429 and 503 with backoff. Honours Retry-After;
  // falls back to exponential (1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s capped). Max 8
  // retries then returns the last response (the caller's !res.ok branch will throw).
  // Bumped from 5 to 8 to handle sustained throttle storms where the server keeps
  // issuing Retry-After's faster than one request can ride them out.
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    this.totalRequests++;
    let attempt = 0;
    let backedOff = false;
    // For readability in logs, trim the base URL from request URLs.
    const shortUrl = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url;
    while (true) {
      // Honour any client-wide cooldown that a sibling request set.
      const now = Date.now();
      if (now < this.throttledUntilMs) {
        await new Promise<void>((r) => setTimeout(r, this.throttledUntilMs - now));
      }
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        // undici wraps DNS / TCP / TLS failures as `TypeError: fetch failed`
        // and stashes the real error on `.cause`. Surface enough of it to
        // distinguish a typo in base_url (ENOTFOUND) from a firewall block
        // (ECONNREFUSED) from a TLS chain problem (CERT_*). This violates
        // the "one-line, no duplicated data" log convention deliberately —
        // for errors the structured detail is the whole point.
        const cause = (err as { cause?: unknown }).cause;
        const causeErr = cause instanceof Error ? cause : null;
        const causeBag = (cause ?? {}) as Record<string, unknown>;
        const fields = [
          causeErr ? `code=${(causeErr as NodeJS.ErrnoException).code ?? causeErr.name}` : null,
          typeof causeBag.syscall === 'string' ? `syscall=${causeBag.syscall}` : null,
          typeof causeBag.hostname === 'string' ? `hostname=${causeBag.hostname}` : null,
          typeof causeBag.address === 'string' ? `address=${causeBag.address}` : null,
          typeof causeBag.port === 'number' ? `port=${causeBag.port}` : null,
        ].filter(Boolean).join(' ');
        const msg = err instanceof Error ? err.message : String(err);
        const causeMsg = causeErr ? causeErr.message : '';
        log.error(
          `fetch failed for ${url} on attempt ${attempt + 1}: ${msg}${fields ? ` [${fields}]` : ''}${causeMsg ? ` — cause: ${causeMsg}` : ''}`,
        );
        if (causeErr?.stack) log.error(`fetch failure stack:\n${causeErr.stack}`);
        throw err;
      }
      if (res.status !== 429 && res.status !== 503) {
        // Confluence sends X-RateLimit-* headers on EVERY authenticated
        // response. Snag them so the limiter can throttle proactively before
        // we deplete the bucket and trigger an actual 429.
        this.notifyBudget(res.headers);
        if (backedOff && res.ok) {
          this.requestsRecoveredAfterBackoff++;
          log.info(`recovered after backoff: ${shortUrl} succeeded on attempt ${attempt + 1}`);
        }
        return res;
      }
      if (attempt >= 8) {
        if (backedOff) this.requestsFailedAfterRetries++;
        return res;
      }
      backedOff = true;

      // Read the body up-front: it usually carries Confluence's actual
      // explanation (e.g. "Rate limit exceeded for ..."), and reading it
      // here also drains the response for connection reuse.
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
      const bodySnippet = body.slice(0, 160);

      const retryAfter = this.parseRetryAfter(res.headers.get('Retry-After'));
      // Floor the wait at 1s. Confluence sometimes returns `Retry-After: 0`,
      // which without a floor means "immediately re-fire" → another 429.
      const waitMs = Math.max(1000, retryAfter ?? Math.min(60_000, 1000 * 2 ** attempt));

      const cooldownAlreadyActive = Date.now() < this.throttledUntilMs;
      this.throttledUntilMs = Math.max(this.throttledUntilMs, Date.now() + waitMs);
      if (!cooldownAlreadyActive) {
        log.warn(`rate limited (${res.status} ${res.statusText}) for ${shortUrl} on attempt ${attempt + 1}: ${bodySnippet || '(no body)'} — backing off ${waitMs}ms`);
        this.rateLimitObserver?.report429(waitMs);
      }
      await new Promise<void>((r) => setTimeout(r, waitMs));
      attempt++;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, opts: { retry?: boolean } = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.pat}`);
    headers.set('Accept', 'application/json');
    const initWithHeaders = { ...init, headers };
    const res = opts.retry === false
      ? await fetch(url, initWithHeaders)
      : await this.fetchWithRetry(url, initWithHeaders);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Confluence request failed: ${res.status} ${res.statusText} ${url} :: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async *paginate<T>(initialPath: string): AsyncGenerator<T> {
    let next: string | null = initialPath;
    while (next) {
      const page: ConfluenceListResponse<T> = await this.request<ConfluenceListResponse<T>>(next);
      for (const item of page.results) yield item;
      const link = page._links?.next;
      if (!link) {
        next = null;
      } else if (link.startsWith('http')) {
        next = link;
      } else {
        const base = page._links?.base ?? '';
        next = base ? `${base.replace(/\/$/, '')}${link}` : link;
      }
    }
  }

  async getPage(
    id: string,
    expand: string[] = ['body.storage', 'version', 'ancestors', 'space'],
    opts: { retry?: boolean } = {},
  ): Promise<ConfluencePage> {
    const params = new URLSearchParams();
    if (expand.length) params.set('expand', expand.join(','));
    const path = `/rest/api/content/${encodeURIComponent(id)}?${params.toString()}`;
    return this.request<ConfluencePage>(path, undefined, opts);
  }

  // CQL-based page enumeration via /rest/api/content/search. Routes through
  // Lucene, so it's fast (one paginated call per root, ~1 request per 100
  // pages) but limited by index health: brand-new pages may not show up
  // until the background indexer catches up — Atlassian docs put that on
  // the order of an hour for a busy instance. Used by the default `sync`
  // verb. For guaranteed-immediate visibility of new pages, callers should
  // fall back to the DB-backed /child/page walker instead.
  async searchByCQL(cql: string, expand: string[] = ['version']): Promise<ConfluencePage[]> {
    const params = new URLSearchParams();
    params.set('cql', cql);
    params.set('limit', '100');
    if (expand.length) params.set('expand', expand.join(','));
    const path = `/rest/api/content/search?${params.toString()}`;
    const out: ConfluencePage[] = [];
    log.info(`CQL: ${cql}`);
    const started = Date.now();
    for await (const item of this.paginate<ConfluencePage>(path)) {
      out.push(item);
      if (out.length % 100 === 0) {
        log.info(`CQL: ${out.length} pages listed so far (${Date.now() - started}ms elapsed)`);
      }
    }
    log.info(`CQL: ${out.length} pages returned in ${Date.now() - started}ms`);
    return out;
  }

  // Look up a page id by (space, title). Used by the URL resolver for the
  // pretty /display/SPACE/Title URL form, which carries no id. Titles are
  // unique per space in Confluence, so this is a stable lookup. Returns the
  // first match — if Confluence somehow returns more than one we trust its
  // ordering, no way to be smarter without ambiguity.
  async findPageIdByTitle(spaceKey: string, title: string): Promise<string> {
    const params = new URLSearchParams();
    params.set('spaceKey', spaceKey);
    params.set('title', title);
    params.set('limit', '1');
    const path = `/rest/api/content?${params.toString()}`;
    const res = await this.request<ConfluenceListResponse<ConfluencePage>>(path);
    const hit = res.results[0];
    if (!hit) {
      throw new Error(
        `no page titled "${title}" in space "${spaceKey}" — was it renamed? Paste the current URL or use the /pages/viewpage.action?pageId= form.`,
      );
    }
    return hit.id;
  }

  // Resolve a space's homepage to a page id. Used by the URL resolver for
  // /display/<SPACE> and /spaces/viewspace.action?key=<SPACE> URLs.
  async getSpaceHomepageId(spaceKey: string): Promise<string> {
    const path = `/rest/api/space/${encodeURIComponent(spaceKey)}?expand=homepage`;
    const res = await this.request<{ homepage?: { id: string } }>(path);
    if (!res.homepage?.id) {
      throw new Error(`space "${spaceKey}" has no homepage configured — pick a specific page URL instead`);
    }
    return res.homepage.id;
  }

  // All comments under a subtree, one paginated CQL call. Used to fold
  // page discussion into the corresponding .md files. Comment versions are
  // diffed per page just like page bodies, so unchanged comments don't
  // trigger rewrites.
  async searchCommentsBySubtree(rootId: string): Promise<ConfluencePage[]> {
    const cql = `type = comment AND ancestor = ${rootId}`;
    return this.searchByCQL(cql, ['version', 'container', 'ancestors', 'body.storage', 'extensions.location', 'extensions.inlineProperties']);
  }

  // Direct children of a page via Confluence's DB-backed child endpoint.
  // Like /descendant/page this bypasses Lucene, but it's a single
  // parent_id lookup against the content table — much lighter than
  // /descendant/page's ancestor-table join, and importantly doesn't
  // need `expand=ancestors` (which 500'd on /descendant/page for large
  // subtrees because Confluence built the full chain per result).
  // Callers do the recursion + ancestor bookkeeping themselves.
  async getChildPages(parentId: string, expand: string[] = ['version']): Promise<ConfluencePage[]> {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (expand.length) params.set('expand', expand.join(','));
    const path = `/rest/api/content/${encodeURIComponent(parentId)}/child/page?${params.toString()}`;
    const out: ConfluencePage[] = [];
    for await (const item of this.paginate<ConfluencePage>(path)) {
      out.push(item);
    }
    return out;
  }

}
