// Drive the real page in real browser engines with a real model.
// Usage: [POLYMEND_URL=https://polymend.xyz/] node tools/browser-check.mjs [chromium|webkit|firefox] [stl|glb] [mobile]
import fs from 'node:fs';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();

const engine = process.argv[2] || 'chromium';
const kind = process.argv[3] || 'stl';
const mobile = process.argv[4] === 'mobile';
const model = sample(kind === 'glb' ? '.glb' : '.stl', 'crocodile');
const out = 'out/browser';
fs.mkdirSync(out, { recursive: true });

const browser = await playwright[engine].launch();
const context = await browser.newContext(mobile ? { ...playwright.devices[engine === 'webkit' ? 'iPhone 13' : 'Pixel 7'], acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => requests.push(request.url()));
// POLYMEND_URL points the check at another copy of the page, such as the live site.
const address = process.env.POLYMEND_URL || 'http://127.0.0.1:8650/';
await page.goto(address, { waitUntil: 'load' });
await page.waitForTimeout(300);
const loadRequests = requests.length;

const started = Date.now();
await page.setInputFiles('#file', model);
await page.waitForSelector('#results:not([hidden])', { timeout: 180000 });
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const read = () => page.evaluate(() => ({
  outcome: document.getElementById('outcome-title').textContent,
  cls: document.getElementById('outcome').className,
  counts: [...document.querySelectorAll('#counts tr')].map(row => [...row.children].map(cell => cell.textContent).join(' | ')),
  notes: [...document.querySelectorAll('#outcome-reasons li')].map(li => li.textContent),
  crossings: document.getElementById('crossings').textContent,
  size: document.getElementById('size').textContent,
  step: document.getElementById('step-label').textContent,
  overflow: document.documentElement.scrollWidth > innerWidth,
  heightChecked: document.getElementById('set-height').checked,
}));
const first = await read();
console.log(`${engine}${mobile ? ' mobile' : ''} ${kind}: result after ${seconds}s`);
console.log(JSON.stringify(first, null, 1));
const tag = `${engine}-${kind}${mobile ? '-mobile' : ''}`;
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/${tag}-after.png`, fullPage: mobile });
await page.click('#show-before');
await page.click('#next');
await page.waitForTimeout(500);
console.log('before view, stepper:', await page.textContent('#step-label'));
await page.screenshot({ path: `${out}/${tag}-change.png` });
// Is the canvas actually drawing something?
const painted = await page.evaluate(() => {
  const canvas = document.getElementById('canvas');
  const copy = document.createElement('canvas');
  copy.width = 64; copy.height = 64;
  const ctx = copy.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
  return lit;
});
console.log('canvas pixels drawn (of 4096, sampled right after a frame):', painted);
// "Download all" gives the ZIP; the arrow's menu gives a single format.
const fetchFile = async (format, act) => {
  const wait = page.waitForEvent('download', { timeout: 120000 });
  await act();
  const download = await wait;
  const target = `${out}/${tag}.${format}`;
  await download.saveAs(target);
  console.log('downloaded', download.suggestedFilename(), (fs.statSync(target).size / 1e6).toFixed(1), 'MB');
};
await fetchFile('zip', () => page.click('#download-all'));
for (const format of ['stl', '3mf']) {
  await fetchFile(format, async () => {
    await page.click('#download-menu-button');
    await page.click(`.toolbar .split-menu [data-download="${format}"]`);
  });
}
console.log('menu closed after choosing:', await page.evaluate(() => document.querySelector('.toolbar .split-menu').hidden));
if (engine === 'chromium') console.log('JS heap MB:', await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1e6)));
console.log('requests during page load:', loadRequests, '| requests after load:', requests.length - loadRequests, requests.slice(loadRequests).filter(u => !u.startsWith('blob:')));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
