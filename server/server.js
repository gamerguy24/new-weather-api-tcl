// NEXRAD Level II radar — Node HTTP API (for Render's free Web Service tier).
//
// A real, curl-able HTTP API. Reuses the exact browser-validated decode/render
// code and decodes only sweep 0 (0.5° reflectivity). Unlike Cloudflare's free
// Workers (10 ms CPU cap), a Node web service has no per-request CPU limit, so
// the ~1-2 s bzip2 decode runs fine here.
//
//   GET /radar?site=KTLX              -> JSON metadata for the newest scan
//   GET /radar?site=KTLX&format=png   -> base-reflectivity PNG
//   GET /radar.png?site=KTLX          -> base-reflectivity PNG
//   GET /radar?site=KTLX&size=1600    -> larger image (300..2000, default 1200)
//   GET /radar?key=2026/07/18/KTLX/…  -> a specific scan by S3 key
//   GET /sites                        -> sites reporting today
//   GET /health                       -> { status: "ok" }

import http from 'node:http';
import { deflateSync } from 'node:zlib';
import { decodeLevel2 } from '../site/js/decoder.js';
import { render } from '../site/js/render.js';
import { bunzip } from '../site/vendor/bz2.js';
import { SITES } from '../site/js/sites.js';

const S3 = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const PORT = process.env.PORT || 5000;
const DEFAULT_SIZE = 1000;             // memory/quality balance for a 512 MB box

// Small in-memory cache: expensive render result per scan key.
const cache = new Map();               // cacheKey -> { body, headers }
const CACHE_MAX = 24;
let latestCache = new Map();           // site -> { exp, key }

// Run heavy work one-at-a-time so concurrent requests don't stack memory.
let _chain = Promise.resolve();
function runExclusive(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.then(() => {}, () => {});   // keep the chain alive past errors
  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  cors(res);
  if (req.method === 'OPTIONS') return end(res, 204, {}, '');
  try {
    switch (url.pathname) {
      case '/': return sendJSON(res, 200, indexDoc(url));
      case '/health': return sendJSON(res, 200, { status: 'ok' });
      case '/sites': return await handleSites(res);
      case '/radar':
      case '/radar.png': return await handleRadar(url, res);
      default: return sendJSON(res, 404, { error: 'not found', see: '/' });
    }
  } catch (e) {
    sendJSON(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => console.log(`nexrad radar API listening on :${PORT}`));

// --------------------------------------------------------------------------

async function handleSites(res) {
  const codes = await activeSites();
  const sites = codes.map(code => {
    const s = SITES[code];
    return { code, name: s ? s[0] : null, lat: s ? s[1] : null, lon: s ? s[2] : null };
  });
  sendJSON(res, 200, { count: sites.length, sites });
}

async function handleRadar(url, res) {
  const site = (url.searchParams.get('site') || '').toUpperCase();
  let key = url.searchParams.get('key');
  const wantPng = url.pathname === '/radar.png' || url.searchParams.get('format') === 'png';
  const size = clamp(parseInt(url.searchParams.get('size') || String(DEFAULT_SIZE), 10) || DEFAULT_SIZE, 300, 2000);

  if (!key) {
    if (!site) return sendJSON(res, 400, { error: 'missing ?site= (e.g. /radar?site=KTLX)' });
    key = await latestKey(site);
    if (!key) return sendJSON(res, 404, { error: `no recent data for ${site}` });
  }
  const siteCode = site || key.split('/')[3] || null;
  const cacheKey = `${key}|${wantPng ? 'png' : 'json'}|${size}`;

  const hit = cache.get(cacheKey);
  if (hit) return end(res, 200, hit.headers, hit.body);

  // Serialize the memory-heavy decode so concurrent requests can't stack their
  // ~150 MB transients and blow the 512 MB limit. Queued callers reuse the
  // cache the first one fills.
  const out = await runExclusive(async () => {
    const again = cache.get(cacheKey);
    if (again) return again;

    const buf = await (await fetch(`${S3}/${key}`)).arrayBuffer();
    const dec = decodeLevel2(buf, bunzip, { firstSweepOnly: true });
    const img = render(dec, { size });
    const meta = metadata(siteCode, key, img);

    let headers, body;
    if (wantPng) {
      body = encodePNG(img.rgba, img.width, img.height);
      headers = {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=120',
        'X-Radar-Bounds': `${meta.bounds.south},${meta.bounds.west},${meta.bounds.north},${meta.bounds.east}`,
        'X-Scan-Time': meta.scanTimeUTC || '',
      };
    } else {
      meta.image = `/radar.png?site=${siteCode}&key=${encodeURIComponent(key)}&size=${size}`;
      body = JSON.stringify(meta, null, 2);
      headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' };
    }
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(cacheKey, { headers, body });
    return { headers, body };
  });

  end(res, 200, out.headers, out.body);
}

// --------------------------------------------------------------------------

function metadata(site, key, img) {
  const t = scanTime(key);
  return {
    site, key,
    scanTimeUTC: t ? t.toISOString() : null,
    siteLat: round(img.siteLat, 4), siteLon: round(img.siteLon, 4),
    bounds: {
      south: img.bounds.south, west: img.bounds.west,
      north: img.bounds.north, east: img.bounds.east,
    },
    product: 'base_reflectivity', tilt: 0.5,
    width: img.width, height: img.height,
    range: { numGates: img.numGates, firstGateKm: img.firstGateKm, gateWidthKm: img.gateWidthKm },
  };
}

// ---- PNG (RGBA, 8-bit) via Node zlib ---------------------------------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- S3 listing (regex) ----------------------------------------------------

const pad = n => String(n).padStart(2, '0');
function dayPrefixes() {
  const out = [], now = new Date();
  for (let b = 0; b < 2; b++) { const d = new Date(now.getTime() - b * 86400000); out.push(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`); }
  return out;
}
async function listXML(params) {
  const keys = [], prefixes = [];
  let token = null;
  do {
    const u = new URL(`${S3}/`);
    u.searchParams.set('list-type', '2');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (token) u.searchParams.set('continuation-token', token);
    const xml = await (await fetch(u)).text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(m[1]);
    const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    token = t ? t[1] : null;
  } while (token);
  return { keys, prefixes };
}
async function latestKey(site) {
  const now = Date.now();
  const c = latestCache.get(site);
  if (c && c.exp > now) return c.key;
  for (const day of dayPrefixes()) {
    const { keys } = await listXML({ prefix: `${day}${site}/` });
    const scans = keys.filter(k => !k.endsWith('_MDM')).sort();
    if (scans.length) { const key = scans[scans.length - 1]; latestCache.set(site, { exp: now + 30000, key }); return key; }
  }
  return null;
}
async function activeSites() {
  for (const day of dayPrefixes()) {
    const { prefixes } = await listXML({ prefix: day, delimiter: '/' });
    const codes = prefixes.map(p => p.replace(day, '').replace('/', '')).filter(c => c.length === 4 && /^[A-Za-z]+$/.test(c));
    if (codes.length) return codes.sort();
  }
  return [];
}
function scanTime(key) {
  const m = key.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const [, d, t] = m;
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)));
}

// ---- helpers ---------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); }
function end(res, status, headers, body) { for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v); res.statusCode = status; res.end(body); }
function sendJSON(res, status, obj) { end(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj, null, 2)); }
function indexDoc(url) {
  const base = `${url.protocol}//${url.host}`;
  return {
    service: 'NEXRAD Level II radar API',
    source: 's3://unidata-nexrad-level2 (AWS Open Data)',
    endpoints: {
      'GET /radar?site=KTLX': 'JSON metadata for the newest scan',
      'GET /radar?site=KTLX&format=png': 'base-reflectivity PNG',
      'GET /radar.png?site=KTLX': 'base-reflectivity PNG',
      'GET /sites': 'radar sites reporting today',
      'GET /health': 'liveness check',
    },
    examples: [`${base}/radar?site=KTLX`, `${base}/radar.png?site=KTLX`, `${base}/sites`],
  };
}
