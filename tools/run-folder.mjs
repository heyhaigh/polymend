// Repair every STL and GLB under a folder and print one line per model: what was wrong,
// what was done, what was left, and how long it took. For trying models unlike the usual
// test set (3D scans, CAD exports). Repaired STLs are written to out/trial/.
// Usage: node tools/run-folder.mjs <folder> [more folders]
import fs from 'node:fs';
import path from 'node:path';
import { load, mend } from '../src/pipeline.js';
import { writeSTL } from '../src/stl.js';
import { models } from './local.mjs';

const out = 'out/trial';
fs.mkdirSync(out, { recursive: true });
const folders = process.argv.slice(2);
if (!folders.length) { console.log('Usage: node tools/run-folder.mjs <folder> [more folders]'); process.exit(1); }
const tally = {};
for (const folder of folders) {
  for (const file of models(['.stl', '.glb'], path.resolve(folder))) {
    if (/_fixed\.|-mended\.|_mended\./i.test(file)) continue;
    const name = path.basename(file);
    const megabytes = (fs.statSync(file).size / 1e6).toFixed(0);
    try {
      const started = performance.now();
      const mesh = load(fs.readFileSync(file), file);
      const result = mend(mesh);
      const ms = (performance.now() - started).toFixed(0);
      const r = result.report, b = r.before, a = r.after;
      tally[r.status] = (tally[r.status] || 0) + 1;
      const left = Object.entries(r.holesLeftOpen.reduce((sum, item) => { const key = typeof item === 'number' ? 'large' : item; sum[key] = (sum[key] || 0) + 1; return sum; }, {})).map(([key, n]) => `${n} ${key}`).join(', ');
      console.log(`${r.status.toUpperCase().padEnd(9)} ${name.slice(0, 38).padEnd(38)} ${megabytes.padStart(3)} MB ${String(b.triangles).padStart(8)} tris ${ms.padStart(6)} ms | open ${b.openEdges}→${a.openEdges}  over-shared ${b.nonManifoldEdges}→${a.nonManifoldEdges}  wrong-facing ${b.inconsistentEdges}→${a.inconsistentEdges}  shells ${b.shells}→${a.shells}  slivers ${b.slivers}→${a.slivers}`
        + ` | stray -${r.strayFacesRemoved} specks -${r.specksRemoved} seam ${r.seamPointsJoined} holes +${r.holesFilled.length} (${r.patchesCrossing} grazing) flipped ${r.facesFlipped}`
        + `${left ? ` | left open: ${left}` : ''}${r.sheetsLeft ? ` | sheets left ${r.sheetsLeft}` : ''}${r.flatPieces ? ` | flat pieces ${r.flatPieces}` : ''}${r.pointsTouching ? ` | pinch points ${r.pointsTouching}` : ''} | crossings ${r.crossingsSkipped ? 'skipped' : `${r.crossingsBefore}→${r.crossingsAfter}`}`);
      fs.writeFileSync(path.join(out, name.replace(/\.(stl|glb)$/i, '') + (path.extname(name).toLowerCase() === '.glb' ? '-from-glb' : '') + '_mended.stl'), writeSTL(result.positions, result.tris));
    } catch (error) {
      tally.refused = (tally.refused || 0) + 1;
      console.log(`REFUSED   ${name.slice(0, 38).padEnd(38)} ${megabytes.padStart(3)} MB | ${error.message}`);
    }
  }
}
console.log('\n' + Object.entries(tally).map(([status, n]) => `${n} ${status}`).join(', '));
