// NEXRAD Level II (Archive II / AR2V0006) decoder — pure Uint8Array/DataView,
// runs identically in Node and the browser. `bunzip` is injected so the same
// code works with any bzip2 implementation.
//
// Returns sweep-0 base reflectivity: { siteLat, siteLon, az[], firstGateKm,
// gateWidthKm, numGates, ref: Float32Array (nRadials*numGates, NaN = no data) }.

const CTM = 12;          // channel-terminal-manager spacer before each message
const MSG_HDR = 16;

// opts.firstSweepOnly: stop after the first (lowest, 0.5°) reflectivity
// elevation instead of decompressing all ~18 cuts. Same sweep-0 result, but
// ~10x less CPU and memory — important inside a Cloudflare Worker (128 MB).
export function decodeLevel2(arrayBuffer, bunzip, opts = {}) {
  const firstSweepOnly = !!opts.firstSweepOnly;
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const td = new TextDecoder('ascii');

  const radials = [];
  let siteLat = null, siteLon = null;
  let firstGateKm = null, gateWidthKm = null, numGates = null;
  let targetElev = null, stop = false;

  // 24-byte Volume Header Record, then LDM records: [int32 BE size][bzip2 data].
  // Each record decompresses to a whole number of messages (none span a record
  // boundary), and the metadata record pads messages, so we MUST frame each
  // record independently instead of over one concatenated buffer.
  let pos = 24;
  while (pos + 4 <= bytes.length && !stop) {
    const ctrl = dv.getInt32(pos, false);
    pos += 4;
    const size = Math.abs(ctrl);
    if (size === 0 || pos + size > bytes.length) break;
    const rec = bunzip(bytes.subarray(pos, pos + size));   // one bzip2 stream
    pos += size;

    const rdv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    let mp = 0;
    while (mp + CTM + MSG_HDR <= rec.length) {
      const hdr = mp + CTM;
      const sizeHw = rdv.getUint16(hdr, false);
      if (sizeHw === 0) break;                 // trailing padding -> next record
      const msgType = rec[hdr + 3];
      if (msgType === 31) {
        const r = parseMsg31(rec, rdv, td, hdr + MSG_HDR);
        if (r) {
          if (firstSweepOnly && r.ref) {
            if (targetElev === null) targetElev = r.elevNum;
            else if (r.elevNum !== targetElev) { stop = true; break; }  // past sweep 0
          }
          radials.push(r);
          if (siteLat === null && r.lat !== null) { siteLat = r.lat; siteLon = r.lon; }
          if (numGates === null && r.ref) {
            firstGateKm = r.firstGateKm; gateWidthKm = r.gateWidthKm; numGates = r.numGates;
          }
        }
      }
      mp += CTM + sizeHw * 2;                   // message length incl. header
    }
  }

  // Sweep 0 = first elevation cut that carries reflectivity.
  const withRef = radials.filter(r => r.ref && r.numGates);
  if (!withRef.length) throw new Error('no reflectivity radials found');
  const elev = withRef[0].elevNum;
  let sweep = withRef.filter(r => r.elevNum === elev);

  // De-dupe by azimuth number (split cuts can repeat) and sort by azimuth angle.
  const seen = new Set();
  sweep = sweep.filter(r => (seen.has(r.azNum) ? false : (seen.add(r.azNum), true)));
  sweep.sort((a, b) => a.az - b.az);

  const nR = sweep.length;
  const nG = numGates;
  const az = new Float32Array(nR);
  const ref = new Float32Array(nR * nG).fill(NaN);
  for (let i = 0; i < nR; i++) {
    az[i] = sweep[i].az;
    const src = sweep[i].ref;
    ref.set(src, i * nG);
  }
  despeckle(ref, nR, nG, 5, 12);   // drop isolated clutter blobs < 12 gates
  return { siteLat, siteLon, az, firstGateKm, gateWidthKm, numGates: nG, nRadials: nR, ref };
}

// Remove connected echo blobs (>= thresh dBZ) smaller than minCells, using
// 8-connectivity with wrap across the 0/360 azimuth seam (rows = radials).
function despeckle(ref, nR, nG, thresh, minCells) {
  const N = nR * nG;
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  for (let start = 0; start < N; start++) {
    if (seen[start] || !(ref[start] >= thresh)) continue;
    let sp = 0, count = 0;
    stack[sp++] = start; seen[start] = 1;
    const comp = [];
    while (sp > 0) {
      const idx = stack[--sp];
      comp.push(idx); count++;
      const r = (idx / nG) | 0, g = idx - r * nG;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = (r + dr + nR) % nR;                 // wrap radial dimension
        for (let dg = -1; dg <= 1; dg++) {
          if (dr === 0 && dg === 0) continue;
          const gg = g + dg;
          if (gg < 0 || gg >= nG) continue;
          const ni = rr * nG + gg;
          if (!seen[ni] && ref[ni] >= thresh) { seen[ni] = 1; stack[sp++] = ni; }
        }
      }
    }
    if (count < minCells) for (const i of comp) ref[i] = NaN;
  }
}

function parseMsg31(msgs, dv, td, B) {
  // Data Header Block
  const azNum = dv.getUint16(B + 10, false);
  const az = dv.getFloat32(B + 12, false);
  const elevNum = msgs[B + 22];
  const blockCount = dv.getUint16(B + 30, false);

  let lat = null, lon = null;
  let ref = null, firstGateKm = null, gateWidthKm = null, numGates = null;

  for (let i = 0; i < blockCount; i++) {
    const ptr = dv.getUint32(B + 32 + i * 4, false);
    if (ptr === 0) continue;
    const p = B + ptr;
    const type = String.fromCharCode(msgs[p]);
    const name = td.decode(msgs.subarray(p + 1, p + 4));

    if (name === 'VOL') {
      lat = dv.getFloat32(p + 8, false);
      lon = dv.getFloat32(p + 12, false);
    } else if (name === 'REF') {
      numGates = dv.getUint16(p + 8, false);
      firstGateKm = dv.getInt16(p + 10, false) / 1000;   // meters -> km
      gateWidthKm = dv.getInt16(p + 12, false) / 1000;
      const wordSize = msgs[p + 19];                      // bits per gate
      const scale = dv.getFloat32(p + 20, false);
      const offset = dv.getFloat32(p + 24, false);
      const data = new Float32Array(numGates).fill(NaN);
      const base = p + 28;
      for (let g = 0; g < numGates; g++) {
        const raw = wordSize === 16
          ? dv.getUint16(base + g * 2, false)
          : msgs[base + g];
        if (raw >= 2) data[g] = (raw - offset) / scale;   // 0=no data, 1=range folded
      }
      ref = data;
    }
  }
  return { azNum, az, elevNum, lat, lon, ref, firstGateKm, gateWidthKm, numGates };
}
