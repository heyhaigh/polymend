// Screenshots of the page in its main states, light and dark, desktop and phone.
import fs from 'node:fs';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();
const model = sample('.glb', 'crocodile');
fs.mkdirSync('out/shots', { recursive: true });
const browser = await playwright.chromium.launch();
for (const [name, viewport, theme, scale] of [['desktop-light', { width: 1360, height: 1000 }, 'light', 1], ['desktop-dark', { width: 1360, height: 1000 }, 'dark', 1], ['phone-light', { width: 390, height: 844 }, 'light', 2]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  await page.goto(`http://127.0.0.1:8650/?theme=${theme}`);
  await page.waitForTimeout(500);
  if (name === 'desktop-light') { await page.mouse.move(520, 470); await page.mouse.move(620, 500, { steps: 8 }); await page.waitForTimeout(300); }
  await page.screenshot({ path: `out/shots/${name}-start.png` });
  await page.setInputFiles('#file', model);
  await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `out/shots/${name}-result.png`, fullPage: name.startsWith('phone') });
  if (name === 'desktop-light') {
    await page.click('#next'); await page.click('#next'); await page.waitForTimeout(500);
    await page.screenshot({ path: `out/shots/${name}-change.png` });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(300);
    await page.screenshot({ path: `out/shots/${name}-bottom.png` });
  }
  if (name !== 'phone-light') { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(300); await page.screenshot({ path: `out/shots/${name}-credit.png` }); }
  await page.close();
}
await browser.close();
console.log('done');
