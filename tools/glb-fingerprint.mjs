// Fingerprint what the GLB reader makes of every file in a list, or check against a saved
// fingerprint: the rest pose must not change when the reader is reworked.
//   node tools/glb-fingerprint.mjs <list.txt> --save <out.json>
//   node tools/glb-fingerprint.mjs <list.txt> <out.json>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { loadAsync } from '../src/pipeline.js';

const [list, ...rest] = process.argv.slice(2);
const save = rest.includes('--save');
const file = rest.find(arg => arg !== '--save');
const hash = array => crypto.createHash('sha256').update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)).digest('hex').slice(0, 16);
const now = {};
for (const path of fs.readFileSync(list, 'utf8').split('\n').filter(Boolean)) {
  try {
    const mesh = await loadAsync(new Uint8Array(fs.readFileSync(path)), path);
    now[path] = `${hash(mesh.positions)} ${hash(mesh.tris)} ${mesh.notes.join(',')}`;
  } catch (error) { now[path] = `error: ${error.message}`; }
}
if (save) { fs.writeFileSync(file, JSON.stringify(now, null, 1)); console.log(`saved ${Object.keys(now).length} files to ${file}`); process.exit(0); }
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
let different = 0;
for (const [path, value] of Object.entries(saved)) if (now[path] !== value) { different++; console.log('DIFFERENT', path, '\n   was', value, '\n   now', now[path]); }
console.log(different ? `${different} of ${Object.keys(saved).length} files differ` : `identical for all ${Object.keys(saved).length} files`);
process.exit(different ? 1 : 0);
