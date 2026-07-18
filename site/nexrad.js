// NEXRAD Level II — static, client-side radar API.
//
// A single ES module you host once and import from any page. It lists radar
// sites, downloads raw Level II volume scans from the public AWS Open Data
// bucket, and decodes + renders base reflectivity entirely in the browser
// (no server, no AWS account). Decoding is validated byte-for-byte vs MetPy.
//
//   import * as NEXRAD from 'https://your-host/nexrad.js';
//   const sites = await NEXRAD.listSites();
//   const scan  = await NEXRAD.getScan('KTLX', { size: 1400 });
//   document.querySelector('img').src = scan.toDataURL();
//   console.log(scan.metadata());
//
// API:
//   listSites()                  -> [{ code, name, lat, lon }]
//   latestKey(site)              -> "YYYY/MM/DD/SITE/…_V06" | null
//   getScan(siteOrKey, opts)     -> Scan       (opts: { size, onProgress, signal })
//   decode(arrayBuffer)          -> Decoded    (low-level, synchronous)
//   render(decoded, { size })    -> { rgba, width, height, bounds, … }
//
// Scan: {
//   site, key, scanTimeUTC, siteLat, siteLon, bounds:{south,west,north,east},
//   product:'base_reflectivity', tilt:0.5, width, height, imageData,
//   toCanvas(), toDataURL(type?), toBlob(type?), metadata()
// }

import { latestKey as _latestKey, activeSites, downloadScan, scanTimeUTC } from './js/s3.js';
import { SITES } from './js/sites.js';
import { decodeLevel2 } from './js/decoder.js';
import { render as _render } from './js/render.js';
import { bunzip } from './vendor/bz2.js';

export const BUCKET = 'unidata-nexrad-level2';
export const DEFAULT_SIZE = 1200;

export async function listSites() {
  const codes = await activeSites();
  return codes.map(code => {
    const s = SITES[code];
    return { code, name: s ? s[0] : null, lat: s ? s[1] : null, lon: s ? s[2] : null };
  });
}

export function latestKey(site) { return _latestKey(String(site).toUpperCase()); }

// Low-level, synchronous (blocks while bzip2 runs). Prefer getScan() in a page.
export function decode(arrayBuffer) { return decodeLevel2(arrayBuffer, bunzip); }
export const render = _render;

export async function getScan(siteOrKey, opts = {}) {
  const size = opts.size || DEFAULT_SIZE;
  let key, site;
  if (String(siteOrKey).includes('/')) {
    key = siteOrKey;
    site = key.split('/')[3] || null;
  } else {
    site = String(siteOrKey).toUpperCase();
    key = await _latestKey(site);
    if (!key) throw new Error('no recent data for ' + site);
  }
  const buf = await downloadScan(key, opts.onProgress);
  if (opts.signal && opts.signal.aborted) throw new Error('aborted');
  const img = await decodeRender(buf, size);
  return makeScan(site, key, img);
}

// ---- rendering result ------------------------------------------------------

function makeScan(site, key, img) {
  const t = scanTimeUTC(key);
  const imageData = new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height);
  return {
    site, key,
    scanTimeUTC: t ? t.toISOString() : null,
    siteLat: img.siteLat, siteLon: img.siteLon,
    bounds: img.bounds,
    product: 'base_reflectivity', tilt: 0.5,
    width: img.width, height: img.height,
    range: { numGates: img.numGates, firstGateKm: img.firstGateKm, gateWidthKm: img.gateWidthKm },
    imageData,
    toCanvas() {
      const c = (typeof OffscreenCanvas !== 'undefined' && !this._domWanted)
        ? new OffscreenCanvas(img.width, img.height)
        : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      c.getContext('2d').putImageData(imageData, 0, 0);
      return c;
    },
    toDataURL(type = 'image/png') {
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      c.getContext('2d').putImageData(imageData, 0, 0);
      return c.toDataURL(type);
    },
    toBlob(type = 'image/png') {
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      c.getContext('2d').putImageData(imageData, 0, 0);
      return new Promise(res => c.toBlob(res, type));
    },
    metadata() {
      return {
        site, key, scanTimeUTC: this.scanTimeUTC,
        siteLat: img.siteLat, siteLon: img.siteLon, bounds: img.bounds,
        product: 'base_reflectivity', tilt: 0.5,
        width: img.width, height: img.height, range: this.range,
      };
    },
  };
}

// ---- worker plumbing (with main-thread fallback) ---------------------------

let _worker = null, _seq = 0;
const _pending = new Map();

function getWorker() {
  if (_worker) return _worker;
  try {
    _worker = new Worker(new URL('./nexrad.worker.js', import.meta.url), { type: 'module' });
    _worker.onmessage = (e) => {
      const p = _pending.get(e.data.id);
      if (!p) return;
      _pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error));
    };
    _worker.onerror = () => { _worker = null; };   // fall back on next call
  } catch { _worker = null; }
  return _worker;
}

function decodeRender(arrayBuffer, size) {
  const w = getWorker();
  if (!w) {                                        // no worker: do it inline
    const dec = decodeLevel2(arrayBuffer, bunzip);
    return Promise.resolve(_render(dec, { size }));
  }
  return new Promise((resolve, reject) => {
    const id = ++_seq;
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, arrayBuffer, size }, [arrayBuffer]);
  });
}
