// The whole job for one file: read, weld, measure, repair, measure again.
// Used by the browser worker and by the command-line tools, so both do the same thing.

import { parseSTL } from './stl.js';
import { parseGLB, yUpToZUp } from './glb.js';
import { weld, analyze } from './mesh.js';
import { repair } from './repair.js';
import { selfIntersections } from './intersect.js';

export const LIMITS = { bytes: 400 * 1024 * 1024, triangles: 4_000_000 };

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
export function load(bytes, name = '') {
  if (bytes.length > LIMITS.bytes) throw new Error('This file is larger than 400 MB, which is more than this page can handle.');
  const format = sniff(bytes, name);
  // Positions are rounded to 32-bit floats before welding, because that is what an
  // STL file stores: vertices that will be identical in the output are joined now.
  const soup = format === 'glb' ? Float32Array.from(yUpToZUp(parseGLB(bytes))) : parseSTL(bytes);
  for (let i = 0; i < soup.length; i++) if (!Number.isFinite(soup[i])) throw new Error('This file contains invalid coordinates.');
  if (soup.length / 9 > LIMITS.triangles) throw new Error(`This model has ${Math.round(soup.length / 9).toLocaleString('en-US')} triangles, more than this page can handle (4,000,000).`);
  if (soup.length < 9) throw new Error('No triangles were found in this file.');
  return { format, ...weld(soup) };
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

/** How many places the surface passes through itself, before and after the repair. */
export function countCrossings(mesh, result) {
  return {
    crossingsBefore: selfIntersections(mesh.positions, mesh.tris).pairs,
    crossingsAfter: selfIntersections(result.positions, result.tris).pairs,
  };
}

export { analyze };
