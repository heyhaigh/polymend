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
// A box with no top, like a vase: the wide opening must be left open unless asked.
{
  const soup = [];
  const n = 6;
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    if (axis === 2 && side === 1) continue;
    const at = (u, v) => { const p = [0, 0, 0]; p[axis] = side; p[(axis + 1) % 3] = u; p[(axis + 2) % 3] = v; return p.map(value => value * 40); };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const ring = [at(i / n, j / n), at((i + 1) / n, j / n), at((i + 1) / n, (j + 1) / n), at(i / n, (j + 1) / n)];
      const [a, b, c, d] = side ? ring : ring.reverse();
      soup.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const positions = Float64Array.from(soup), order = Uint32Array.from({ length: soup.length / 3 }, (_, i) => i);
  fs.writeFileSync('out/browser/vase.stl', writeSTL(positions, order));
}
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
// Changing an option afterwards must act on the model that is showing, under its own name.
await page.uncheck('[data-option="separatePinches"]');
await page.waitForFunction(() => document.getElementById('outcome-title').textContent === 'Partly repaired' && document.getElementById('failure').hidden);
console.log('then changing an option → file strip says:', JSON.stringify(await page.textContent('#status')), '|', (await read()).outcome);

// A wide opening is left open and explained; the switch closes it.
await page.goto('http://127.0.0.1:8650/');
await page.setInputFiles('#file', 'out/browser/vase.stl');
await page.waitForSelector('#results:not([hidden])');
const vase = await read();
console.log('open-topped box →', vase.outcome, '|', vase.detail, '|', vase.reasons.join(' '));
await page.screenshot({ path: 'out/browser/vase.png' });
await page.click('.options summary');
await page.check('[data-option="patchWide"]');
await page.waitForFunction(() => document.getElementById('outcome-title').textContent === 'Repaired');
const lidded = await read();
console.log('with "Close wide openings too" →', lidded.outcome, '|', lidded.reasons.join(' '));
console.log('self-crossing line →', JSON.stringify(await page.textContent('#crossings')), '| size →', await page.textContent('#size'));

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
// The card's X puts it away; the title does not come back while a model is on the page.
await page.click('#outcome [data-dismiss]');
console.log('after dismissing →', JSON.stringify(await page.evaluate(() => ({ cardHidden: document.getElementById('outcome').hidden, titleShown: document.querySelector('.tool-title').getBoundingClientRect().width > 2, badge: document.getElementById('badge').textContent, pinnedAt: document.getElementById('top-stick').style.top }))));
await page.setInputFiles('#file', 'out/browser/not-a-model.stl');
await page.waitForSelector('#failure:not([hidden])');
await page.click('#failure [data-dismiss]');
console.log('refusal dismissed too →', await page.evaluate(() => document.getElementById('failure').hidden));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
