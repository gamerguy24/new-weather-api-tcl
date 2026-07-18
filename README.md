# NEXRAD Live Weather Radar API

Live **NEXRAD Level II** base-reflectivity radar from the public **AWS Open Data**
feed (`s3://unidata-nexrad-level2`) — **no AWS account**. It lists radar sites,
downloads raw Level II volume scans, and decodes + renders base reflectivity
(including bzip2) in JavaScript. The decoder was validated byte-for-byte against
MetPy. Ships in three forms that share the same decode/render code:

- **`server/` — curl-able HTTP API (Node), hosted free on Render. ⭐ recommended.**
  ```
  GET /radar?site=KTLX              -> JSON metadata
  GET /radar?site=KTLX&format=png   -> base-reflectivity PNG
  GET /radar.png?site=KTLX          -> PNG
  GET /sites                        -> sites reporting today
  GET /health                       -> { status: "ok" }
  ```
- **`site/` — static browser module** (`nexrad.js`): import it into a web page and
  call `getScan("KTLX")`; decodes in the browser, no server. See
  [site/README.md](site/README.md).
- **`worker/` — Cloudflare Worker** (same HTTP API). Works, but needs the Workers
  **Paid** plan because the decode uses ~1–2 s CPU vs the free plan's 10 ms cap.
  Render's free tier has **no** such CPU limit, which is why Render is recommended.
- **`build/`** — Node dev tooling (`smoke.mjs`, `e2e.mjs`, the esbuild bzip2 bundle).

## Host the API on Render (free)

A Render **Web Service** runs Node with no per-request CPU limit, so the decode
runs fine on the **free** tier. This repo's [`render.yaml`](render.yaml) blueprint
deploys `server/server.js`.

1. Push this repo to GitHub/GitLab.
2. In Render: **New → Blueprint**, select the repo. Render reads `render.yaml`
   and creates a Node **Web Service** (`runtime: node`, `plan: free`).
3. It goes live at `https://<name>.onrender.com/`. Try:
   ```
   curl "https://<name>.onrender.com/radar?site=KTLX"
   curl "https://<name>.onrender.com/radar.png?site=KTLX" -o radar.png
   ```

Prefer the dashboard? **New → Web Service** → connect the repo → Build:
`npm install`, Start: `node server/server.js`, Health check path: `/health`.

**Run it locally:**
```bash
npm start                      # http://localhost:5000
curl "http://localhost:5000/radar?site=KTLX"
```

> Free-tier note: a free Render Web Service **spins down after ~15 min idle**, so
> the first request after a nap does a cold start (a few extra seconds). Later
> requests are fast, and each scan is cached in memory.

The static browser module in `site/` can also be hosted free (Render Static Site,
GitHub Pages, Netlify, Cloudflare Pages) — see [site/README.md](site/README.md).

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
