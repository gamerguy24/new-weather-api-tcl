# NEXRAD Live Weather Radar — static client-side API

Live **NEXRAD Level II** base-reflectivity radar from the public **AWS Open Data**
feed (`s3://unidata-nexrad-level2`), with **no server and no AWS account**.

Everything runs in the browser: `nexrad.js` lists radar sites, downloads raw
Level II volume scans straight from S3 (the bucket allows anonymous GETs with
open CORS), and decodes + renders base reflectivity — including bzip2 — entirely
client-side. The JavaScript decoder was validated byte-for-byte against MetPy.

```js
import * as NEXRAD from './nexrad.js';
const scan = await NEXRAD.getScan('KTLX', { size: 1400 });
document.querySelector('img').src = scan.toDataURL();   // rendered radar PNG
console.log(scan.metadata());                            // JSON metadata
```

- **The API and how to use it:** [`site/`](site/) and **[site/README.md](site/README.md)**.
- **`worker/`** — an optional **Cloudflare Worker** that turns the same decode
  code into a real, `curl`-able HTTP API (`GET /radar?site=KTLX` → JSON or PNG).
  Needs the Workers **Paid** plan ($5/mo) because the decode uses ~1–2 s of CPU
  (the free plan caps at 10 ms). See **[worker/README.md](worker/README.md)**.
- **`build/`** — Node dev tooling: `smoke.mjs` (download + decode + render a real
  scan to a PNG, pure Node), `e2e.mjs` (headless-browser test), and the esbuild
  config that produces `site/vendor/bz2.js`. Not needed to host the site.

## Host it on Render (free)

Render's **Static Sites are free** (global CDN, no server). This repo ships a
[`render.yaml`](render.yaml) blueprint that publishes the `site/` folder.

1. Push this repo to GitHub/GitLab.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`
   and creates a **Static Site** (`runtime: static`, publish path `./site`, no
   build step).
3. It goes live at `https://<name>.onrender.com/`. Your hosted module URL is
   `https://<name>.onrender.com/nexrad.js`.

Prefer to click through the dashboard instead of the blueprint? **New → Static
Site** → connect the repo → **Publish directory:** `site` → leave the build
command empty.

> Why static (not the old Python web service): the whole pipeline is now
> JavaScript, so there's nothing to run server-side. A Static Site is free and
> never spins down — unlike a free Web Service, which sleeps when idle.

Other free static hosts work the same way (serve the `site/` folder): GitHub
Pages, Netlify, Cloudflare Pages.

## Data source

| Bucket | Purpose |
| --- | --- |
| `unidata-nexrad-level2` | Level II real-time / archive volume scans (used here) |
| `unidata-nexrad-level2-chunks` | Level II real-time chunks |
| `unidata-nexrad-level3` | Level III select products |

Region `us-east-1`. Keys are `YYYY/MM/DD/SITE/SITEYYYYMMDD_HHMMSS_V06`, so the
newest object for a site is that site's latest scan.

## How it works

1. **List** the newest key for a site via the S3 REST API (XML) — `js/s3.js`.
2. **Download** the ~8 MB `_V06` file with `fetch` (streamed, with progress).
3. **Decode** the Archive II format in JS — `js/decoder.js`: 24-byte volume
   header, bzip2-compressed LDM records (`vendor/bz2.js`), Message 31 radials,
   and the REF / VOL data blocks. Sweep 0 (0.5° tilt).
4. **Render** — `js/render.js`: reverse-map each pixel to (range, azimuth),
   bilinearly interpolate, and apply a continuous NWS dBZ color ramp with a soft
   alpha fade. Runs in a Web Worker so the page never blocks.

## Notes / limitations

- Base reflectivity, lowest tilt (0.5°) only.
- ~8 MB per scan; a few seconds to decompress in JS; not cached across reloads.
- ~230 km radius per radar; new scans appear every few minutes.
- A static host serves files, not computed responses — this is a JavaScript API
  you import, not a `curl`-able HTTP endpoint. For the latter, wrap the same
  `decode`/`render` code in a Cloudflare Worker (see site/README.md).
