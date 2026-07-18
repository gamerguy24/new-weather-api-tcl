# NEXRAD Radar — Cloudflare Worker (real HTTP API)

A **curl-able** HTTP API for live NEXRAD Level II base reflectivity. It reuses
the exact browser-validated decode/render code (`../site/js/*`), adds a
Worker-safe S3 listing and a `CompressionStream`-based PNG encoder, and decodes
only sweep 0 (0.5°) to fit the isolate memory limit.

```
GET /radar?site=KTLX              -> JSON metadata for the newest scan
GET /radar?site=KTLX&format=png   -> base-reflectivity PNG
GET /radar.png?site=KTLX          -> base-reflectivity PNG
GET /radar?site=KTLX&size=1600    -> larger image (300..2000, default 1200)
GET /radar?key=2026/07/18/KTLX/…  -> a specific scan by S3 key
GET /sites                        -> sites reporting today
GET /health                       -> { status: "ok" }
```

CORS is `*`, so browsers and `fetch()` can call it too. Responses are cached
per scan key (`caches.default`), so repeat requests for the same scan are cheap.

## ⚠️ Needs the Workers PAID plan ($5/mo)

Decoding a scan (bzip2 + parse) uses **~1–2 seconds of CPU**. Cloudflare's
limits:

| Plan | CPU per request |
| --- | --- |
| **Free** | **10 ms** — far too low; the decode cannot run |
| **Paid** ($5/mo) | 30 s (up to 5 min) — plenty |

Caching doesn't rescue the free plan: the *first* request for each new scan
still has to run the full decode, which exceeds 10 ms. So this endpoint requires
Workers Paid. (`wrangler.toml` sets `cpu_ms = 30000`, a paid-only setting.)

If you need it truly free, the alternative is to **precompute**: run the Node
decoder on a schedule (e.g. a GitHub Action every few minutes) for the sites you
care about, upload the JSON/PNG to R2, and have a tiny Worker serve those static
objects (well under 10 ms). Ask and I can set that up.

## Run locally (no Cloudflare account needed)

```bash
cd worker
npm install
npx wrangler dev            # http://127.0.0.1:8787
# then:
curl "http://127.0.0.1:8787/radar?site=KTLX"
curl "http://127.0.0.1:8787/radar.png?site=KTLX" -o radar.png
```

`wrangler dev` runs the real Worker runtime (workerd) locally and ignores the
CPU limit, so it works regardless of plan — good for development.

## Deploy

```bash
cd worker
npx wrangler login          # opens a browser once
npx wrangler deploy         # publishes to https://nexrad-radar-api.<you>.workers.dev
```

Make sure the account is on **Workers Paid** (Dashboard → Workers & Pages →
Plans), or fresh-scan requests will be killed at 10 ms.

## How it fits in memory

The full volume is ~74 MB decompressed (all 18 tilts); a Worker isolate has
128 MB. `decodeLevel2(buf, bunzip, { firstSweepOnly: true })` stops after the
first (0.5°) reflectivity cut — ~8 MB decompressed — producing byte-for-byte the
same sweep-0 result, ~4× faster.
