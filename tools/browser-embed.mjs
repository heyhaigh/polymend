// The embed, end to end: the tool inside a made-up third-party page (loaded from a
// different origin, as in real use), the embed code on the home page, and the footer pop-up.
// Usage: node tools/browser-embed.mjs
import fs from 'node:fs';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();
const out = 'out/embed';
fs.mkdirSync(out, { recursive: true });
const model = sample('.stl', 'crocodile');
const home = 'http://127.0.0.1:8650/';

const browser = await playwright.chromium.launch();
for (const [tag, options] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['phone', playwright.devices['Pixel 7']]]) {
  const context = await browser.newContext({ ...options, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  const shot = async (name, wait = 700) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${out}/${tag}-${name}.png` }); };

  // 1. Inside someone else's page.
  await page.goto(home + 'library/embed-demo.html', { waitUntil: 'load' });
  const frame = page.frameLocator('iframe');
  await frame.locator('#choose').waitFor();
  await page.locator('iframe').scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, -140));
  await shot('1-host-start');
  await page.locator('iframe').screenshot({ path: `${out}/${tag}-1b-frame-start.png` });
  const inner = page.frames().find(f => new URL(f.url()).pathname === '/embed');
  console.log(tag, 'frame address:', inner.url(), '| different origin from the page:', new URL(inner.url()).origin !== new URL(page.url()).origin);
  console.log(tag, 'in the frame:', JSON.stringify(await inner.evaluate(() => ({
    bodyClass: document.body.className, dark: document.documentElement.classList.contains('dark-mode'),
    title: document.querySelector('.tool-title').getBoundingClientRect().width > 2, toggle: !!document.getElementById('theme-toggle'),
    credit: [...document.querySelectorAll('.embed-credit a')].map(a => `${a.textContent} -> ${a.href} (${a.target})`), overflow: document.documentElement.scrollWidth > innerWidth }))));
  await frame.locator('#file').setInputFiles(model);
  await frame.locator('#results:not([hidden])').waitFor({ timeout: 120000 });
  await shot('2-host-repaired', 1200);
  console.log(tag, 'outcome in the frame:', await frame.locator('#outcome-title').textContent(), '|', await frame.locator('#status').textContent());
  const wait = page.waitForEvent('download', { timeout: 60000 });
  await frame.locator('#download-all').click();
  const download = await wait;
  await download.saveAs(`${out}/${tag}.zip`);
  console.log(tag, 'download from inside the frame:', download.suggestedFilename(), (fs.statSync(`${out}/${tag}.zip`).size / 1e6).toFixed(1), 'MB');
  await inner.evaluate(() => scrollTo(0, 99999));
  await page.waitForTimeout(500);
  await page.locator('iframe').screenshot({ path: `${out}/${tag}-3-frame-bottom.png` });
  await page.click('#mode');
  await frame.locator('#choose').waitFor();
  await shot('4-host-dark');
  console.log(tag, 'dark frame is dark:', await page.frames().find(f => new URL(f.url()).pathname === '/embed').evaluate(() => document.documentElement.classList.contains('dark-mode')));
  const outside = requests.filter(u => !u.startsWith('http://127.0.0.1:8650/') && !u.startsWith('http://localhost:8650/') && !u.startsWith('blob:') && !u.startsWith('data:'));
  console.log(tag, 'requests to anywhere but the local copy:', outside.length ? outside : 'none');

  // 2. The code on the home page.
  await page.goto(home, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const y = document.getElementById('embed').getBoundingClientRect().top + scrollY; scrollTo(0, y - (innerWidth < 600 ? 330 : 330)); });
  await shot('5-home-section');
  await page.click('.about .copy');
  console.log(tag, 'copied from the page:', await page.evaluate(() => navigator.clipboard.readText()));
  console.log(tag, 'button says:', await page.textContent('.about .copy'));

  // 3. The pop-up from the footer.
  await page.locator('[data-embed-open]').scrollIntoViewIfNeeded();
  await page.click('[data-embed-open]');
  await shot('6-home-popup');
  console.log(tag, 'pop-up open:', await page.evaluate(() => document.getElementById('embed-dialog').open), '| controls moved into it:', await page.evaluate(() => !!document.querySelector('#embed-dialog #embed-maker')));
  // The choices rewrite the code.
  await page.click('#embed-dialog .choice:nth-child(2)');
  await page.click('#embed-dialog .switch');
  await page.fill('#embed-dialog #embed-height', '400');
  await page.click('#embed-dialog [data-step="20"]');
  console.log(tag, 'after choosing dark, no sound, 400 then +20:', await page.textContent('#embed-snippet'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  console.log(tag, 'closed with Escape:', await page.evaluate(() => !document.getElementById('embed-dialog').open), '| controls back in the page:', await page.evaluate(() => !!document.querySelector('.about #embed-maker')));
  console.log(tag, 'errors:', errors.length ? errors : 'none');
  await context.close();
}
await browser.close();
