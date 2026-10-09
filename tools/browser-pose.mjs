// Poses: a rigged, animated GLB in the page. Chooses a clip, scrubs it, lets go, steps to
// a keyframe, checks the downloaded file is named for the pose, and goes back to the rest pose.
// Usage: node tools/browser-pose.mjs <rigged-and-animated.glb> [<another .glb or .stl>, for a batch]
//        (ENGINE=webkit for Safari's engine)
import fs from 'node:fs';
import { playwright as findPlaywright } from './local.mjs';
const playwright = findPlaywright();
const model = process.argv[2];
if (!model || !fs.existsSync(model)) { console.error('Give a rigged, animated .glb file.'); process.exit(1); }
const engine = process.env.ENGINE || 'chromium';
const out = 'out/pose';
fs.mkdirSync(out, { recursive: true });
const browser = await playwright[engine].launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })).newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
// WebKit logs this when Playwright itself takes a screenshot (it adds a stylesheet, which the page's
// security policy refuses); real visits never show it.
const SCREENSHOT_NOISE = /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'/;
page.on('console', message => { if (message.type() === 'error' && !SCREENSHOT_NOISE.test(message.text())) errors.push(message.text()); });
const settled = () => page.waitForFunction(() => !document.getElementById('pose-clip').disabled && !/busy/.test(document.getElementById('status').className), null, { timeout: 60_000 });
const read = () => page.evaluate(() => ({
  panel: !document.getElementById('pose').hidden, clip: document.getElementById('pose-clip').selectedOptions[0]?.textContent, options: document.getElementById('pose-clip').options.length,
  scrub: !document.getElementById('pose-scrub').hidden, time: document.getElementById('pose-time').textContent, status: document.getElementById('status').textContent,
  outcome: document.getElementById('outcome-title').textContent, note: [...document.querySelectorAll('#outcome-reasons li')].map(li => li.textContent).find(text => /GLB has/.test(text)) || '',
}));
// How much of the 3D view the model covers: the share of pixels unlike the stage's corner.
// A model the camera has lost (too small, or out of frame) covers almost nothing.
const { execFileSync: run } = await import('node:child_process');
async function coverage(name) {
  const file = `${out}/${engine}-${name}.png`;
  await page.waitForTimeout(300);
  await page.locator('.stage').screenshot({ path: file });
  const corner = run('magick', [file, '-format', '%[pixel:p{12,40}]', 'info:']).toString().trim();
  return Number(run('magick', [file, '-fuzz', '6%', '-fill', 'black', '-opaque', corner, '-fill', 'white', '+opaque', 'black', '-format', '%[fx:mean]', 'info:']).toString());
}
const VISIBLE = 0.05;
let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` | ${detail}` : ''}`); if (!ok) failed++; };

await page.goto('http://127.0.0.1:8650/', { waitUntil: 'load' });
await page.setInputFiles('#file', model);
await settled();
let s = await read();
check('panel shows for a file with clips, in the rest pose', s.panel && s.clip === 'Rest pose, as stored' && !s.scrub, `${s.options - 1} clips`);
check('the outcome says rest pose and points to the panel', /rest pose/.test(s.note) && /choose a clip/.test(s.note));
await page.screenshot({ path: `${out}/${engine}-1-rest.png` });

// A clip: repaired at its first moment.
await page.selectOption('#pose-clip', { index: Math.min(2, s.options - 1) });
await settled();
s = await read();
check('choosing a clip repairs its first moment', s.scrub && /^0\.00 s \//.test(s.time) && /repaired in the pose from/.test(s.note), `${s.clip} | ${s.time}`);
let seen = await coverage('clip');
check('the posed model fills the view, not a speck', seen > VISIBLE, `covers ${(seen * 100).toFixed(1)}% of the view`);

// Scrub: previews follow while dragging; the repair runs on release.
const box = await page.locator('#pose-slider').boundingBox();
await page.mouse.move(box.x + 4, box.y + box.height / 2);
await page.mouse.down();
for (let i = 1; i <= 8; i++) { await page.mouse.move(box.x + box.width * (0.1 * i), box.y + box.height / 2); await page.waitForTimeout(60); }
seen = await coverage('scrubbing');
check('while dragging, the preview fills the view', seen > VISIBLE, `covers ${(seen * 100).toFixed(1)}% of the view`);
const during = await read();
await page.mouse.up();
await settled();
s = await read();
check('while dragging, the time follows and nothing is repaired yet', !/^0\.00 s/.test(during.time) && /at 0\.00 s/.test(during.note), `${during.time} | outcome still at 0.00 s: ${/at 0\.00 s/.test(during.note)}`);
check('letting go repairs that moment', !/^0\.00 s/.test(s.time) && /repaired in the pose from/.test(s.note), s.time);
await page.screenshot({ path: `${out}/${engine}-3-released.png` });

// Keyframes: the arrow button and the keyboard.
const before = s.time;
await page.click('#pose-next');
await settled();
s = await read();
check('the next-keyframe button moves to a keyframe and repairs it', s.time !== before, `${before} -> ${s.time}`);
await page.focus('#pose-slider');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(500);
await settled();
const keyed = await read();
check('arrow keys step back through keyframes and repair once they stop', keyed.time !== s.time, `${s.time} -> ${keyed.time}`);

// The download is named for the pose.
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download-all')]);
check('the download is named for the pose', /-\d+\.\d\ds-mended\.zip$/.test(download.suggestedFilename()), download.suggestedFilename());

// Back to the rest pose.
await page.selectOption('#pose-clip', '');
await settled();
s = await read();
check('the rest pose comes back', s.clip === 'Rest pose, as stored' && !s.scrub && /rest pose/.test(s.note));
seen = await coverage('rest-again');
check('the rest pose fills the view again', seen > VISIBLE, `covers ${(seen * 100).toFixed(1)}% of the view`);

// A batch: each model keeps its own pose, and the ZIP holds that pose.
const second = process.argv[3];
if (second) {
  await page.setInputFiles('#file', [model, second]);
  await page.waitForFunction(() => !document.getElementById('batch-download').disabled, null, { timeout: 120_000 });
  await settled();
  await page.selectOption('#pose-clip', { index: 1 });
  await settled();
  await page.click('#pose-next');
  await settled();
  const chosen = await read();
  await page.click('#model-next'); await settled();
  await page.click('#model-prev'); await settled();
  s = await read();
  check('in a batch, a model keeps its pose when you come back to it', s.clip === chosen.clip && s.time === chosen.time && /repaired in the pose from/.test(s.note), `${chosen.clip} ${chosen.time}`);
  await page.waitForFunction(() => !document.getElementById('batch-download').disabled && !/Building/.test(document.getElementById('batch-download-label').textContent), null, { timeout: 120_000 });
  const [zip] = await Promise.all([page.waitForEvent('download'), page.click('#batch-download')]);
  const zipPath = `${out}/${engine}-batch.zip`;
  await zip.saveAs(zipPath);
  // The same pose from the command line, at the same height, gives the same model.
  const time = Number(await page.inputValue('#pose-slider')), clipName = chosen.clip.split(' · ')[0];
  const { execFileSync } = await import('node:child_process');
  const height = await page.inputValue('#height');
  // Exit code 2 means "partly repaired": the files are still written.
  try { execFileSync('node', ['cli.mjs', model, '--clip', clipName, '--time', String(time), '--height', height, '--out', `${out}/cli`, '--name', 'posed', '--json']); } catch (error) { if (error.status !== 2) throw error; }
  fs.rmSync(`${out}/unzipped`, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', `${out}/unzipped`]);
  const stls = fs.readdirSync(`${out}/unzipped`).filter(name => name.endsWith('.stl'));
  const box = file => { const b = fs.readFileSync(file); const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let f = 0; f < b.readUInt32LE(80); f++) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { const v = b.readFloatLE(84 + f * 50 + 12 + k * 12 + c * 4); lo[c] = Math.min(lo[c], v); hi[c] = Math.max(hi[c], v); } return [...lo, ...hi].map(v => v.toFixed(2)).join(','); };
  const fromCli = box(`${out}/cli/posed-mended.stl`);
  const inZip = stls.map(name => box(`${out}/unzipped/${name}`));
  try { execFileSync('node', ['cli.mjs', model, '--height', height, '--out', `${out}/cli`, '--name', 'rest', '--json']); } catch (error) { if (error.status !== 2) throw error; }
  const rest = box(`${out}/cli/rest-mended.stl`);
  check('the batch ZIP holds the posed model, the same as the command line makes', inZip.includes(fromCli) && !inZip.includes(rest) && rest !== fromCli, `cli ${fromCli} | zip ${inZip.join(' ; ')} | rest pose ${rest}`);
}
check('no errors in the page', !errors.length, errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
