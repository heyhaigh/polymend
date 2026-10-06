// Drive a batch through the real page: several models and one file that is not a model,
// the list, opening a row, the one-ZIP download, and the 20-file limit.
// Usage: [POLYMEND_URL=https://polymend.xyz/] node tools/browser-batch.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { playwright as findPlaywright, models } from './local.mjs';

const picked = models(['.glb', '.stl']).filter(name => !/_fixed\.|-mended\./i.test(name)).slice(0, 4);
if (picked.length < 2) throw new Error('Put at least two models in the corpus folder to try a batch.');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'polymend-batch-'));
const notModel = path.join(scratch, 'notes.txt');
fs.writeFileSync(notModel, 'not a model');
const tooMany = Array.from({ length: 21 }, (_, i) => { const file = path.join(scratch, `part-${i + 1}.stl`); fs.writeFileSync(file, 'solid x\nendsolid x\n'); return file; });

const browser = await findPlaywright()[process.env.ENGINE || 'chromium'].launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(process.env.POLYMEND_URL || 'http://127.0.0.1:8650/', { waitUntil: 'load' });

const started = Date.now();
await page.setInputFiles('#file', [...picked, notModel]);
await page.waitForFunction(() => /^\d+ models$/.test(document.getElementById('batch-title').textContent), null, { timeout: 300000 });
await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
console.log(`${picked.length} models in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log((await page.locator('#batch-detail').innerText()));
for (const row of await page.locator('.batch-row').allInnerTexts()) console.log('  ' + row.replace(/\n/g, ' · '));
console.log('in view:', await page.evaluate(() => document.getElementById('model-trigger').dataset.tooltip || document.getElementById('model-current').textContent), '·', await page.locator('#model-count').innerText());
await page.click('#model-next');
await page.waitForFunction(() => !document.getElementById('model-next').disabled, null, { timeout: 60000 });
console.log('next:', await page.evaluate(() => document.getElementById('model-trigger').dataset.tooltip || document.getElementById('model-current').textContent), '·', await page.locator('#model-count').innerText());

const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#batch-download')]);
const zipPath = path.join(scratch, download.suggestedFilename());
await download.saveAs(zipPath);
console.log(`downloaded ${download.suggestedFilename()} ${(fs.statSync(zipPath).size / 1024 ** 2).toFixed(1)} MB`);

await page.setInputFiles('#file', tooMany);
await page.waitForSelector('#failure:not([hidden])');
console.log('21 files:', await page.locator('#failure-title').innerText());
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
fs.rmSync(scratch, { recursive: true, force: true });
if (errors.length) process.exit(1);
