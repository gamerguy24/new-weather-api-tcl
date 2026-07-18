// Verify the shipped nexrad.js module works standalone (no demo page involved):
// load a blank page from the host, dynamically import the module, and use it.
import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
page.on('requestfailed', r => { const u = r.url(); if (!u.endsWith('favicon.ico')) logs.push('[reqfail] ' + u); });

await page.goto('http://localhost:8770/', { waitUntil: 'domcontentloaded' });

const result = await page.evaluate(async () => {
  const N = await import('/nexrad.js');
  const sites = await N.listSites();
  const scan = await N.getScan('KTLX', { size: 600 });
  return {
    nSites: sites.length,
    exports: Object.keys(N).sort(),
    site: scan.site, key: scan.key, scanTimeUTC: scan.scanTimeUTC,
    bounds: scan.bounds,
    pngOK: scan.toDataURL().startsWith('data:image/png'),
    meta: scan.metadata(),
  };
});

console.log('exports:', result.exports.join(', '));
console.log('listSites ->', result.nSites, 'sites');
console.log('getScan  ->', result.site, result.key);
console.log('scanTimeUTC:', result.scanTimeUTC);
console.log('toDataURL is PNG:', result.pngOK);
console.log('bounds:', JSON.stringify(result.bounds));
console.log('metadata keys:', Object.keys(result.meta).sort().join(', '));
if (logs.length) { console.log('--- issues ---'); logs.forEach(l => console.log(l)); }
else console.log('no page errors');
await browser.close();
