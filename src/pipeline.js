// The whole job for one file: read, weld, measure, repair, measure again.
// Used by the browser worker and by the command-line tools, so both do the same thing.

import { parseSTL, tooMany } from './stl.js';
import { openGLB, yUpToZUp } from './glb.js';
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

/**
 * Read a file into a welded mesh. GLB models are turned from Y-up to Z-up.
 * `pose` is `{ clip, time }` for one moment of a GLB file's animation clip, or null for the
 * shape as stored. A GLB's result also lists its `clips`, and `posed(pose)` gives the
 * unwelded triangles of another pose quickly, for showing while a pose is being chosen.
 */
export function load(bytes, name = '', { draco, pose = null } = {}) {
  const megabytes = Math.round(LIMITS.bytes / (1024 * 1024));
  if (bytes.length > LIMITS.bytes) throw new Error(`This file is larger than ${megabytes} MB, which is more than this page can handle.`);
  const format = sniff(bytes, name);
  const tooManyTriangles = total => new Error(`This model has about ${Math.round(total).toLocaleString('en-US')} triangles, more than this page can handle (${LIMITS.triangles.toLocaleString('en-US')}).`);
  let soup, glb = null, at = null;
  const notes = [];
  const fault = error => {
    if (error && error.needsDraco) return error; // for loadAsync, which unpacks and reads again
    if (error && error.tooMany) return tooManyTriangles(error.tooMany);
    // A reader tripping over nonsense in the file is the file's fault, not a crash to report.
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return new Error(`This file is damaged, or is not laid out as ${format === 'glb' ? 'a GLB' : 'an STL'} file should be.`);
    return error;
  };
  try {
    // Positions are rounded to 32-bit floats before welding, because that is what an
    // STL file stores: vertices that will be identical in the output are joined now.
    if (format === 'glb') {
      glb = openGLB(bytes, { maxTriangles: LIMITS.triangles, tooMany, notes, draco });
      if (pose) {
        const clip = glb.clips[pose.clip];
        if (!clip) throw new Error('This file has no such animation.');
        at = { clip: clip.index, time: Math.min(Math.max(Number(pose.time) || 0, 0), clip.duration) };
      }
      soup = Float32Array.from(yUpToZUp(glb.bake(at)));
    } else soup = parseSTL(bytes, { maxTriangles: LIMITS.triangles });
  } catch (error) {
    throw fault(error);
  }
  // GLB coordinates are meters by definition; an STL does not say what its numbers mean.
  // `notes` lists what the file has that its rest pose leaves out: 'rigged', 'animated', 'morphs'.
  const clips = glb ? glb.clips.map(({ index, name, label, duration, keys }) => ({ index, name, label, duration, keys })) : [];
  const finish = (shape, chosen) => {
    for (let i = 0; i < shape.length; i++) if (!Number.isFinite(shape[i])) throw new Error('This file contains invalid coordinates.');
    if (shape.length / 9 > LIMITS.triangles) throw tooManyTriangles(shape.length / 9);
    if (shape.length < 9) throw new Error('No triangles were found in this file.');
    return { format, unit: format === 'glb' ? 'meter' : null, notes, clips, pose: chosen, posed, repose, ...weld(shape) };
  };
  // Another pose of the same file, without reading it again: `posed` gives the bare triangles
  // quickly, for showing while a pose is chosen; `repose` gives a whole new mesh to repair.
  const clamp = next => {
    if (!next) return null;
    const clip = glb.clips[next.clip];
    if (!clip) throw new Error('This file has no such animation.');
    return { clip: clip.index, time: Math.min(Math.max(Number(next.time) || 0, 0), clip.duration) };
  };
  const posed = glb ? next => { try { return Float32Array.from(yUpToZUp(glb.bake(clamp(next)))); } catch (error) { throw fault(error); } } : null;
  const repose = glb ? next => finish(posed(next), clamp(next)) : null;
  return finish(soup, at);
}

/**
 * `load`, plus Draco-compressed GLB files. The decoder is 700 KB, so it is fetched from the
 * site only the first time a file needs it. `progress` is told while that happens.
 */
export async function loadAsync(bytes, name = '', progress = () => {}, { pose = null } = {}) {
  try {
    return load(bytes, name, { pose });
  } catch (error) {
    if (!error || !error.needsDraco) throw error;
    progress('Unpacking compressed geometry');
    const { decodeDraco } = await import('./draco.js');
    const draco = new Map();
    let budget = LIMITS.triangles;
    for (const { key, bytes: packed, attribute, extra } of error.needsDraco) {
      let unpacked;
      try { unpacked = await decodeDraco(packed, attribute, { maxTriangles: budget, extra }); } catch (fault) {
        if (fault && fault.tooMany) throw new Error(`This model has more than ${LIMITS.triangles.toLocaleString('en-US')} triangles, which is more than this page can handle.`);
        throw fault;
      }
      budget -= unpacked.indices.length / 3;
      draco.set(key, unpacked);
    }
    return load(bytes, name, { draco, pose });
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
