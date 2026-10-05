// Close-ups can be dismissed back to the previous view, and chimes are sent.
import { playwright as findPlaywright, sample } from './local.mjs';
const playwright = findPlaywright();
const model = sample('.stl', 'block-knight');
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://127.0.0.1:8650/');
await page.click('h1'); // a touch on the page, so the browser allows sound
await page.setInputFiles('#file', model);
await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(500);
const sent = () => page.evaluate(() => document.documentElement.dataset.lastSound || null);
console.log('chime after a repair:', await sent());
const view = async () => (await page.locator('#canvas').screenshot()).toString('base64');
const ui = () => page.evaluate(() => ({ back: !document.getElementById('back').hidden, home: !document.getElementById('home').hidden, label: document.getElementById('step-label').textContent, mode: [...document.querySelectorAll('.segmented [aria-pressed="true"]')].map(b => b.textContent)[0] }));

for (const mode of ['both', 'before', 'after']) {
  await page.click(`#show-${mode}`);
  // Turn the model first, so "previous view" is not simply the default one.
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 380, box.y + 330, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(250);
  const before = await view();
  await page.click('#next'); await page.click('#next'); await page.waitForTimeout(250);
  const zoomed = await ui();
  const closeUp = await view();
  if (mode === 'before') await page.keyboard.press('Escape'); else await page.click('#back');
  await page.mouse.move(box.x + 380, box.y + 330); // where the pointer rested for the first picture
  await page.waitForTimeout(300);
  const after = await ui();
  console.log(`${mode}: in close-up`, JSON.stringify(zoomed), '| close-up differs from before:', closeUp !== before, '| dismissed by', mode === 'before' ? 'Escape' : 'Back', '→ same view as before:', (await view()) === before, JSON.stringify(after));
}
// The failure chime.
await page.setInputFiles('#file', 'out/browser/not-a-model.stl');
await page.waitForSelector('#failure:not([hidden])');
console.log('chime after a failure:', await sent(), '| sound button present:', await page.locator('#sound-toggle').count());
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();

// With the browser's strict rule in force (no sound before the visitor acts), choosing a
// file through the button must still be enough for the chime to play.
const strict = await playwright.chromium.launch({ args: ['--autoplay-policy=document-user-activation-required'] });
const visitor = await strict.newPage({ viewport: { width: 1360, height: 1000 } });
await visitor.goto('http://127.0.0.1:8650/');
const chooser = visitor.waitForEvent('filechooser');
await visitor.click('#choose');
await (await chooser).setFiles('out/browser/touching.stl');
await visitor.waitForSelector('#results:not([hidden])');
await visitor.waitForTimeout(500);
console.log('strict browser, file chosen with the button → chime:', await visitor.evaluate(() => document.documentElement.dataset.lastSound || null));
// A page nobody has touched stays silent rather than erroring.
const untouched = await strict.newPage();
const quiet = [];
untouched.on('pageerror', error => quiet.push(error.message));
await untouched.goto('http://127.0.0.1:8650/');
await untouched.setInputFiles('#file', 'out/browser/touching.stl');
await untouched.waitForSelector('#results:not([hidden])');
await untouched.waitForTimeout(500);
console.log('strict browser, page never touched → chime:', await untouched.evaluate(() => document.documentElement.dataset.lastSound || null), '| errors:', quiet.length);
await strict.close();
