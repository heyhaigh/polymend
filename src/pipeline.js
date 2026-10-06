// The whole job for one file: read, weld, measure, repair, measure again.
// Used by the browser worker and by the command-line tools, so both do the same thing.

import { parseSTL, tooMany } from './stl.js';
import { parseGLB, yUpToZUp } from './glb.js';
import { weld, analyze } from './mesh.js';
import { repair } from './repair.js';
import { selfIntersections } from './intersect.js';

// The most this page takes on. Measured, not hoped for: a million triangles needs about
// 1 GB of memory and six seconds on a laptop, which is near what a browser tab allows.
// `crossingCheck` is the size above which the for-information self-crossing count is
// skipped, because it is the most memory-hungry step and changes nothing in the file.
export const LIMITS = { bytes: 200 * 1024 * 1024, triangles: 1_000_000, crossingCheck: 600_000 };

/** Work out the format from the file's contents first, its name second. */
export function sniff(bytes, name = '') {
  if (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
  if (/\.stl$/i.test(name)) return 'stl';
  if (/\.glb$/i.test(name)) return 'glb';
  if (/\.gltf$/i.test(name)) throw new Error('This is a .gltf file with separate parts. Export a single .glb file instead.');
  // Any other named type is refused plainly. A file with no extension is tried as an STL.
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (extension) throw new Error(`${extension[1].toUpperCase()} files are not supported. Use a GLB or STL file.`);
  return 'stl';
}

/** Read a file into a welded mesh. GLB models are turned from Y-up to Z-up. */
export function load(bytes, name = '', { draco } = {}) {
  const megabytes = Math.round(LIMITS.bytes / (1024 * 1024));
  if (bytes.length > LIMITS.bytes) throw new Error(`This file is larger than ${megabytes} MB, which is more than this page can handle.`);
  const format = sniff(bytes, name);
  const tooManyTriangles = total => new Error(`This model has about ${Math.round(total).toLocaleString('en-US')} triangles, more than this page can handle (${LIMITS.triangles.toLocaleString('en-US')}).`);
  let soup;
  const notes = [];
  try {
    // Positions are rounded to 32-bit floats before welding, because that is what an
    // STL file stores: vertices that will be identical in the output are joined now.
    soup = format === 'glb' ? Float32Array.from(yUpToZUp(parseGLB(bytes, { maxTriangles: LIMITS.triangles, tooMany, notes, draco })))
      : parseSTL(bytes, { maxTriangles: LIMITS.triangles });
  } catch (error) {
    if (error && error.needsDraco) throw error; // for loadAsync, which unpacks and reads again
    if (error && error.tooMany) throw tooManyTriangles(error.tooMany);
    // A reader tripping over nonsense in the file is the file's fault, not a crash to report.
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) throw new Error(`This file is damaged, or is not laid out as ${format === 'glb' ? 'a GLB' : 'an STL'} file should be.`);
    throw error;
  }
  for (let i = 0; i < soup.length; i++) if (!Number.isFinite(soup[i])) throw new Error('This file contains invalid coordinates.');
  if (soup.length / 9 > LIMITS.triangles) throw tooManyTriangles(soup.length / 9);
  if (soup.length < 9) throw new Error('No triangles were found in this file.');
  // GLB coordinates are meters by definition; an STL does not say what its numbers mean.
  // `notes` lists what the file had that was not applied: 'rigged', 'animated', 'morphs'.
  return { format, unit: format === 'glb' ? 'meter' : null, notes, ...weld(soup) };
}

/**
 * `load`, plus Draco-compressed GLB files. The decoder is 700 KB, so it is fetched from the
 * site only the first time a file needs it. `progress` is told while that happens.
 */
export async function loadAsync(bytes, name = '', progress = () => {}) {
  try {
    return load(bytes, name);
  } catch (error) {
    if (!error || !error.needsDraco) throw error;
    progress('Unpacking compressed geometry');
    const { decodeDraco } = await import('./draco.js');
    const draco = new Map();
    let budget = LIMITS.triangles;
    for (const { key, bytes: packed, attribute } of error.needsDraco) {
      let unpacked;
      try { unpacked = await decodeDraco(packed, attribute, { maxTriangles: budget }); } catch (fault) {
        if (fault && fault.tooMany) throw new Error(`This model has more than ${LIMITS.triangles.toLocaleString('en-US')} triangles, which is more than this page can handle.`);
        throw fault;
      }
      budget -= unpacked.indices.length / 3;
      draco.set(key, unpacked);
    }
    return load(bytes, name, { draco });
  }
}

/**
 * Repair a loaded mesh. `progress` is called with a short label before each stage.
 * The result holds everything the page shows: counts before and after, what changed,
 * and enough to draw the changes.
 *
 * Counting self-crossings is only for information and takes about as long as the repair
 * itself, so a caller in a hurry can pass `crossings: false` and call `countCrossings`
 * once the result is on screen.
 */
export function mend(mesh, options = {}, progress = () => {}, { crossings = true } = {}) {
  progress('Repairing');
  const result = repair(mesh.positions, mesh.tris, options);
  // Which input faces were deleted, for drawing.
  const kept = new Uint8Array(mesh.tris.length / 3);
  for (const f of result.origin) if (f >= 0) kept[f] = 1;
  const report = { ...result.report };
  if (crossings) { progress('Checking the result'); Object.assign(report, countCrossings(mesh, result)); }
  return { ...result, kept, report };
}

/**
 * How many places the surface passes through itself, before and after the repair. Either
 * number is null when the count was skipped because it would have taken too long.
 */
export function countCrossings(mesh, result) {
  if (mesh.tris.length / 3 > LIMITS.crossingCheck) return { crossingsBefore: null, crossingsAfter: null, crossingsSkipped: true };
  const before = selfIntersections(mesh.positions, mesh.tris).pairs;
  const after = before === null ? null : selfIntersections(result.positions, result.tris).pairs;
  return { crossingsBefore: before, crossingsAfter: after, crossingsSkipped: before === null || after === null };
}

export { analyze };
