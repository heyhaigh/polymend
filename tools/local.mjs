// Where the tools find things that are not part of this repository: real models to test
// on, and Playwright for driving browsers. Nothing here is specific to one machine.
//
// Settings come from, in order: environment variables, an optional `tools/local.json`
// (ignored by git), then defaults.
//   POLYMEND_CORPUS / "corpus"            folder of .stl and .glb models   (default: ./corpus)
//   POLYMEND_PLAYWRIGHT / "playwrightFrom" folder whose node_modules has Playwright
//                                          (default: this repository, after `npm i -D playwright`)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'tools/local.json');
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

export const corpusDir = path.resolve(root, process.env.POLYMEND_CORPUS || saved.corpus || 'corpus');

/** Every model file under the corpus folder with one of the given extensions, sorted. */
export function models(extensions = ['.stl'], dir = corpusDir, depth = 4) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap(name => {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { return []; } // a dangling link
    if (stat.isDirectory()) return depth > 0 ? models(extensions, full, depth - 1) : [];
    return extensions.includes(path.extname(name).toLowerCase()) ? [full] : [];
  });
}

/** One model to drive the page with. `hint` picks a file whose path contains it. */
export function sample(extension, hint = '') {
  const found = models([extension]).filter(name => !/_fixed\.|-mended\./i.test(name));
  const pick = found.find(name => name.includes(hint)) || found[0];
  if (!pick) throw new Error(`No ${extension} model found under ${corpusDir}. Put some models there, or set POLYMEND_CORPUS.`);
  return pick;
}

export function playwright() {
  for (const from of [process.env.POLYMEND_PLAYWRIGHT, saved.playwrightFrom, root].filter(Boolean)) {
    try { return createRequire(path.join(path.resolve(from), '/'))('playwright'); } catch {}
  }
  throw new Error('Playwright was not found. Run `npm i -D playwright`, or set POLYMEND_PLAYWRIGHT to a folder that has it.');
}
