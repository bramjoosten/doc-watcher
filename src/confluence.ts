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

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.pat}`);
    headers.set('Accept', 'application/json');
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Confluence request failed: ${res.status} ${res.statusText} ${url} :: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  private async requestBinary(path: string): Promise<ArrayBuffer> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
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
    for await (const item of this.paginate<ConfluencePage>(path)) {
      out.push(item);
    }
    log.debug({ cql, count: out.length }, 'cql search');
    return out;
  }

  async getPage(id: string, expand: string[] = ['body.storage', 'version', 'ancestors', 'space']): Promise<ConfluencePage> {
    const params = new URLSearchParams();
    if (expand.length) params.set('expand', expand.join(','));
    const path = `/rest/api/content/${encodeURIComponent(id)}?${params.toString()}`;
    return this.request<ConfluencePage>(path);
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
