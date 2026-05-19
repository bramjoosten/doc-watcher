import type { WatchEntry } from './config.js';

export interface WalkScope {
  watch: WatchEntry;
  cql: string;
}

function quoteIso(iso: string): string {
  // Confluence CQL accepts ISO timestamps in double quotes.
  return `"${iso.replace(/"/g, '')}"`;
}

export function buildCQL(watch: WatchEntry, sinceIso?: string): string {
  let base: string;
  if (watch.type === 'space') {
    base = `space = "${watch.key}" AND type = page`;
  } else {
    base = `(id = ${watch.root_page_id} OR ancestor = ${watch.root_page_id}) AND type = page`;
  }
  if (sinceIso) {
    base += ` AND lastmodified >= ${quoteIso(sinceIso)}`;
  }
  return base;
}

export function planScopes(watches: WatchEntry[], sinceIso?: string): WalkScope[] {
  return watches.map((w) => ({ watch: w, cql: buildCQL(w, sinceIso) }));
}
