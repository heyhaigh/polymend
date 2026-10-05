// Screenshots of the top of the page in each state: before a file, after a repair,
// after a refusal, and a refusal while a model is showing. Desktop and phone.
// Usage: node tools/browser-top.mjs
import fs from 'node:fs';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();
const out = 'out/top';
fs.mkdirSync(out, { recursive: true });
const model = sample('.stl', 'crocodile');
const wrong = { name: 'holiday photo.png', mimeType: 'image/png', buffer: Buffer.alloc(200) };

const browser = await playwright.chromium.launch();
for (const [tag, options] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['phone', playwright.devices['Pixel 7']]]) {
  const page = await (await browser.newContext(options)).newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8650/', { waitUntil: 'load' });
  await page.waitForTimeout(400);
  const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${tag}-${name}.png` }); };
  const top = () => page.evaluate(() => {
    const box = id => { const el = document.getElementById(id); return el.hidden ? null : Math.round(el.getBoundingClientRect().top); };
    const title = document.querySelector('.tool-title').getBoundingClientRect();
    return { titleVisible: title.width > 2, subtitleShown: getComputedStyle(document.querySelector('.tool-subtitle')).display !== 'none',
      failureTop: box('failure'), outcomeTop: box('outcome'), metaTop: Math.round(document.querySelector('.tool-meta').getBoundingClientRect().top),
      dropTop: box('drop'), scrollY: Math.round(scrollY), sticky: document.getElementById('top-stick').style.top, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  await shot('1-start'); console.log(tag, 'start', JSON.stringify(await top()));
  await page.setInputFiles('#file', wrong);
  await page.waitForSelector('#failure:not([hidden])');
  await shot('2-refused'); console.log(tag, 'refused', JSON.stringify(await top()));
  await page.evaluate(() => scrollTo(0, 900));
  await page.setInputFiles('#file', model);
  await page.waitForSelector('#results:not([hidden])', { timeout: 120000 });
  await shot('3-repaired'); console.log(tag, 'repaired', JSON.stringify(await top()));
  await page.evaluate(() => scrollTo(0, 700));
  await shot('4-scrolled'); console.log(tag, 'scrolled', JSON.stringify(await top()));
  await page.setInputFiles('#file', wrong);
  await page.waitForSelector('#failure:not([hidden])');
  await shot('5-refused-with-model'); console.log(tag, 'refused with a model', JSON.stringify(await top()));
  console.log(tag, 'errors:', errors.length ? errors : 'none');
}
await browser.close();
