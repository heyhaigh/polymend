// The batch's awkward moments, driven through the real page: timing to the review and to
// the ZIP, a batch replaced at once by another, a single file chosen while the ZIP is still
// being built, a new height and an edited model rebuilding exactly what they should, quick
// switching, and file names that only differ in characters the ZIP cannot keep.
// Usage: node tools/browser-batch-edge.mjs   (needs the local server on :8650)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { playwright as findPlaywright, models } from './local.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'polymend-edge-'));
const fixture = new URL('../test/fixtures/holed-box-draco.glb', import.meta.url).pathname;
const odd = ['box?one.glb', 'box!one.glb', 'con.glb', 'box one.glb'].map(name => { const file = path.join(scratch, name); fs.copyFileSync(fixture, file); return file; });
const real = models(['.glb', '.stl']).filter(name => !/_fixed\.|-mended\./i.test(name)).slice(0, 4);
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

/** Heights of the binary STLs inside a stored or deflated ZIP, read with the system unzip. */
async function stlHeights(zipPath) {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(scratch, 'unzip-'));
  execFileSync('unzip', ['-q', zipPath, '-d', dir]);
  const out = {};
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.stl'))) {
    const bytes = fs.readFileSync(path.join(dir, name)), view = new DataView(bytes.buffer, bytes.byteOffset);
    const count = view.getUint32(80, true);
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < count; t++) for (let v = 0; v < 3; v++) {
      const at = 84 + t * 50 + 12 + v * 12;
      const z = view.getFloat32(at + 8, true);
      lo = Math.min(lo, z); hi = Math.max(hi, z);
    }
    const { createHash } = await import('node:crypto');
    out[name] = { height: Math.round((hi - lo) * 100) / 100, hash: createHash('sha256').update(bytes.subarray(84)).digest('hex') };
  }
  return { names: fs.readdirSync(dir).sort(), stl: out };
}

const browser = await findPlaywright()[process.env.ENGINE || 'chromium'].launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const downloads = [];
page.on('download', download => downloads.push(download));
await page.goto('http://127.0.0.1:8650/?theme=light', { waitUntil: 'load' });
const reviewed = () => page.waitForFunction(() => /^\d+ models?$/.test(document.getElementById('batch-title').textContent) && !document.getElementById('results').hidden, null, { timeout: 120000 });
const zipReady = () => page.waitForFunction(() => /^Download all/.test(document.getElementById('batch-download-label').textContent), null, { timeout: 180000 });

// 1. Timing: the review comes first, the ZIP after.
let started = Date.now();
await page.setInputFiles('#file', real);
await reviewed();
const toReview = Date.now() - started;
const label = await page.locator('#batch-download-label').innerText();
await zipReady();
console.log(`review after ${(toReview / 1000).toFixed(1)} s ("${label}"), ZIP ready after ${((Date.now() - started) / 1000).toFixed(1)} s`);
check(/Building ZIP/.test(label) || toReview < 1500, 'the review opens while the ZIP is still being built');

// 2. A batch replaced at once by another: only the second batch's files, nothing misplaced.
await page.setInputFiles('#file', real.slice(0, 3));
await page.setInputFiles('#file', odd);
await reviewed();
const rows = await page.locator('.batch-name').allInnerTexts();
check(JSON.stringify(rows) === JSON.stringify(odd.map(f => path.basename(f))), `the replacing batch lists only its own files (${rows.join(', ')})`);
await zipReady();

// 3. Names that collide once made safe, and a name Windows reserves, stay apart in the ZIP.
let [download] = await Promise.all([page.waitForEvent('download'), page.click('#batch-download')]);
let zipPath = path.join(scratch, 'odd.zip');
await download.saveAs(zipPath);
const odds = await stlHeights(zipPath);
check(new Set(odds.names.map(n => n.toLowerCase())).size === odds.names.length && odds.names.length === 9, `ZIP entries are distinct: ${odds.names.join(', ')}`);
check(!odds.names.some(n => /^con-mended/i.test(n)), 'a reserved Windows name is changed');

// 4. A new height rebuilds every model's files, and the ZIP holds the new height.
await page.fill('#height', '20');
await page.locator('#height').dispatchEvent('input');
await page.waitForTimeout(600);
await zipReady();
[download] = await Promise.all([page.waitForEvent('download'), page.click('#batch-download')]);
zipPath = path.join(scratch, 'twenty.zip');
await download.saveAs(zipPath);
const twenty = await stlHeights(zipPath);
check(Object.values(twenty.stl).every(s => Math.abs(s.height - 20) < 0.01), `every STL is 20 mm tall (${Object.values(twenty.stl).map(s => s.height).join(', ')})`);

// 5. Turning the model in view upright changes only that model's files.
const inView = await page.locator('#model-select option:checked').innerText();
await page.waitForFunction(() => !document.getElementById('rotate').disabled, null, { timeout: 60000 });
await page.click('#rotate');
await page.waitForFunction(() => !document.getElementById('rotate').disabled, null, { timeout: 60000 });
await zipReady();
[download] = await Promise.all([page.waitForEvent('download'), page.click('#batch-download')]);
zipPath = path.join(scratch, 'turned.zip');
await download.saveAs(zipPath);
const turned = await stlHeights(zipPath);
const changed = Object.keys(turned.stl).filter(name => turned.stl[name].hash !== twenty.stl[name].hash);
check(changed.length === 1, `only the turned model changed (${changed.join(', ') || 'none'}; in view: ${inView})`);

// 6. Quick switching ends on the right model, ready to download under its own name.
await page.evaluate(() => { for (let i = 0; i < 5; i++) document.getElementById('model-next').click(); });
await page.waitForFunction(() => !document.getElementById('download-all').disabled, null, { timeout: 60000 });
const last = (await page.locator('#model-select option:checked').innerText()).split(' · ')[0].replace(/\.glb$/, '');
[download] = await Promise.all([page.waitForEvent('download'), page.click('#download-all')]);
check(download.suggestedFilename() === `${last}-mended.zip`, `after quick switching the download is the model in view (${download.suggestedFilename()} for ${last})`);

// 7. A single file chosen while the ZIP is being built ends the batch; nothing arrives later.
await page.fill('#height', '30');
await page.locator('#height').dispatchEvent('input');
await page.waitForTimeout(500);
const before = downloads.length;
await page.setInputFiles('#file', fixture);
await page.waitForSelector('#outcome:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(4000);
check(await page.locator('#batch').isHidden(), 'the batch card is gone');
check(downloads.length === before, 'no download arrives from the stopped batch');

// 8. A new batch while a real model is still being packed: WebKit once crashed the whole
// page when the packing worker was stopped mid-job, so it must be let finish instead.
let crashed = false;
page.on('crash', () => { crashed = true; });
for (const delay of [100, 400, 900]) {
  await page.setInputFiles('#file', real.slice(0, 2));
  await page.waitForFunction(() => /Building ZIP/.test(document.getElementById('batch-download-label').textContent) && /^\d+ models$/.test(document.getElementById('batch-title').textContent), null, { timeout: 120000 });
  await page.waitForTimeout(delay);
  await page.setInputFiles('#file', odd.slice(0, 2));
  await reviewed();
  await page.waitForTimeout(1500);
  if (crashed) break;
}
check(!crashed, 'a new batch dropped while models are being packed does not crash the page');

check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
fs.rmSync(scratch, { recursive: true, force: true });
if (failures.length) { console.log(`${failures.length} failed`); process.exit(1); }
