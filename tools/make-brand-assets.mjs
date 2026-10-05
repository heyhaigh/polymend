// Make the favicon PNGs and the share-preview image from the real page.
// Needs the local server running (node tools/serve.mjs).
import fs from 'node:fs';
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();
const model = sample('.glb', 'crocodile');
const browser = await playwright.chromium.launch();

// Favicon PNGs, drawn from the SVG so they always match it.
const svg = fs.readFileSync('favicon.svg', 'utf8');
for (const [file, size] of [['favicon-48.png', 48], ['apple-touch-icon.png', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

// The side-by-side view of a real repair, in the dark theme.
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 }, deviceScaleFactor: 2 });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://127.0.0.1:8650/?theme=dark');
await page.setInputFiles('#file', model);
await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
await page.addStyleTag({ content: '.stage-button, .stage-hint { display: none !important; }' }).catch(() => {});
await page.evaluate(() => { for (const el of document.querySelectorAll('.stage-button, .stage-hint')) el.hidden = true; });
await page.waitForTimeout(700);
const stage = await page.locator('.stage').screenshot();
await page.close();

// Compose 1200 x 630: the comparison fills the frame, with the name and one line over it.
const font = fs.readFileSync('app/fonts/GeistMono-Variable.woff2').toString('base64');
const card = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await card.setContent(`<!doctype html><style>
@font-face { font-family: 'Geist Mono'; font-weight: 100 900; src: url(data:font/woff2;base64,${font}) format('woff2'); }
* { margin: 0; box-sizing: border-box; }
body { width: 1200px; height: 630px; background: #07121f; color: #e6e5de; font-family: 'Geist Mono', monospace; position: relative; overflow: hidden; }
.shot { position: absolute; left: 452px; top: 104px; width: 716px; height: 414px; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.12); background: url(data:image/png;base64,${stage.toString('base64')}) center / cover; }
.text { position: absolute; left: 60px; top: 0; bottom: 0; width: 360px; display: flex; flex-direction: column; justify-content: center; }
.tile { width: 64px; height: 64px; margin-bottom: 30px; }
h1 { font-size: 58px; font-weight: 400; line-height: 1.1; letter-spacing: -1px; }
p { font-size: 22px; line-height: 1.45; opacity: 0.78; margin-top: 20px; }
.tag { display: inline-block; align-self: flex-start; margin-top: 30px; padding: 6px 12px; border-radius: 6px; font-size: 16px; background: rgba(230, 126, 34, 0.18); color: #f3aa54; }
</style><body><div class="shot"></div>
<div class="text">${svg.replace('<svg ', '<svg class="tile" ')}<h1>Polymend</h1><p>Make problematic 3D models printable.</p><span class="tag">Free · runs in your browser</span></div></body>`);
await card.waitForTimeout(400);
await card.screenshot({ path: 'og-image.jpg', type: 'jpeg', quality: 90 });
await browser.close();
for (const file of ['favicon-48.png', 'apple-touch-icon.png', 'og-image.jpg']) console.log(file, (fs.statSync(file).size / 1024).toFixed(0), 'KB');
