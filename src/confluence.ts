import { log } from './log.js';

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
}

export interface PageSpace {
  key: string;
  name?: string;
}

export interface PageBody {
  storage?: { value: string; representation: string };
}

export interface ConfluencePage {
  id: string;
  type: string;
  title: string;
  space?: PageSpace;
  version?: PageVersion;
  ancestors?: PageAncestor[];
  body?: PageBody;
  _links?: { webui?: string; self?: string; base?: string };
}

export interface ConfluenceAttachment {
  id: string;
  title: string;
  version?: PageVersion;
  extensions?: { mediaType?: string; fileSize?: number };
  _links?: { download?: string };
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
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status !== 503) {
        // Confluence sends X-RateLimit-* headers on EVERY authenticated
        // response. Snag them so the limiter can throttle proactively before
        // we deplete the bucket and trigger an actual 429.
        this.notifyBudget(res.headers);
        if (backedOff && res.ok) {
          this.requestsRecoveredAfterBackoff++;
          log.info(
            { url: shortUrl, attempts: attempt + 1 },
            `recovered after backoff: ${shortUrl} succeeded on attempt ${attempt + 1}`,
          );
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
        log.warn(
          { status: res.status, url: shortUrl, attempt: attempt + 1, waitMs, body: bodySnippet || undefined },
          `rate limited (${res.status} ${res.statusText}) for ${shortUrl}: ${bodySnippet || '(no body)'} — backing off ${waitMs}ms`,
        );
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

  private async requestBinary(path: string): Promise<ArrayBuffer> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${this.pat}` },
    });
    if (!res.ok) {
      throw new Error(`Confluence binary fetch failed: ${res.status} ${res.statusText} ${url}`);
    }
    return await res.arrayBuffer();
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

  async searchByCQL(cql: string, expand: string[] = ['version']): Promise<ConfluencePage[]> {
    const params = new URLSearchParams();
    params.set('cql', cql);
    params.set('limit', '100');
    if (expand.length) params.set('expand', expand.join(','));
    const path = `/rest/api/content/search?${params.toString()}`;
    const out: ConfluencePage[] = [];
    log.info({ cql }, 'asking Confluence for the list of pages in scope — this can take a while for big subtrees');
    const started = Date.now();
    for await (const item of this.paginate<ConfluencePage>(path)) {
      out.push(item);
      // Pagination batches are 100 (limit param). Log every batch so the user
      // sees progress instead of a silent hang.
      if (out.length % 100 === 0) {
        log.info({ pagesListed: out.length, elapsedMs: Date.now() - started }, `${out.length} pages listed so far`);
      }
    }
    log.info(
      { cql, total: out.length, elapsedMs: Date.now() - started },
      `Confluence returned ${out.length} pages in ${Date.now() - started}ms`,
    );
    return out;
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

  async getAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    const path = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?expand=version&limit=100`;
    const out: ConfluenceAttachment[] = [];
    for await (const item of this.paginate<ConfluenceAttachment>(path)) {
      out.push(item);
    }
    return out;
  }

  async downloadAttachment(downloadPath: string): Promise<ArrayBuffer> {
    return this.requestBinary(downloadPath);
  }
}
