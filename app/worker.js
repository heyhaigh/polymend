// Runs off the main thread so the page stays responsive while a model is processed.

import { load, mend, countCrossings } from '../src/pipeline.js';
import { writeSTL } from '../src/stl.js';
import { layout, write3MF, zip, VERSION } from '../src/output.js';

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
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) { const c = i % 3, value = mesh.positions[i]; if (value < lo[c]) lo[c] = value; if (value > hi[c]) hi[c] = value; }
  const extent = [0, 1, 2].map(c => hi[c] - lo[c]);
  const size = Math.hypot(...extent);
  // Turned triangles get places to visit too, unless a whole shell was turned.
  const spots = [...spotsOf(removed, 'removed', size), ...spotsOf(added, 'added', size), ...(flipped.length / 9 <= 2000 ? spotsOf(flipped, 'flipped', size) : [])];
  // Which way the repaired surface faces at each change, so the viewer can look at it squarely.
  for (const spot of spots) spot.normal = surfaceNormal(result.positions, result.tris, spot.centre, Math.max(spot.radius * 2.5, size * 0.006));
  postMessage({ type: 'result', format: mesh.format, report: result.report, extent, before, after, removed, added, flipped, spots },
    [before.positions.buffer, before.tris.buffer, after.positions.buffer, after.tris.buffer, removed.buffer, added.buffer, flipped.buffer]);
}

/**
 * The average outward direction of the faces near a point, weighted by their area.
 * Returns null where the faces nearby cancel out, such as inside a deep crease.
 */
function surfaceNormal(positions, tris, centre, reach) {
  const sum = [0, 0, 0];
  const limit = reach * reach;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3;
    const dx = positions[a] - centre[0], dy = positions[a + 1] - centre[1], dz = positions[a + 2] - centre[2];
    if (dx * dx + dy * dy + dz * dz > limit) continue;
    const b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    sum[0] += uy * vz - uz * vy; sum[1] += uz * vx - ux * vz; sum[2] += ux * vy - uy * vx; // the cross product is already area-weighted
  }
  const length = Math.hypot(...sum);
  return length > 1e-12 ? sum.map(value => value / length) : null;
}

/** A file name with nothing in it that could escape a folder or upset an unzip tool. */
const safeName = name => String(name).replace(/[^A-Za-z0-9 ._()+-]/g, '_').replace(/^[.]+/, '_') || 'model';

/**
 * After the result is on screen: count the places the surface passes through itself.
 * It is information only, and waiting for it would roughly double the time to a result.
 */
function later() {
  const counts = countCrossings(mesh, result);
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
      mesh = load(new Uint8Array(message.buffer), message.name);
      options = message.options || {};
      result = mend(mesh, options, progress, { crossings: false });
      send();
      later();
    } else if (message.type === 'options' && mesh) {
      options = message.options;
      result = mend(mesh, options, progress, { crossings: false });
      send();
      later();
    } else if (message.type === 'rotate' && mesh) {
      turn(mesh.positions);
      turn(result.positions);
      send();
    } else if (message.type === 'export' && result) {
      progress('Writing the file');
      const sized = layout(result.positions, { heightMm: message.heightMm });
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
