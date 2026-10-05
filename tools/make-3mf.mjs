// Write a repaired, sized 3MF and STL for one corpus model, for opening in a slicer.
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL, writeSTL } from '../src/stl.js';
import { weld } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { layout, write3MF, VERSION } from '../src/output.js';
import { corpus } from './corpus.mjs';

const file = corpus.find(f => f.includes(process.argv[2] || 'crocodile'));
const { positions, tris } = weld(parseSTL(fs.readFileSync(file)));
const result = repair(positions, tris);
const sized = layout(result.positions, { heightMm: 43.2 });
const name = path.basename(file, '.stl');
fs.mkdirSync('out', { recursive: true });
const started = performance.now();
const threeMF = await write3MF(sized.positions, result.tris, { title: name });
fs.writeFileSync(`out/${name}_43mm.3mf`, threeMF);
fs.writeFileSync(`out/${name}_43mm.stl`, writeSTL(sized.positions, result.tris, 1, `polymend ${VERSION}`));
console.log(name, 'size mm', sized.size.map(v => v.toFixed(2)).join(' x '), '| 3MF', (threeMF.length / 1e6).toFixed(1), 'MB in', Math.round(performance.now() - started), 'ms');
