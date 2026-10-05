// Repair every corpus model, write the result to out/, and print a one-line report each.
import fs from 'node:fs';
import path from 'node:path';
import { parseSTL, writeSTL } from '../src/stl.js';
import { weld } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { corpus } from './corpus.mjs';

fs.mkdirSync('out', { recursive: true });
let allClean = true;
for (const file of corpus) {
  const started = performance.now();
  const { positions, tris } = weld(parseSTL(fs.readFileSync(file)));
  const result = repair(positions, tris);
  const ms = Math.round(performance.now() - started);
  const r = result.report;
  fs.writeFileSync(path.join('out', path.basename(file).replace(/\.stl$/i, '_mended.stl')), writeSTL(result.positions, result.tris));
  allClean &&= r.clean;
  const holes = {};
  for (const size of r.holesFilled) holes[size] = (holes[size] || 0) + 1;
  console.log(`${r.clean ? 'CLEAN ' : 'NOT OK'} ${path.basename(file).padEnd(34)} open ${String(r.before.openEdges).padStart(3)}→${r.after.openEdges}  bad ${String(r.before.nonManifoldEdges).padStart(2)}→${r.after.nonManifoldEdges}  shells ${r.before.shells}→${r.after.shells}  stray -${r.strayFacesRemoved} specks -${r.specksRemoved} pinches ${r.pinchedEdgesCut} holes ${JSON.stringify(holes)} +${r.trianglesAdded} tris, flipped ${r.facesFlipped}, tris ${r.before.triangles}→${r.after.triangles}, volume ${(100 * (r.after.volume / Math.abs(r.before.volume) - 1)).toFixed(4)}%  ${ms} ms`);
  if (r.holesLeftOpen.length) console.log('        left open:', r.holesLeftOpen);
}
console.log(allClean ? '\nAll models clean.' : '\nSome models still have defects.');
process.exit(allClean ? 0 : 1);
