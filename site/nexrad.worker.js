// Internal worker: decode + render off the main thread so the API stays async
// and non-blocking during the ~8 MB bzip2 decompress.
import { bunzip } from './vendor/bz2.js';
import { decodeLevel2 } from './js/decoder.js';
import { render } from './js/render.js';

self.onmessage = (e) => {
  const { id, arrayBuffer, size } = e.data;
  try {
    const dec = decodeLevel2(arrayBuffer, bunzip);
    const img = render(dec, { size });
    self.postMessage(
      { id, ok: true, rgba: img.rgba, width: img.width, height: img.height,
        bounds: img.bounds, siteLat: img.siteLat, siteLon: img.siteLon,
        firstGateKm: dec.firstGateKm, gateWidthKm: dec.gateWidthKm,
        numGates: dec.numGates, nRadials: dec.nRadials },
      [img.rgba.buffer],
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
