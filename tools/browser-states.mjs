// Check the page's "partly repaired", error and time-limit states.
import fs from 'node:fs';
import { writeSTL } from '../src/stl.js';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();

fs.mkdirSync('out/browser', { recursive: true });
// Two solids touching along one edge: the page must leave them touching and say so.
const corners = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1];
const tris = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2, 0, 4, 1, 0, 5, 4, 4, 5, 1, 0, 1, 5];
fs.writeFileSync('out/browser/touching.stl', writeSTL(Float64Array.from(corners), Uint32Array.from(tris)));
fs.writeFileSync('out/browser/not-a-model.stl', 'this is not a model');
fs.writeFileSync('out/browser/picture.obj', 'v 0 0 0');
const big = sample('.stl', 'crocodile');

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto('http://127.0.0.1:8650/');
const read = () => page.evaluate(() => ({
  failure: document.getElementById('failure').hidden ? null : [document.getElementById('failure-title').textContent, document.getElementById('failure-detail').textContent],
  badge: [document.getElementById('badge').className, document.getElementById('badge').textContent],
  card: document.getElementById('outcome').className,
  outcome: document.getElementById('outcome-title').textContent, detail: document.getElementById('outcome-detail').textContent,
  reasons: [...document.querySelectorAll('#outcome-reasons li')].map(li => li.textContent),
  buttons: [document.getElementById('download-all').textContent.trim(), document.querySelector('.toolbar [data-split]').className],
  resultsHidden: document.getElementById('results').hidden,
  choose: document.getElementById('choose-label').textContent,
}));
for (const bad of ['not-a-model.stl', 'picture.obj']) {
  await page.setInputFiles('#file', `out/browser/${bad}`);
  await page.waitForSelector('#failure:not([hidden])');
  const state = await read();
  console.log(bad, '→', JSON.stringify(state.failure), JSON.stringify(state.badge), 'results hidden:', state.resultsHidden);
}
await page.setInputFiles('#file', 'out/browser/touching.stl');
await page.waitForSelector('#results:not([hidden])');
const partial = await read();
console.log('touching solids →', partial.card, JSON.stringify(partial.badge), '| failure card hidden:', partial.failure === null, '|', partial.outcome, '|', partial.detail, '|', partial.reasons.join(' '), '|', partial.buttons.join(' / '));
await page.screenshot({ path: 'out/browser/partial.png' });
await page.click('.options summary');
await page.check('[data-option="separatePinches"]');
await page.waitForFunction(() => document.getElementById('outcome-title').textContent === 'Repaired');
const after = await read();
console.log('after turning separation on →', after.card, JSON.stringify(after.badge), '|', after.buttons.join(' / '));
// A bad file while a model is showing: the model stays, and the card says so.
await page.setInputFiles('#file', 'out/browser/not-a-model.stl');
await page.waitForSelector('#failure:not([hidden])');
const second = await read();
console.log('bad file with a model showing →', JSON.stringify(second.failure), '| results still shown:', !second.resultsHidden);

// Time limit: with the limit set to 0.4 seconds, a real model must be stopped and explained.
await page.goto('http://127.0.0.1:8650/?limit-ms=60');
await page.setInputFiles('#file', big);
await page.waitForSelector('#failure:not([hidden])', { timeout: 20000 });
const stopped = await read();
console.log('time limit →', JSON.stringify(stopped.failure), '| results hidden:', stopped.resultsHidden, '| button:', stopped.choose);
// The page must still work afterwards, with a fresh worker.
await page.setInputFiles('#file', 'out/browser/touching.stl');
await page.waitForSelector('#results:not([hidden])');
console.log('after a time-out the page still works →', (await read()).outcome);
// And at the normal limit the same model finishes.
await page.goto('http://127.0.0.1:8650/');
await page.setInputFiles('#file', big);
await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
console.log('normal limit →', (await read()).outcome);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
