import type { WatchEntry } from './config.js';

// Format a JS ISO timestamp into the shape Confluence Server CQL reliably
// accepts: "yyyy-MM-dd HH:mm" — no T, no seconds, no ms, no Z. CQL has no
// way to specify a timezone in the literal; the server interprets it in
// its own configured local timezone. We format using the *client's*
// local timezone (`getHours()` not `getUTCHours()`) on the assumption
// that a single-tenant on-prem Confluence runs in the same timezone as
// the people using it. If client and server are in the same TZ, this
// matches the user's wall-clock expectations exactly. A small 60 s
// back-shift absorbs clock skew.
function formatCQLDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() - 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())} ${pad(shifted.getHours())}:${pad(shifted.getMinutes())}`;
}

function quoteCQLDate(iso: string): string {
  return `"${formatCQLDate(iso).replace(/"/g, '')}"`;
}

export function buildCQL(watch: WatchEntry, sinceIso?: string): string {
  // `watch` is a Confluence page id. Mirror that page and every descendant.
  let base = `(id = ${watch} OR ancestor = ${watch}) AND type = page`;
  if (sinceIso) base += ` AND lastmodified >= ${quoteCQLDate(sinceIso)}`;
  return base;
}

