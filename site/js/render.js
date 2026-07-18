// Render decoded sweep-0 reflectivity to an RGBA raster + lat/lon bounds,
// ready for a Leaflet imageOverlay. Pure JS (no DOM), so it runs in Node for
// tests and in the browser. The smooth "weather-app" look comes from
// reverse-mapping each output pixel and bilinearly interpolating the polar
// field in both range and azimuth, with a soft alpha fade at low dBZ.

const KM_PER_DEG_LAT = 111.19;

// Continuous NWS-style dBZ ramp with alpha feathering at the low end.
const STOPS = [
  [5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'],
  [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'],
  [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'],
  [65, '#f800fd'], [70, '#9854c6'], [75, '#ffffff'],
];
const FADE_LO = 5, FADE_HI = 18;

function hexRGB(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
// Precompute a 256-entry lookup table over dBZ [-10, 80].
const LUT_N = 256, LUT_MIN = -10, LUT_MAX = 80;
const LUT = new Uint8Array(LUT_N * 4);
(function buildLUT() {
  const ds = STOPS.map(s => s[0]);
  const rgbs = STOPS.map(s => hexRGB(s[1]));
  for (let i = 0; i < LUT_N; i++) {
    const d = LUT_MIN + (i / (LUT_N - 1)) * (LUT_MAX - LUT_MIN);
    let k = 0; while (k < ds.length - 1 && d > ds[k + 1]) k++;
    const t = k >= ds.length - 1 ? 1 : Math.max(0, Math.min(1, (d - ds[k]) / (ds[k + 1] - ds[k])));
    const a = rgbs[k], b = rgbs[Math.min(k + 1, rgbs.length - 1)];
    LUT[i * 4] = Math.round(a[0] + (b[0] - a[0]) * t);
    LUT[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
    LUT[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
    LUT[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, (d - FADE_LO) / (FADE_HI - FADE_LO))));
  }
})();

export function render(dec, opts = {}) {
  const size = opts.size || 1200;
  const { siteLat, siteLon, az, firstGateKm, gateWidthKm, numGates, nRadials, ref } = dec;
  const kmLon = KM_PER_DEG_LAT * Math.cos(siteLat * Math.PI / 180);
  const maxRangeKm = firstGateKm + numGates * gateWidthKm;
  const minRangeKm = 5;                              // blank near-radar starburst

  const degLat = maxRangeKm / KM_PER_DEG_LAT;
  const degLon = maxRangeKm / kmLon;
  const bounds = {
    south: siteLat - degLat, north: siteLat + degLat,
    west: siteLon - degLon, east: siteLon + degLon,
  };

  // Sorted azimuths let us binary-search the bracketing radials.
  const W = size, H = size;
  const rgba = new Uint8ClampedArray(W * H * 4);

  for (let py = 0; py < H; py++) {
    const lat = bounds.north - (py + 0.5) / H * (bounds.north - bounds.south);
    const dyKm = (lat - siteLat) * KM_PER_DEG_LAT;
    for (let px = 0; px < W; px++) {
      const lon = bounds.west + (px + 0.5) / W * (bounds.east - bounds.west);
      const dxKm = (lon - siteLon) * kmLon;
      const rng = Math.hypot(dxKm, dyKm);
      if (rng < minRangeKm || rng > maxRangeKm) continue;

      let a = Math.atan2(dxKm, dyKm) * 180 / Math.PI;   // deg from north, CW
      if (a < 0) a += 360;
      const v = sample(az, ref, numGates, nRadials, a, (rng - firstGateKm) / gateWidthKm);
      if (Number.isNaN(v)) continue;

      let idx = Math.round((v - LUT_MIN) / (LUT_MAX - LUT_MIN) * (LUT_N - 1));
      idx = idx < 0 ? 0 : idx > LUT_N - 1 ? LUT_N - 1 : idx;
      const o = (py * W + px) * 4, l = idx * 4;
      const alpha = LUT[l + 3];
      if (alpha === 0) continue;
      rgba[o] = LUT[l]; rgba[o + 1] = LUT[l + 1]; rgba[o + 2] = LUT[l + 2]; rgba[o + 3] = alpha;
    }
  }
  return { rgba, width: W, height: H, bounds, siteLat, siteLon };
}

// Bilinear sample of the polar field at (azimuth deg, gate float index).
function sample(az, ref, numGates, nRadials, aDeg, gf) {
  if (gf < 0 || gf > numGates - 1) return NaN;
  const g0 = Math.floor(gf), g1 = Math.min(g0 + 1, numGates - 1), fg = gf - g0;

  // Bracketing radials by azimuth (az sorted ascending, wraps at 360).
  let lo = 0, hi = nRadials - 1;
  if (aDeg < az[0] || aDeg >= az[hi]) { lo = hi; hi = 0; }   // wrap segment
  else {
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (az[m] <= aDeg) lo = m; else hi = m; }
  }
  let span = az[hi] - az[lo]; if (span <= 0) span += 360;
  let da = aDeg - az[lo]; if (da < 0) da += 360;
  const fa = span > 0 ? da / span : 0;

  const vLo = interpGate(ref, lo, numGates, g0, g1, fg);
  const vHi = interpGate(ref, hi, numGates, g0, g1, fg);
  if (Number.isNaN(vLo)) return Number.isNaN(vHi) ? NaN : vHi;
  if (Number.isNaN(vHi)) return vLo;
  return vLo + (vHi - vLo) * fa;
}

function interpGate(ref, r, numGates, g0, g1, fg) {
  const a = ref[r * numGates + g0], b = ref[r * numGates + g1];
  if (Number.isNaN(a)) return Number.isNaN(b) ? NaN : b;
  if (Number.isNaN(b)) return a;
  return a + (b - a) * fg;
}
