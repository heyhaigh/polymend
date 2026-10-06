#!/usr/bin/env node
// Polymend from the command line: read a GLB or STL, repair it, and write print files.
//
//   node cli.mjs model.glb --height 43.2 --out ./print
//   node cli.mjs model.stl --as-is --out ./print --name fish-king
//
// Writes <name>-mended.stl, <name>-mended.3mf and <name>-report.json into --out, and prints
// a short account of what was found and done. Exit code 0 for "repaired" or "sound", 2 for
// "partly repaired" (files are still written), 1 for a file that could not be read.
//
// --height <mm>   scale the model to this height, stand it on the bed and centre it
// --as-is         keep the file's own numbers (a GLB's meters become millimeters)
// --out <dir>     where to write (default: beside the input)
// --name <name>   output name (default: the input's name without its extension)
// --separate      also cut apart surfaces that touch along an edge (off by default)
// --wide          also close wide openings (off by default: a wide opening may be meant)
// --json          print the report as JSON instead of prose
// Needs Node 20 or later. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { loadAsync, mend } from './src/pipeline.js';
import { writeSTL } from './src/stl.js';
import { layout, write3MF, VERSION } from './src/output.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const input = args.find((arg, i) => !arg.startsWith('--') && !['--height', '--out', '--name'].includes(args[i - 1]));
if (!input || flag('--help')) {
  console.log('Usage: node cli.mjs <model.glb|model.stl> (--height <mm> | --as-is) [--out <dir>] [--name <name>] [--separate] [--wide] [--json]');
  process.exit(input ? 0 : 1);
}
const height = Number(value('--height'));
if (!(height > 0) && !flag('--as-is')) { console.error('Give --height <mm> for the print, or --as-is to keep the file\'s own size.'); process.exit(1); }
const out = value('--out') || path.dirname(path.resolve(input));
const name = value('--name') || path.basename(input).replace(/\.(glb|stl)$/i, '');
const options = { separatePinches: flag('--separate'), patchWide: flag('--wide') };

const say = flag('--json') ? () => {} : text => console.log(text);
let mesh, result;
try {
  const started = performance.now();
  mesh = await loadAsync(fs.readFileSync(input), input, label => say(`${label}…`));
  result = mend(mesh, options, label => say(`${label}…`));
  say(`Read and repaired in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
} catch (error) {
  if (flag('--json')) console.log(JSON.stringify({ status: 'failed', error: error.message }));
  else console.error(`Could not read this file: ${error.message}`);
  process.exit(1);
}

const r = result.report;
const sized = layout(result.positions, { heightMm: height > 0 ? height : undefined, unitMm: mesh.unit === 'meter' ? 1000 : 1 });
fs.mkdirSync(out, { recursive: true });
const stlPath = path.join(out, `${name}-mended.stl`);
const mfPath = path.join(out, `${name}-mended.3mf`);
fs.writeFileSync(stlPath, writeSTL(sized.positions, result.tris, 1, `polymend ${VERSION}`));
fs.writeFileSync(mfPath, await write3MF(sized.positions, result.tris, { title: name }));

const summary = {
  polymend: VERSION, input: path.resolve(input), status: r.status, notes: mesh.notes || [],
  before: r.before, after: r.after, sizeMm: sized.size.map(v => Math.round(v * 100) / 100),
  done: { strayTrianglesRemoved: r.strayFacesRemoved, separatePiecesRemoved: r.specksRemoved, collapsedOrDuplicateRemoved: r.degenerateRemoved + r.duplicateRemoved,
    holesPatched: r.holesFilled.length, holes: r.holes, patchesGrazing: r.patchesCrossing, seamPointsJoined: r.seamPointsJoined, trianglesTurned: r.facesFlipped, pinchedEdgesCut: r.pinchedEdgesCut },
  left: { holesLeftOpen: r.holesLeftOpen, sheetsLeft: r.sheetsLeft, flatPieces: r.flatPieces, pinchedEdgesLeft: r.pinchedEdgesLeft, selfCrossings: r.crossingsSkipped ? null : r.crossingsAfter, pointsTouching: r.pointsTouching },
  files: { stl: stlPath, threeMF: mfPath },
};
fs.writeFileSync(path.join(out, `${name}-report.json`), JSON.stringify(summary, null, 2));

if (flag('--json')) console.log(JSON.stringify(summary));
else {
  const b = r.before, a = r.after;
  const title = { repaired: 'Repaired', sound: 'Nothing to fix', partial: 'Partly repaired' }[r.status];
  say(`\n${title}: open edges ${b.openEdges} → ${a.openEdges}, non-manifold edges ${b.nonManifoldEdges} → ${a.nonManifoldEdges}, wrongly facing joins ${b.inconsistentEdges} → ${a.inconsistentEdges}, pieces ${b.shells} → ${a.shells}.`);
  const did = [r.strayFacesRemoved && `removed ${r.strayFacesRemoved} stray triangles`, r.specksRemoved && `removed ${r.specksRemoved} small separate pieces`, r.degenerateRemoved + r.duplicateRemoved && `removed ${r.degenerateRemoved + r.duplicateRemoved} collapsed or duplicate triangles`,
    r.holesFilled.length && `patched ${r.holesFilled.length} holes${r.patchesCrossing ? ` (${r.patchesCrossing} grazing nearby surface)` : ''}`, r.seamPointsJoined && `joined ${r.seamPointsJoined} seam points`, r.facesFlipped && `turned ${r.facesFlipped} triangles`].filter(Boolean);
  if (did.length) say(`Did: ${did.join(', ')}.`);
  if (r.status === 'partial') say(`Left: ${JSON.stringify(summary.left)}. The slicer will probably still warn; a general repair tool or a 3D editor is the next step.`);
  if (mesh.notes?.length) say(`Note: this GLB has ${mesh.notes.join(', ')}; it was read in its rest pose.`);
  say(`Size: ${summary.sizeMm.join(' × ')} mm${height > 0 ? ` (height set to ${height} mm)` : ' (the file\'s own size)'}.`);
  say(`Wrote ${stlPath}\n      ${mfPath}`);
}
process.exit(r.status === 'partial' ? 2 : 0);
