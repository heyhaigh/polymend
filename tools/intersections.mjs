// Count self-intersections before and after repair, and check whether patches add any.
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL } from '../src/stl.js';
import { weld } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { selfIntersections } from '../src/intersect.js';
import { corpus } from './corpus.mjs';

for (const file of corpus) {
  const { positions, tris } = weld(parseSTL(fs.readFileSync(file)));
  let t = performance.now();
  const before = selfIntersections(positions, tris);
  const ms = Math.round(performance.now() - t);
  const result = repair(positions, tris);
  const after = selfIntersections(result.positions, result.tris);
  let onPatches = 0;
  for (let f = 0; f < after.flagged.length; f++) if (after.flagged[f] && result.origin[f] < 0) onPatches++;
  console.log(`${path.basename(file).padEnd(34)} crossing pairs before ${String(before.pairs).padStart(5)}  after ${String(after.pairs).padStart(5)}  patch triangles involved ${onPatches}  (${ms} ms)`);
}
