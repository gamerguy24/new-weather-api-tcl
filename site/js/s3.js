// Browser-side access to the public NEXRAD Level II bucket. No AWS account and
// no backend needed: the bucket serves anonymous GETs with permissive CORS
// (Access-Control-Allow-Origin: *), so we list and download straight from S3.

const BASE = 'https://unidata-nexrad-level2.s3.amazonaws.com';

function pad(n) { return String(n).padStart(2, '0'); }

async function listPrefix(prefix, delimiter) {
  // S3 REST ListObjectsV2. Returns { keys, prefixes } and follows pagination.
  const keys = [], prefixes = [];
  let token = null;
  do {
    const u = new URL(BASE + '/');
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix);
    if (delimiter) u.searchParams.set('delimiter', delimiter);
    if (token) u.searchParams.set('continuation-token', token);
    const res = await fetch(u);
    if (!res.ok) throw new Error('S3 list failed: ' + res.status);
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    for (const c of xml.getElementsByTagName('Contents'))
      keys.push(c.getElementsByTagName('Key')[0].textContent);
    for (const p of xml.getElementsByTagName('CommonPrefixes'))
      prefixes.push(p.getElementsByTagName('Prefix')[0].textContent);
    const t = xml.getElementsByTagName('NextContinuationToken')[0];
    token = t ? t.textContent : null;
  } while (token);
  return { keys, prefixes };
}

// UTC day prefixes: today, then yesterday (handles just-past-midnight UTC).
function dayPrefixes() {
  const out = [];
  const now = new Date();
  for (let back = 0; back < 2; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    out.push(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`);
  }
  return out;
}

export async function latestKey(site) {
  for (const day of dayPrefixes()) {
    const { keys } = await listPrefix(`${day}${site}/`);
    const scans = keys.filter(k => !k.endsWith('_MDM')).sort();
    if (scans.length) return scans[scans.length - 1];
  }
  return null;
}

export async function activeSites() {
  for (const day of dayPrefixes()) {
    const { prefixes } = await listPrefix(day, '/');
    const codes = prefixes
      .map(p => p.replace(day, '').replace('/', ''))
      .filter(c => c.length === 4 && /^[A-Za-z]+$/.test(c));
    if (codes.length) return codes.sort();
  }
  return [];
}

export async function downloadScan(key, onProgress) {
  const res = await fetch(`${BASE}/${key}`);
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !onProgress) return await res.arrayBuffer();
  // Stream so we can show a progress bar for the ~8 MB file.
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(received / total);
  }
  const buf = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf.buffer;
}

export function scanTimeUTC(key) {
  // .../KTLX20260718_020634_V06 -> Date
  const m = key.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const [_, d, t] = m;
  return new Date(Date.UTC(
    +d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)));
}
