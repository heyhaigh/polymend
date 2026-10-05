// Runs off the main thread so the page stays responsive while a model is processed.

import { load, mend, countCrossings } from '../src/pipeline.js';
import { writeSTL } from '../src/stl.js';
import { layout, write3MF, zip, VERSION } from '../src/output.js';

// The model in hand. These three change together, and only once a whole job has
// succeeded: if a new file cannot be read or repaired, the one before it is still here,
// whole, and the page goes on showing and downloading that.
let mesh = null;    // the loaded input
let result = null;  // the latest repair of it
let options = {};

const progress = label => postMessage({ type: 'progress', label });

/** Triangle corners, nine numbers each, for the faces where `pick(face)` is true. */
function soupOf(positions, tris, pick) {
  const out = [];
  for (let f = 0; f < tris.length / 3; f++) {
    if (!pick(f)) continue;
    for (let k = 0; k < 3; k++) { const v = tris[f * 3 + k] * 3; out.push(positions[v], positions[v + 1], positions[v + 2]); }
  }
  return new Float32Array(out);
}

/** Group changed faces that sit close together into places the viewer can fly to. */
function spotsOf(soup, kind, size) {
  const cell = size * 0.01;
  const groups = new Map();
  for (let i = 0; i < soup.length; i += 9) {
    const centre = [0, 1, 2].map(c => (soup[i + c] + soup[i + 3 + c] + soup[i + 6 + c]) / 3);
    const key = centre.map(value => Math.round(value / cell)).join(',');
    if (!groups.has(key)) groups.set(key, { sum: [0, 0, 0], count: 0, lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] });
    const group = groups.get(key);
    group.count++;
    for (let c = 0; c < 3; c++) {
      group.sum[c] += centre[c];
      for (let k = 0; k < 3; k++) { const value = soup[i + k * 3 + c]; if (value < group.lo[c]) group.lo[c] = value; if (value > group.hi[c]) group.hi[c] = value; }
    }
  }
  return [...groups.values()].map(group => ({
    kind, triangles: group.count,
    centre: group.sum.map(value => value / group.count),
    radius: Math.hypot(group.hi[0] - group.lo[0], group.hi[1] - group.lo[1], group.hi[2] - group.lo[2]) / 2,
  }));
}

function send() {
  const before = { positions: new Float32Array(mesh.positions), tris: new Uint32Array(mesh.tris) };
  const after = { positions: new Float32Array(result.positions), tris: new Uint32Array(result.tris) };
  const removed = soupOf(mesh.positions, mesh.tris, f => !result.kept[f]);
  const added = soupOf(result.positions, result.tris, f => result.origin[f] < 0);
  const flipped = soupOf(result.positions, result.tris, f => result.flipped[f] === 1);
  // The size shown is the size of what will be downloaded: the repaired model.
  const boxOf = positions => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) { const c = i % 3, value = positions[i]; if (value < lo[c]) lo[c] = value; if (value > hi[c]) hi[c] = value; }
    return [0, 1, 2].map(c => hi[c] - lo[c]);
  };
  const extent = boxOf(result.positions);
  const size = Math.hypot(...boxOf(mesh.positions));
  // Turned triangles get places to visit too, unless a whole shell was turned.
  const spots = [...spotsOf(removed, 'removed', size), ...spotsOf(added, 'added', size), ...(flipped.length / 9 <= 2000 ? spotsOf(flipped, 'flipped', size) : [])];
  // Which way the repaired surface faces at each change, so the viewer can look at it squarely.
  const normalAt = normalFinder(result.positions, result.tris, size, spots.length);
  for (const spot of spots) spot.normal = normalAt(spot.centre, Math.max(spot.radius * 2.5, size * 0.006));
  postMessage({ type: 'result', format: mesh.format, unit: mesh.unit, report: result.report, extent, before, after, removed, added, flipped, spots },
    [before.positions.buffer, before.tris.buffer, after.positions.buffer, after.tris.buffer, removed.buffer, added.buffer, flipped.buffer]);
}

/**
 * Gives the average outward direction of the faces near a point, weighted by their area,
 * or null where the faces nearby cancel out, such as inside a deep crease. For a few
 * places every face is looked at each time. For many (a scan can have thousands of
 * pinholes) the faces are sorted into a grid first, so each place looks only nearby.
 */
function normalFinder(positions, tris, size, places) {
  const add = (sum, i) => {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    sum[0] += uy * vz - uz * vy; sum[1] += uz * vx - ux * vz; sum[2] += ux * vy - uy * vx; // the cross product is already area-weighted
  };
  const near = (i, centre, limit) => {
    const a = tris[i] * 3;
    const dx = positions[a] - centre[0], dy = positions[a + 1] - centre[1], dz = positions[a + 2] - centre[2];
    return dx * dx + dy * dy + dz * dz <= limit;
  };
  const finish = sum => { const length = Math.hypot(...sum); return length > 1e-12 ? sum.map(value => value / length) : null; };
  const scan = (centre, reach) => {
    const sum = [0, 0, 0], limit = reach * reach;
    for (let i = 0; i < tris.length; i += 3) if (near(i, centre, limit)) add(sum, i);
    return finish(sum);
  };
  if (places <= 32 || !(size > 0)) return scan;
  const cell = size * 0.02;
  const at = value => Math.floor(value / cell);
  const key = (x, y, z) => `${x},${y},${z}`;
  const grid = new Map();
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, k = key(at(positions[a]), at(positions[a + 1]), at(positions[a + 2]));
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  }
  return (centre, reach) => {
    const lo = centre.map(value => at(value - reach)), hi = centre.map(value => at(value + reach));
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 512) return scan(centre, reach);
    const sum = [0, 0, 0], limit = reach * reach;
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      for (const i of grid.get(key(x, y, z)) || []) if (near(i, centre, limit)) add(sum, i);
    }
    return finish(sum);
  };
}

/** A file name with nothing in it that could escape a folder or upset an unzip tool. */
const safeName = name => String(name).replace(/[^A-Za-z0-9 ._()+-]/g, '_').replace(/^[.]+/, '_') || 'model';

/**
 * After the result is on screen: count the places the surface passes through itself.
 * It is information only, and waiting for it would roughly double the time to a result.
 * The count is bounded, and if it cannot be made the page is told so; nothing here can
 * turn a finished repair into a failure.
 */
function later() {
  let counts;
  try { counts = countCrossings(mesh, result); } catch { counts = { crossingsBefore: null, crossingsAfter: null, crossingsSkipped: true }; }
  Object.assign(result.report, counts);
  postMessage({ type: 'crossings', ...counts });
}

/** Quarter turn about X, for a model that arrives lying down. Shape and faults are unchanged. */
function turn(positions) {
  for (let i = 0; i < positions.length; i += 3) { const y = positions[i + 1]; positions[i + 1] = -positions[i + 2]; positions[i + 2] = y; }
}

onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      progress('Reading the file');
      const loaded = load(new Uint8Array(message.buffer), message.name);
      // A model reloaded after a stopped job is turned the way it was before.
      for (let i = 0; i < (message.turns || 0) % 4; i++) turn(loaded.positions);
      const wanted = message.options || {};
      const mended = mend(loaded, wanted, progress, { crossings: false });
      mesh = loaded; options = wanted; result = mended; // all three, and only now
      send();
      later();
    } else if (message.type === 'options' && mesh) {
      const mended = mend(mesh, message.options, progress, { crossings: false });
      options = message.options; result = mended;
      send();
      later();
    } else if (message.type === 'rotate' && mesh) {
      turn(mesh.positions);
      turn(result.positions);
      send();
    } else if (message.type === 'export' && result) {
      progress('Writing the file');
      // A GLB's numbers are meters; with no height chosen they are written as millimeters.
      const sized = layout(result.positions, { heightMm: message.heightMm, unitMm: mesh.unit === 'meter' ? 1000 : 1 });
      const stl = () => writeSTL(sized.positions, result.tris, 1, `polymend ${VERSION}`);
      const threeMF = () => write3MF(sized.positions, result.tris, { title: message.title });
      const bytes = message.format === 'zip'
        ? await zip([[`${safeName(message.title)}-mended.stl`, stl()], [`${safeName(message.title)}-mended.3mf`, await threeMF()]])
        : message.format === '3mf' ? await threeMF() : stl();
      postMessage({ type: 'file', format: message.format, bytes }, [bytes.buffer]);
    }
  } catch (error) {
    postMessage({ type: 'error', message: error && error.message ? error.message : 'Something went wrong reading this file.' });
  }
};
