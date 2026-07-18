import puppeteer from 'puppeteer-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const logs = [];
page.on('console', m => logs.push('[console] ' + m.text()));
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
page.on('requestfailed', r => logs.push('[reqfail] ' + r.url() + ' ' + (r.failure()?.errorText)));

await page.goto('http://localhost:8770/', { waitUntil: 'networkidle2', timeout: 30000 });
try {
  await page.waitForFunction(() => {
    const s = document.getElementById('status')?.textContent || '';
    return s.includes('done') || s.startsWith('error');
  }, { timeout: 60000 });
} catch (e) { logs.push('[timeout waiting for status]'); }

const statusText = await page.$eval('#status', el => el.textContent);
const siteCount = await page.$eval('#site', el => el.options.length);
const imgSrc = await page.$eval('#out', el => (el.src || '').slice(0, 24));
const metaText = await page.$eval('#meta', el => el.textContent);
let meta = null; try { meta = JSON.parse(metaText); } catch {}

console.log('STATUS:', JSON.stringify(statusText));
console.log('SITE OPTIONS:', siteCount);
console.log('IMG src prefix:', imgSrc);
console.log('META site/key:', meta && meta.site, meta && meta.key);
console.log('META bounds:', meta && JSON.stringify(meta.bounds));
console.log('META scanTimeUTC:', meta && meta.scanTimeUTC);
console.log('--- browser logs ---'); logs.forEach(l => console.log(l));
await page.screenshot({ path: 'e2e_api.png' });
console.log('screenshot saved');
await browser.close();
