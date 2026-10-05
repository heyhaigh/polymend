// Fingerprint the engine's exact output for every corpus model, or check against a saved
// fingerprint. Used when changing how the engine works without changing what it does.
//   node tools/snapshot.mjs --save     write out/snapshot.json
//   node tools/snapshot.mjs            compare with it; exit 1 on any difference
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load, mend } from '../src/pipeline.js';
import { corpus } from './corpus.mjs';

const hash = array => crypto.createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex').slice(0, 16);
const file = 'out/snapshot.json';
const now = {};
let total = 0;
for (const model of corpus) {
  const bytes = fs.readFileSync(model);
  const started = performance.now();
  const result = mend(load(bytes, model));
  total += performance.now() - started;
  now[path.basename(model)] = { positions: hash(result.positions), tris: hash(result.tris), origin: hash(result.origin), flipped: hash(result.flipped), kept: hash(result.kept), report: JSON.stringify(result.report) };
}
console.log(`${corpus.length} models, ${(total / corpus.length).toFixed(0)} ms each on average (read, weld, repair, self-crossing counts)`);
if (process.argv.includes('--save')) { fs.mkdirSync('out', { recursive: true }); fs.writeFileSync(file, JSON.stringify(now, null, 1)); console.log('saved', file); process.exit(0); }
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
let different = 0;
for (const [name, entry] of Object.entries(saved)) {
  const parts = Object.keys(entry).filter(key => now[name]?.[key] !== entry[key]);
  if (parts.length) { different++; console.log('DIFFERENT', name, parts.join(', ')); if (parts.includes('report')) console.log('   was', entry.report.slice(0, 300), '\n   now', (now[name]?.report || '').slice(0, 300)); }
}
console.log(different ? `${different} models differ` : 'identical output for every model');
process.exit(different ? 1 : 0);
