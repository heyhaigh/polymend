#!/usr/bin/env node
// Polymend from the command line: read GLB or STL files, repair them, and write print files.
//
//   node cli.mjs model.glb --height 43.2 --out ./print
//   node cli.mjs model.stl --as-is --out ./print --name fish-king
//   node cli.mjs ./figures --height 43.2 --out ./print          (every .glb and .stl in a folder)
//   node cli.mjs a.glb b.glb c.stl --height 43.2 --out ./print   (several files)
//
// For each model, writes <name>-mended.stl, <name>-mended.3mf and <name>-report.json into
// --out, and prints a short account of what was found and done. With more than one model it
// also writes polymend-batch.json, listing every model and its result.
// Exit code: 0 when every model is "repaired" or "sound", 2 when any is "partly repaired"
// (files are still written), 1 when any file could not be read.
//
// --height <mm>   scale each model to this height, stand it on the bed and centre it
// --as-is         keep the files' own numbers (a GLB's meters become millimeters)
// --out <dir>     where to write (default: beside each input)
// --name <name>   output name, for a single model only (default: the input's name)
// --separate      also cut apart surfaces that touch along an edge (off by default)
// --wide          also close wide openings (off by default: a wide opening may be meant)
// --json          print the report as JSON instead of prose
// Needs Node 20 or later. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { loadAsync, mend, LIMITS } from './src/pipeline.js';
import { writeSTL } from './src/stl.js';
import { layout, write3MF, VERSION } from './src/output.js';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const WITH_VALUE = ['--height', '--out', '--name'];
const KNOWN = [...WITH_VALUE, '--as-is', '--separate', '--wide', '--json', '--help'];
const given = args.filter((arg, i) => !arg.startsWith('--') && !WITH_VALUE.includes(args[i - 1]));
const USAGE = 'Usage: node cli.mjs <model.glb|model.stl|folder>... (--height <mm> | --as-is) [--out <dir>] [--name <name>] [--separate] [--wide] [--json]';
if (!given.length || flag('--help')) { console.log(USAGE); process.exit(given.length ? 0 : 1); }
const stop = text => { console.error(text); process.exit(1); };
for (const arg of args.filter(arg => arg.startsWith('--'))) if (!KNOWN.includes(arg)) stop(`Unknown option ${arg}.\n${USAGE}`);
for (const name of WITH_VALUE) if (flag(name) && (!value(name) || value(name).startsWith('--'))) stop(`${name} needs a value.`);
// Names are printed and written into reports: no control or direction characters.
const clean = text => String(text).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');

const MODEL = /\.(glb|stl)$/i;
const OWN_OUTPUT = /-mended\.(glb|stl)$/i; // this tool's own output, from an earlier run
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
// A folder stands for the models directly inside it, in name order. Subfolders, entries
// that cannot be read (such as a broken link) and earlier outputs of this tool are left out.
const inputs = given.flatMap(item => {
  let stat;
  try { stat = fs.statSync(item); } catch { stop(`Not found: ${clean(item)}`); }
  if (!stat.isDirectory()) { if (!stat.isFile()) stop(`Not a file: ${clean(item)}`); return [item]; }
  const found = fs.readdirSync(item).filter(name => MODEL.test(name) && !OWN_OUTPUT.test(name) && isFile(path.join(item, name))).sort().map(name => path.join(item, name));
  if (!found.length) stop(`No .glb or .stl files in ${clean(item)}`);
  return found;
});
const height = Number(value('--height'));
if (flag('--height') && !(height > 0 && Number.isFinite(height))) stop('--height must be a number of millimeters above zero.');
if (!(height > 0) && !flag('--as-is')) stop('Give --height <mm> for the print, or --as-is to keep the file\'s own size.');
if (value('--name') && inputs.length > 1) stop('--name is for a single model; with several, each keeps its own name.');
// --name names the files; it cannot point somewhere else.
if (value('--name') && (/[\\/]/.test(value('--name')) || /^\.+$/.test(value('--name')))) stop('--name is a file name, not a path: no slashes. Use --out for the folder.');
const outDir = value('--out');
if (outDir && fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) stop(`--out must be a folder: ${clean(outDir)}`);
const options = { separatePinches: flag('--separate'), patchWide: flag('--wide') };
const json = flag('--json');
const say = json ? () => {} : text => console.log(text);
const TITLES = { repaired: 'Repaired', sound: 'Nothing to fix', partial: 'Partly repaired', failed: 'Could not be read' };

// Two inputs with the same name would write over each other's files, also where a computer
// ignores capitals; later ones get the first free number.
const taken = new Set();
const nameFor = input => {
  const base = clean((inputs.length === 1 && value('--name')) || path.basename(input).replace(MODEL, '')).trim() || 'model';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  taken.add(name.toLowerCase());
  return name;
};

/** Repair one model and write its files. Returns its summary; a file that cannot be read gives status "failed". */
async function repairOne(input) {
  const name = nameFor(input);
  const out = value('--out') || path.dirname(path.resolve(input));
  let mesh, result;
  try {
    // Refuse an oversized file before reading it, rather than after.
    if (fs.statSync(input).size > LIMITS.bytes) throw new Error(`It is larger than ${LIMITS.bytes / 1024 ** 2} MB, the most Polymend reads.`);
    const started = performance.now();
    mesh = await loadAsync(fs.readFileSync(input), input, label => say(`${label}…`));
    result = mend(mesh, options, label => say(`${label}…`));
    say(`Read and repaired in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  } catch (error) {
    if (!json) console.error(`Could not read ${clean(input)}: ${clean(error.message)}`);
    return { polymend: VERSION, input: path.resolve(input), status: 'failed', error: clean(error.message) };
  }
  try {
    return await writeOne(input, name, out, mesh, result);
  } catch (error) {
    // A full disk or a folder that cannot be written fails this model; the rest carry on.
    if (!json) console.error(`Could not write the files for ${clean(input)}: ${clean(error.message)}`);
    return { polymend: VERSION, input: path.resolve(input), status: 'failed', error: `Could not write the files: ${clean(error.message)}` };
  }
}

async function writeOne(input, name, out, mesh, result) {

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

  const b = r.before, a = r.after;
  say(`\n${TITLES[r.status]}: open edges ${b.openEdges} → ${a.openEdges}, non-manifold edges ${b.nonManifoldEdges} → ${a.nonManifoldEdges}, wrongly facing joins ${b.inconsistentEdges} → ${a.inconsistentEdges}, pieces ${b.shells} → ${a.shells}.`);
  const did = [r.strayFacesRemoved && `removed ${r.strayFacesRemoved} stray triangles`, r.specksRemoved && `removed ${r.specksRemoved} small separate pieces`, r.degenerateRemoved + r.duplicateRemoved && `removed ${r.degenerateRemoved + r.duplicateRemoved} collapsed or duplicate triangles`,
    r.holesFilled.length && `patched ${r.holesFilled.length} holes${r.patchesCrossing ? ` (${r.patchesCrossing} grazing nearby surface)` : ''}`, r.seamPointsJoined && `joined ${r.seamPointsJoined} seam points`, r.facesFlipped && `turned ${r.facesFlipped} triangles`].filter(Boolean);
  if (did.length) say(`Did: ${did.join(', ')}.`);
  if (r.status === 'partial') say(`Left: ${JSON.stringify(summary.left)}. The slicer will probably still warn; a general repair tool or a 3D editor is the next step.`);
  if (mesh.notes?.length) say(`Note: this GLB has ${mesh.notes.join(', ')}; it was read in its rest pose.`);
  say(`Size: ${summary.sizeMm.join(' × ')} mm${height > 0 ? ` (height set to ${height} mm)` : ' (the file\'s own size)'}.`);
  say(`Wrote ${stlPath}\n      ${mfPath}`);
  return summary;
}

const summaries = [];
for (const [i, input] of inputs.entries()) {
  if (inputs.length > 1) say(`\n[${i + 1}/${inputs.length}] ${clean(input)}`);
  summaries.push(await repairOne(input));
}

if (inputs.length === 1) {
  const [only] = summaries;
  if (json) console.log(JSON.stringify(only.status === 'failed' ? { status: 'failed', error: only.error } : only));
  process.exit(only.status === 'failed' ? 1 : only.status === 'partial' ? 2 : 0);
}

const count = status => summaries.filter(s => s.status === status).length;
const batch = {
  polymend: VERSION, models: summaries.length,
  repaired: count('repaired'), sound: count('sound'), partial: count('partial'), failed: count('failed'),
  results: summaries.map(s => ({ input: s.input, status: s.status, ...(s.error ? { error: s.error } : { files: s.files }) })),
};
const batchDir = value('--out') || path.dirname(path.resolve(inputs[0]));
fs.mkdirSync(batchDir, { recursive: true });
fs.writeFileSync(path.join(batchDir, 'polymend-batch.json'), JSON.stringify(batch, null, 2));
if (json) console.log(JSON.stringify(batch));
else {
  say(`\n${summaries.length} models: ${['repaired', 'sound', 'partial', 'failed'].filter(count).map(s => `${count(s)} ${TITLES[s].toLowerCase()}`).join(', ')}.`);
  for (const s of summaries) say(`  ${TITLES[s.status].padEnd(17)} ${clean(path.basename(s.input))}`);
  say(`Wrote ${path.join(batchDir, 'polymend-batch.json')}`);
}
process.exit(batch.failed ? 1 : batch.partial ? 2 : 0);
