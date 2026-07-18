# NEXRAD Radar — static client-side API

A **static, browser-side API** for live **NEXRAD Level II** base-reflectivity
radar. No server, no backend, no AWS account. `nexrad.js` lists radar sites,
downloads raw Level II volume scans from the public AWS Open Data bucket, and
decodes + renders them **entirely in the browser** (including bzip2). Host the
files once on any static host; pages import the module and call it.

> A truly static host can't serve an HTTP/JSON endpoint you hit with `curl` —
> that needs a server. This is a **JavaScript API**: import it and call it from a
> page. (For a `curl`-able JSON endpoint, see "Server option" below.)

The browser decoder is validated byte-for-byte against MetPy (identical radial
count, site coordinates, and dBZ values).

## Use it

```html
<script type="module">
  import * as NEXRAD from './nexrad.js';          // or https://your-host/nexrad.js

  const sites = await NEXRAD.listSites();          // [{ code, name, lat, lon }]
  const scan  = await NEXRAD.getScan('KTLX', {     // newest scan for a site
    size: 1400,
    onProgress: f => console.log((f*100|0) + '%'),
  });

  document.querySelector('img').src = scan.toDataURL();   // rendered PNG
  console.log(scan.metadata());                           // JSON-ready metadata
</script>
```

## API

| Call | Returns |
| --- | --- |
| `listSites()` | `[{ code, name, lat, lon }]` — sites reporting in the current UTC day |
| `latestKey(site)` | newest S3 key `YYYY/MM/DD/SITE/…_V06`, or `null` |
| `getScan(siteOrKey, opts)` | a **Scan** (below). `opts`: `{ size, onProgress, signal }` |
| `decode(arrayBuffer)` | low-level synchronous decode → `{ siteLat, siteLon, az, ref, numGates, … }` |
| `render(decoded, { size })` | `{ rgba, width, height, bounds, siteLat, siteLon }` |

**Scan object**

```
{
  site, key,
  scanTimeUTC,                       // ISO 8601 string
  siteLat, siteLon,
  bounds: { south, west, north, east },
  product: 'base_reflectivity', tilt: 0.5,
  width, height,
  range: { numGates, firstGateKm, gateWidthKm },
  imageData,                         // an ImageData (paint to any canvas)
  toCanvas(), toDataURL(type?), toBlob(type?),
  metadata()                         // plain object, JSON.stringify-ready
}
```

`getScan()` runs the heavy decode + render in an internal Web Worker, so it never
blocks the page (it falls back to the main thread if workers are unavailable).

The rendered image is a lat/lon (equirectangular) PNG whose pixels map exactly to
`bounds`, so if you *do* want a map later it drops onto Leaflet with
`L.imageOverlay(scan.toDataURL(), [[bounds.south, bounds.west], [bounds.north, bounds.east]])`.

## Files

```
nexrad.js          the public API (import this)
nexrad.worker.js   internal decode+render worker
js/decoder.js      Level II parser (volume header, LDM bzip2 records, msg 31)
js/render.js       georeference + smoothing + NWS dBZ color ramp -> RGBA
js/s3.js           S3 REST listing + streaming download
js/sites.js        site names/coords for listSites()
vendor/bz2.js      bundled pure-JS bzip2 decompressor
index.html         static docs/landing page (no demo, no UI); the API is nexrad.js
```

## Run locally

ES modules + a module worker need **http**, not `file://`:

```bash
cd site && python -m http.server 8000     # then open http://localhost:8000
```

The page at `/` is just documentation; the API is the importable `nexrad.js` module.

## Deploy (all free, no build step)

- **Render** (Static Site) — the repo's [`render.yaml`](../render.yaml) blueprint
  publishes this folder. In Render: **New → Blueprint** → pick the repo. Or
  **New → Static Site**, publish directory `site`, empty build command. Static
  Sites are free and never spin down.
- **GitHub Pages** — serve this folder; live at `https://<user>.github.io/<repo>/nexrad.js`.
- **Netlify** — drag-and-drop the folder, or set publish directory to `site`.
- **Cloudflare Pages** — framework preset **None**, output directory `site`.

## Rebuilding the bzip2 bundle

`vendor/bz2.js` is prebuilt/checked in. To regenerate:

```bash
cd ../build && npm install
npx esbuild bz2-entry.mjs --bundle --format=esm --minify --outfile=../site/vendor/bz2.js
```

## Server option (real curl-able JSON)

If you need an HTTP endpoint (e.g. `GET /radar?site=KTLX` returning JSON/PNG to
non-browser clients), wrap `decode`/`render` in a **Cloudflare Worker** or other
serverless function — same code, but it runs on an edge server instead of the
page. Ask and this can be added.

## Notes / limitations

- Base reflectivity, lowest tilt (0.5°) only.
- ~8 MB download per scan; a few seconds to decompress in JS. Not cached across reloads.
- ~230 km radius per radar; new scans every few minutes.
