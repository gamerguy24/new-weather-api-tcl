// NEXRAD Level II radar — Cloudflare Worker.
//
// A real, curl-able HTTP API. Reuses the exact browser-validated decode/render
// code; adds a Worker-safe S3 listing (no DOMParser) and a CompressionStream
// PNG encoder (no canvas). Decodes only sweep 0 (0.5° reflectivity) to stay
// within the 128 MB isolate memory.
//
//   GET /radar?site=KTLX              -> JSON metadata (+ link to the image)
//   GET /radar?site=KTLX&format=png   -> base-reflectivity PNG
//   GET /radar.png?site=KTLX          -> base-reflectivity PNG
//   GET /sites                        -> sites reporting today (JSON)
//   GET /health                       -> { status: "ok" }
//
// NOTE: the bzip2 decode uses ~1–2 s of CPU, so this needs the Workers PAID
// plan (30 s CPU). The Free plan's 10 ms CPU limit is far too low.

import { decodeLevel2 } from '../../site/js/decoder.js';
import { render } from '../../site/js/render.js';
import { bunzip } from '../../site/vendor/bz2.js';
import { SITES } from '../../site/js/sites.js';
import { encodePNG } from './png.js';

const S3 = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/': return json(indexDoc(url));
        case '/health': return json({ status: 'ok' });
        case '/sites': return await handleSites();
        case '/radar':
        case '/radar.png':
          return await handleRadar(url, ctx);
        default:
          return json({ error: 'not found', see: '/' }, 404);
      }
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

// --------------------------------------------------------------------------

async function handleSites() {
  const codes = await activeSites();
  const sites = codes.map(code => {
    const s = SITES[code];
    return { code, name: s ? s[0] : null, lat: s ? s[1] : null, lon: s ? s[2] : null };
  });
  return json({ count: sites.length, sites });
}

async function handleRadar(url, ctx) {
  const site = (url.searchParams.get('site') || '').toUpperCase();
  let key = url.searchParams.get('key');
  const wantPng = url.pathname === '/radar.png' || url.searchParams.get('format') === 'png';
  const size = clamp(parseInt(url.searchParams.get('size') || '1200', 10) || 1200, 300, 2000);

  if (!key) {
    if (!site) return json({ error: 'missing ?site= (e.g. /radar?site=KTLX)' }, 400);
    key = await latestKey(site);
    if (!key) return json({ error: `no recent data for ${site}` }, 404);
  }
  const siteCode = site || key.split('/')[3] || null;

  // Cache the expensive result per scan key (so repeat hits are cheap).
  const cache = caches.default;
  const cacheUrl = `https://nexrad-cache/${key}?fmt=${wantPng ? 'png' : 'json'}&size=${size}`;
  const cacheKey = new Request(cacheUrl);
  let hit = await cache.match(cacheKey);
  if (hit) return withCORS(hit);

  const buf = await (await fetch(`${S3}/${key}`)).arrayBuffer();
  const dec = decodeLevel2(buf, bunzip, { firstSweepOnly: true });
  const img = render(dec, { size });
  const meta = metadata(siteCode, key, img);

  let resp;
  if (wantPng) {
    const png = await encodePNG(img.rgba, img.width, img.height);
    resp = new Response(png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=120',
        'X-Radar-Bounds': `${meta.bounds.south},${meta.bounds.west},${meta.bounds.north},${meta.bounds.east}`,
        'X-Scan-Time': meta.scanTimeUTC || '',
        ...CORS,
      },
    });
  } else {
    meta.image = `/radar.png?site=${siteCode}&key=${encodeURIComponent(key)}&size=${size}`;
    resp = json(meta, 200, 'public, max-age=120');
  }
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
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

// ---- S3 listing (regex; Workers have no DOMParser) -------------------------

const pad = n => String(n).padStart(2, '0');
function dayPrefixes() {
  const out = [], now = new Date();
  for (let b = 0; b < 2; b++) {
    const d = new Date(now.getTime() - b * 86400000);
    out.push(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`);
  }
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
  for (const day of dayPrefixes()) {
    const { keys } = await listXML({ prefix: `${day}${site}/` });
    const scans = keys.filter(k => !k.endsWith('_MDM')).sort();
    if (scans.length) return scans[scans.length - 1];
  }
  return null;
}

async function activeSites() {
  for (const day of dayPrefixes()) {
    const { prefixes } = await listXML({ prefix: day, delimiter: '/' });
    const codes = prefixes.map(p => p.replace(day, '').replace('/', ''))
      .filter(c => c.length === 4 && /^[A-Za-z]+$/.test(c));
    if (codes.length) return codes.sort();
  }
  return [];
}

function scanTime(key) {
  const m = key.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const [, d, t] = m;
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
    +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)));
}

// ---- helpers ---------------------------------------------------------------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function json(obj, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...CORS },
  });
}

function withCORS(resp) {
  const r = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
  return r;
}

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
