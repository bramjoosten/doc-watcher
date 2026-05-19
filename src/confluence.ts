import { log } from './log.js';

export interface ConfluenceClientOptions {
  baseUrl: string;
  pat: string;
  verifyTls?: boolean;
}

export interface PageVersion {
  number: number;
  when?: string;
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

  constructor(opts: ConfluenceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.pat = opts.pat;
    if (opts.verifyTls === false) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
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
  // falls back to exponential (1s, 2s, 4s, 8s, 16s, capped at 60s). Max 5 retries
  // then returns the last response (the caller's !res.ok branch will throw).
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    while (true) {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status !== 503) return res;
      if (attempt >= 5) return res;
      const retryAfter = this.parseRetryAfter(res.headers.get('Retry-After'));
      const waitMs = retryAfter ?? Math.min(60_000, 1000 * 2 ** attempt);
      log.warn(
        { status: res.status, url, attempt: attempt + 1, waitMs },
        `rate limited; backing off`,
      );
      // Drain the body so the connection can be reused.
      await res.text().catch(() => '');
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
    log.info({ cql }, 'enumerating pages from Confluence — this can take a while for large scopes');
    const started = Date.now();
    for await (const item of this.paginate<ConfluencePage>(path)) {
      out.push(item);
      // Pagination batches are 100 (limit param). Log every batch so the user
      // sees progress instead of a silent hang.
      if (out.length % 100 === 0) {
        log.info({ enumerated: out.length, elapsedMs: Date.now() - started }, `enumerated ${out.length} pages so far`);
      }
    }
    log.info(
      { cql, total: out.length, elapsedMs: Date.now() - started },
      `enumeration done: ${out.length} pages in ${Date.now() - started}ms`,
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
