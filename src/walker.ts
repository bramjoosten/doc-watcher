import type { WatchEntry } from './config.js';

export interface WalkScope {
  watch: WatchEntry;
  cql: string;
}

// Format a JS ISO timestamp into the shape Confluence Server CQL reliably
// accepts: "yyyy-MM-dd HH:mm" — no T, no seconds, no ms, no Z. Server CQL
// interprets the value in the server's local timezone, so we back-shift by
// 60 s to absorb clock-skew + small TZ ambiguity. Worst case we re-fetch a
// minute's worth of unchanged pages; never missed updates.
function formatCQLDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() - 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

function quoteCQLDate(iso: string): string {
  return `"${formatCQLDate(iso).replace(/"/g, '')}"`;
}

export function buildCQL(watch: WatchEntry, sinceIso?: string): string {
  let base = `(id = ${watch.root_page_id} OR ancestor = ${watch.root_page_id}) AND type = page`;
  if (sinceIso) base += ` AND lastmodified >= ${quoteCQLDate(sinceIso)}`;
  return base;
}

export function planScopes(watches: WatchEntry[], sinceIso?: string): WalkScope[] {
  return watches.map((w) => ({ watch: w, cql: buildCQL(w, sinceIso) }));
}
