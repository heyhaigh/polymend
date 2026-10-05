// Where the time goes for one model, stage by stage, in Node.
import fs from 'node:fs';
import { parseSTL, writeSTL } from '../src/stl.js';
import { weld, analyze, EdgeTable } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { selfIntersections } from '../src/intersect.js';
import { layout, write3MF, zip } from '../src/output.js';
import { corpus } from './corpus.mjs';

const file = corpus.find(f => f.includes(process.argv[2] || 'crocodile'));
const rows = [];
const time = async (label, work) => { const t = performance.now(); const out = await work(); rows.push([label, performance.now() - t]); return out; };
const bytes = await time('read file from disk', () => fs.readFileSync(file));
const soup = await time('parse STL', () => parseSTL(bytes));
const mesh = await time('weld vertices', () => weld(soup));
await time('edge table, one build', () => new EdgeTable(mesh.tris));
await time('analyze, as called before repair', () => analyze(mesh.positions, mesh.tris));
await time('self-intersections, before', () => selfIntersections(mesh.positions, mesh.tris));
const result = await time('repair (includes two analyze calls)', () => repair(mesh.positions, mesh.tris));
await time('self-intersections, after', () => selfIntersections(result.positions, result.tris));
const sized = await time('layout', () => layout(result.positions, { heightMm: 50 }));
const stl = await time('write STL', () => writeSTL(sized.positions, result.tris));
const threeMF = await time('write 3MF (XML + deflate)', () => write3MF(sized.positions, result.tris));
await time('ZIP of both', () => zip([['a.stl', stl], ['a.3mf', threeMF]]));
const total = rows.reduce((s, r) => s + r[1], 0);
console.log(`${file.split('/').pop()}: ${mesh.tris.length / 3} triangles, ${(bytes.length / 1e6).toFixed(1)} MB`);
for (const [label, ms] of rows) console.log(`  ${label.padEnd(38)} ${ms.toFixed(0).padStart(5)} ms  ${(100 * ms / total).toFixed(0).padStart(3)}%`);
console.log(`  ${'total'.padEnd(38)} ${total.toFixed(0).padStart(5)} ms   heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
