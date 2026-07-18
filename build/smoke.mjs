// Pure-Node smoke test (no Python): download the latest KTLX Level II scan over
// HTTPS and decode + render it with the shipped site modules, then write a PNG.
// Run: node smoke.mjs [SITE]
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { bunzip } from '../site/vendor/bz2.js';
import { decodeLevel2 } from '../site/js/decoder.js';
import { render } from '../site/js/render.js';

const BASE = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const SITE = (process.argv[2] || 'KTLX').toUpperCase();
const pad = n => String(n).padStart(2, '0');

async function latestKey(site) {
  const now = new Date();
  for (let back = 0; back < 2; back++) {
    const d = new Date(now - back * 86400000);
    const day = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`;
    const xml = await (await fetch(`${BASE}/?list-type=2&prefix=${day}${site}/`)).text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]).filter(k => !k.endsWith('_MDM'));
    if (keys.length) return keys.sort().pop();
  }
  return null;
}

function encodePNG(rgba, w, h) {
  const crc32 = b => { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([t, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const key = await latestKey(SITE);
if (!key) { console.error('no recent data for', SITE); process.exit(1); }
console.log('latest key:', key);
const ab = await (await fetch(`${BASE}/${key}`)).arrayBuffer();
console.log('downloaded bytes:', ab.byteLength);

const t0 = Date.now();
const dec = decodeLevel2(ab, bunzip);
const t1 = Date.now();
const img = render(dec, { size: 1000 });
const t2 = Date.now();

let mn = Infinity, mx = -Infinity, n = 0;
for (let i = 0; i < dec.ref.length; i++) { const v = dec.ref[i]; if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; n++; } }
console.log(`decode ${t1 - t0}ms, render ${t2 - t1}ms`);
console.log(`radials=${dec.nRadials} gates=${dec.numGates} site=${dec.siteLat.toFixed(4)},${dec.siteLon.toFixed(4)}`);
console.log(`dBZ min/max=${mn}/${mx} valid=${n}`);
console.assert(dec.nRadials === 720, 'expected 720 radials');
console.assert(dec.numGates === 1832, 'expected 1832 gates');
writeFileSync('smoke.png', encodePNG(img.rgba, img.width, img.height));
console.log('wrote smoke.png — OK');
