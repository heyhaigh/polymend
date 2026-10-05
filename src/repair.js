// Repair the small mesh defects that stop a model slicing cleanly, changing as little as possible.
//
// The surface is assumed to be mostly sound, with three kinds of fault:
//   - stray pieces: a triangle, flap or tiny pocket stuck to the surface along an edge
//     that already has its two proper faces;
//   - pinches: two parts of the real surface touching along one edge;
//   - small holes.
// Stray pieces are deleted whole, pinches are cut out and patched on each side, holes
// are patched. Vertices are not moved, with one exception: two vertices that sit a hair
// apart on facing rims of a seam are joined into one.
//
// Every rule errs toward leaving the model alone. Anything that would cut through the
// surface, cap a wide opening, or delete something of real size is left as it is and
// reported, and the outcome is then "partly repaired" rather than "repaired".

import { analyze, direction, EdgeTable, pinchedPoints, volume } from './mesh.js';
import { trianglesCross } from './intersect.js';

const DEFAULTS = {
  maxHoleEdges: 100,    // holes with more edges than this are left open and reported...
  maxHoleSpan: 0.1,     // ...and so are openings wider than this fraction of the model's diagonal,
  patchWide: false,     // unless asked: a wide opening may be meant, like the top of a vase
  maxPatchCrossings: 4, // a patch may graze this many nearby triangles (and is reported); more, and the hole stays open
  strayFaces: 24,       // an attached or loose open scrap up to this many faces is deleted...
  straySpan: 0.05,      // ...if it is also small (fraction of the main body's diagonal)
  speckFaces: 32,       // a closed shell up to this size is deleted, if it is also tiny...
  speckSize: 0.02,      // ...measured against the model's main body (fraction of its diagonal)
  seamGap: 1e-5,        // rim vertices closer than this fraction of the model's diagonal are one vertex
  joinSeams: true,      // join rim vertices that sit a hair apart
  removeStray: true,    // delete stray pieces attached along an already-complete edge
  removeSpecks: true,   // delete tiny closed shells
  patchHoles: true,     // close small holes
  fixFacing: true,      // turn faces so neighbours agree and shells face outward
  separatePinches: false, // cut apart surfaces that touch along an edge; off because it can part things meant to touch
  maxPasses: 40,
};

export function repair(inputPositions, inputTris, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.removeStray) opts.strayFaces = 0;
  if (!opts.removeSpecks) opts.speckFaces = 0;
  const positions = Array.from(inputPositions);
  const tris = Array.from(inputTris);
  // The edge table is the costly thing to build, so it is built once and kept until a
  // face is deleted or added (`version` counts those changes).
  const firstEdges = new EdgeTable(inputTris);
  const state = { positions, tris, dead: new Uint8Array(tris.length / 3), version: 0, edges: firstEdges, edgesVersion: 0, span: diagonal(inputPositions) };
  const report = {
    before: analyze(inputPositions, inputTris, firstEdges),
    degenerateRemoved: 0, duplicateRemoved: 0, seamPointsJoined: 0, strayFacesRemoved: 0, sheetsLeft: 0, pinchedEdgesCut: 0, pinchedEdgesLeft: 0,
    specksRemoved: 0, holes: null, holesFilled: [], holesLeftOpen: [], trianglesAdded: 0, patchCrossings: 0, patchesCrossing: 0, facesFlipped: 0, flatPieces: 0,
  };
  // A model with no faults is left exactly as it is. A tiny separate shell in it may be
  // a real part, such as a peg, so specks are only cleared from a model that has faults.
  const { before } = report;
  if (before.openEdges + before.nonManifoldEdges + before.inconsistentEdges + before.degenerate === 0) opts.speckFaces = 0;

  dropDegenerateAndDuplicate(state, report);
  if (opts.joinSeams && joinSeams(state, report, opts)) dropDegenerateAndDuplicate(state, report);
  // Patching can, rarely, expose a new bad edge, so allow a few rounds.
  for (let round = 0; round < 4; round++) {
    removeStrayPiecesAndCutPinches(state, report, opts);
    removeLooseJunk(state, report, opts);
    if (opts.patchHoles) fillHoles(state, report, opts);
    else if (!report.holes) report.holes = describeHoles(holeLoops(state, edgeUse(state)).loops.flatMap(splitRepeats), state.positions);
    if (!opts.separatePinches || !hasOverSharedEdge(edgeUse(state))) break;
  }

  const packed = compact(state, inputTris.length / 3);
  if (!packed.tris.length) throw new Error('Nothing printable was found in this file. Every triangle in it is collapsed to a line or a point.');
  // Turning faces does not change which faces share an edge, so one table serves both steps.
  const packedEdges = new EdgeTable(packed.tris);
  const facing = opts.fixFacing ? orient(packed.positions, packed.tris, packedEdges) : { count: 0, flags: new Uint8Array(packed.tris.length / 3) };
  report.facesFlipped = facing.count;
  // Sorting faces into shells is the costly part, and facing has just done it.
  report.flatPieces = facing.flat ?? flatShells(packed.positions, packed.tris, packedEdges);
  report.after = analyze(packed.positions, packed.tris, packedEdges);
  report.pinchedEdgesLeft = report.after.nonManifoldEdges;
  // For information: a slicer's edge check does not see these, and most slicers accept them.
  report.pointsTouching = pinchedPoints(packed.positions, packed.tris, packedEdges);
  // "Clean" is the edge checks a slicer makes, plus one of our own: a closed piece that
  // encloses no volume is a flat sheet folded shut, and cannot be printed.
  report.clean = report.after.openEdges === 0 && report.after.nonManifoldEdges === 0 && report.after.inconsistentEdges === 0 && report.flatPieces === 0;
  const changed = report.degenerateRemoved + report.duplicateRemoved + report.seamPointsJoined + report.strayFacesRemoved + report.specksRemoved
    + report.pinchedEdgesCut + report.trianglesAdded + report.facesFlipped;
  // sound: nothing needed doing. repaired: faults found and all fixed. partial: some remain.
  report.status = !report.clean ? 'partial' : changed ? 'repaired' : 'sound';
  return { positions: packed.positions, tris: packed.tris, report, origin: packed.origin, flipped: facing.flags };
}

/** The length of the diagonal of the box around a set of points. */
function diagonal(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i], c = i % 3;
    if (value < lo[c]) lo[c] = value;
    if (value > hi[c]) hi[c] = value;
  }
  return positions.length ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
}

function edgeUse(state) {
  if (state.edgesVersion !== state.version) {
    state.edges = new EdgeTable(state.tris, state.dead);
    state.edgesVersion = state.version;
  }
  return state.edges;
}

function hasOverSharedEdge(edges) {
  for (let i = 0; i < edges.size; i++) if (edges.count[edges.order[i]] > 2) return true;
  return false;
}

function dropDegenerateAndDuplicate(state, report) {
  const { tris, dead } = state;
  const faceCount = tris.length / 3;
  // A small hash table of faces by their three vertices in sorted order, to spot repeats.
  let capacity = 1024;
  while (capacity < faceCount * 2) capacity *= 2;
  const mask = capacity - 1;
  const table = new Int32Array(capacity).fill(-1);
  const sorted = new Int32Array(faceCount * 3);
  const startedWith = report.degenerateRemoved + report.duplicateRemoved;
  for (let f = 0; f < faceCount; f++) {
    if (dead[f]) continue;
    let a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2];
    if (a === b || b === c || c === a) { dead[f] = 1; report.degenerateRemoved++; continue; }
    if (a > b) { const t = a; a = b; b = t; }
    if (b > c) { const t = b; b = c; c = t; }
    if (a > b) { const t = a; a = b; b = t; }
    sorted[f * 3] = a; sorted[f * 3 + 1] = b; sorted[f * 3 + 2] = c;
    const hash = Math.imul(Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b) ^ c, 0xc2b2ae35);
    let slot = (hash ^ (hash >>> 15)) & mask;
    for (;;) {
      const g = table[slot];
      if (g < 0) { table[slot] = f; break; }
      if (sorted[g * 3] === a && sorted[g * 3 + 1] === b && sorted[g * 3 + 2] === c) { dead[f] = 1; report.duplicateRemoved++; break; }
      slot = (slot + 1) & mask;
    }
  }
  if (report.degenerateRemoved + report.duplicateRemoved > startedWith) state.version++;
}

/**
 * Join vertices that sit a hair apart on the rims of a seam. Some exporters write the two
 * sides of a seam with coordinates that differ in the last digit, so the sides never weld
 * and the model seems to have a long open cut. Only rim vertices are considered, only
 * pairs closer than a hundred-thousandth of the model's size, and never two ends of the
 * same edge, so the closed surface is untouched. Returns true if anything was joined.
 */
function joinSeams(state, report, opts) {
  const { positions, tris, dead } = state;
  const gap = opts.seamGap * state.span;
  if (!(gap > 0)) return false;
  const edges = edgeUse(state);
  const rim = [];
  const onRim = new Uint8Array(positions.length / 3);
  for (let i = 0; i < edges.size; i++) {
    const slot = edges.order[i];
    if (edges.count[slot] !== 1) continue;
    for (const v of [edges.lo[slot], edges.hi[slot]]) if (!onRim[v]) { onRim[v] = 1; rim.push(v); }
  }
  if (rim.length < 2) return false;
  const cellOf = (v, c) => Math.floor(positions[v * 3 + c] / gap);
  const cells = new Map();
  const target = new Map(); // vertex -> the vertex it becomes
  for (const v of rim) {
    const cx = cellOf(v, 0), cy = cellOf(v, 1), cz = cellOf(v, 2);
    let match = -1;
    for (let dx = -1; dx <= 1 && match < 0; dx++) for (let dy = -1; dy <= 1 && match < 0; dy++) for (let dz = -1; dz <= 1 && match < 0; dz++) {
      for (const u of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) || []) {
        const apart = Math.hypot(positions[u * 3] - positions[v * 3], positions[u * 3 + 1] - positions[v * 3 + 1], positions[u * 3 + 2] - positions[v * 3 + 2]);
        if (apart <= gap && edges.find(u, v) < 0) { match = u; break; }
      }
    }
    if (match >= 0) { target.set(v, match); continue; }
    const key = `${cx},${cy},${cz}`;
    if (cells.has(key)) cells.get(key).push(v); else cells.set(key, [v]);
  }
  if (!target.size) return false;
  for (let f = 0; f < tris.length / 3; f++) {
    if (dead[f]) continue;
    for (let k = 0; k < 3; k++) { const to = target.get(tris[f * 3 + k]); if (to !== undefined) tris[f * 3 + k] = to; }
  }
  report.seamPointsJoined = target.size;
  state.version++;
  return true;
}

/** Groups of faces joined across ordinary (two-face) edges, with what each group touches. */
function components(state, edges) {
  const { tris, dead, positions } = state;
  const faceCount = tris.length / 3;
  const parent = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f++) parent[f] = f;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < edges.size; i++) {
    const slot = edges.order[i];
    if (edges.count[slot] === 2) parent[find(edges.first[slot])] = find(edges.second[slot]);
  }
  const groups = new Map();
  for (let f = 0; f < faceCount; f++) {
    if (dead[f]) continue;
    const root = find(f);
    if (!groups.has(root)) groups.set(root, { faces: [], open: 0, attached: false });
    groups.get(root).faces.push(f);
  }
  for (let i = 0; i < edges.size; i++) {
    const slot = edges.order[i], used = edges.count[slot];
    if (used === 1) groups.get(find(edges.first[slot])).open++;
    else if (used > 2) for (const f of edges.faces(slot)) groups.get(find(f)).attached = true;
  }
  const span = faces => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) {
      const value = positions[tris[f * 3 + k] * 3 + c];
      if (value < lo[c]) lo[c] = value;
      if (value > hi[c]) hi[c] = value;
    }
    return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  };
  const list = [...groups.values()];
  // A loop, not Math.max(...list): a model made of loose triangles has one group per face,
  // and spreading that many arguments overflows the call stack.
  let largest = 0;
  for (const group of list) if (group.faces.length > largest) largest = group.faces.length;
  let modelSpan = 0;
  for (const group of list) if (group.faces.length === largest) modelSpan = Math.max(modelSpan, span(group.faces));
  return { groups: list, largest, modelSpan, span };
}

/** Is this group junk rather than part of the model? */
function isJunk(group, info, opts) {
  if (group.faces.length >= info.largest) return false;
  if (group.open > 0) {
    // An open scrap hanging off a bad edge cannot be part of a printable surface. It is
    // only deleted if it is also small: a sheet of real size, such as a cape or a flag
    // modelled with no thickness, is left for its author and reported.
    if (group.attached) return group.faces.length <= opts.strayFaces && info.span(group.faces) < opts.straySpan * info.modelSpan;
    return group.faces.length <= opts.strayFaces && info.span(group.faces) < opts.speckSize * info.modelSpan;
  }
  // A closed shell might be a real small part, so it must be tiny in size as well.
  return group.faces.length <= opts.speckFaces && info.span(group.faces) < opts.speckSize * info.modelSpan;
}

/**
 * While any edge has more than two faces: delete the small stray pieces attached along
 * such edges. If none are left to delete, the remaining over-shared edges are pinches
 * between parts of the real surface; cut their faces out so each side can be patched.
 */
function removeStrayPiecesAndCutPinches(state, report, opts) {
  for (let pass = 0; pass < opts.maxPasses; pass++) {
    const edges = edgeUse(state);
    const bad = [];
    for (let i = 0; i < edges.size; i++) if (edges.count[edges.order[i]] > 2) bad.push(edges.faces(edges.order[i]));
    if (!bad.length) return;
    const info = components(state, edges);
    let removed = 0;
    for (const group of info.groups) {
      if (!group.attached || !isJunk(group, info, opts)) continue;
      for (const f of group.faces) state.dead[f] = 1;
      if (group.open > 0) report.strayFacesRemoved += group.faces.length; else report.specksRemoved++;
      removed++;
    }
    if (removed) { state.version++; continue; }
    // What is still attached, open and few-faced was too large to call a stray scrap.
    report.sheetsLeft = info.groups.filter(group => group.attached && group.open > 0 && group.faces.length < info.largest && group.faces.length <= opts.strayFaces).length;
    if (!opts.separatePinches) return;
    // The openings this cut leaves are ours to close, however wide: remember their corners.
    state.cut ||= new Set();
    for (const faces of bad) for (const f of faces) { state.dead[f] = 1; for (let k = 0; k < 3; k++) state.cut.add(state.tris[f * 3 + k]); }
    report.pinchedEdgesCut += bad.length;
    state.version++;
  }
}

/** Loose scraps and specks that are not attached to anything. */
function removeLooseJunk(state, report, opts) {
  const info = components(state, edgeUse(state));
  for (const group of info.groups) {
    if (group.attached || !isJunk(group, info, opts)) continue;
    for (const f of group.faces) state.dead[f] = 1;
    if (group.open > 0) report.strayFacesRemoved += group.faces.length; else report.specksRemoved++;
    state.version++;
  }
}

/**
 * Walk each hole's rim. At a vertex where several rims meet, the walk stays on one
 * part of the surface by rotating through that part's faces, so pinched surfaces are
 * patched one side at a time.
 */
function holeLoops(state, edges) {
  const { tris } = state;
  const other = (f, u, v) => { for (let k = 0; k < 3; k++) { const w = tris[f * 3 + k]; if (w !== u && w !== v) return w; } return -1; };
  const visited = new Uint8Array(edges.mask + 1);
  const loops = [];
  let blockedRims = 0;
  for (let i = 0; i < edges.size; i++) {
    const start = edges.order[i];
    if (edges.count[start] !== 1 || visited[start]) continue;
    const loop = [];
    let u = edges.lo[start], v = edges.hi[start], f = edges.first[start];
    let blocked = false, closed = false;
    for (let guard = 0; guard < 1e6; guard++) {
      visited[edges.find(u, v)] = 1;
      loop.push(u);
      // rotate around v, starting in face f, to the next open edge
      let w = other(f, u, v), from = u, spin = 0;
      for (;;) {
        const slot = edges.find(v, w);
        if (slot < 0) { blocked = true; break; }
        const used = edges.count[slot];
        if (used === 1) break;
        if (used > 2) { blocked = true; break; }
        const next = edges.first[slot] === f ? edges.second[slot] : edges.first[slot];
        from = w; f = next; w = other(f, v, from);
        if (++spin > 1e5) return { loops, broken: true, blockedRims };
      }
      if (blocked) break;
      u = v; v = w;
      if (edges.find(u, v) === start) { closed = true; break; }
    }
    if (blocked || !closed) blockedRims++; else loops.push(loop);
  }
  return { loops, broken: false, blockedRims };
}

/** A rim that passes through the same vertex twice is really two holes. */
function splitRepeats(loop) {
  const out = [];
  const stack = [loop];
  while (stack.length) {
    const ring = stack.pop();
    const first = new Map();
    let split = false;
    for (let i = 0; i < ring.length; i++) {
      if (first.has(ring[i])) {
        const j = first.get(ring[i]);
        stack.push(ring.slice(j, i), [...ring.slice(0, j), ...ring.slice(i)]);
        split = true;
        break;
      }
      first.set(ring[i], i);
    }
    if (!split) out.push(ring);
  }
  return out;
}

/**
 * Faces near a box, for the patch-crossing test. With a handful of holes a plain scan of
 * every face is quickest. With many, the faces are sorted into a grid once, so that a
 * model with thousands of pinholes does not take a scan of the whole mesh per hole.
 * Both ways offer the same faces for the same box.
 */
function faceFinder(state, expectedQueries) {
  const { positions, tris } = state;
  const boxOf = f => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) {
      const value = positions[tris[f * 3 + k] * 3 + c];
      if (value < lo[c]) lo[c] = value;
      if (value > hi[c]) hi[c] = value;
    }
    return [lo, hi];
  };
  const scan = (lo, hi, visit) => {
    for (let f = 0; f < tris.length / 3; f++) {
      if (state.dead[f]) continue;
      const a = tris[f * 3] * 3, b = tris[f * 3 + 1] * 3, c = tris[f * 3 + 2] * 3;
      let outside = false;
      for (let k = 0; k < 3 && !outside; k++) {
        const x = positions[a + k], y = positions[b + k], z = positions[c + k];
        outside = Math.min(x, y, z) > hi[k] || Math.max(x, y, z) < lo[k];
      }
      if (!outside) visit(f);
    }
  };
  if (expectedQueries <= 24 || !(state.span > 0)) return { near: scan, add() {} };

  const cell = state.span / 128;
  const grid = new Map();
  const at = value => Math.floor(value / cell);
  const insert = f => {
    const [lo, hi] = boxOf(f);
    const x0 = at(lo[0]), x1 = at(hi[0]), y0 = at(lo[1]), y1 = at(hi[1]), z0 = at(lo[2]), z1 = at(hi[2]);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const key = x * 73856093 ^ y * 19349663 ^ z * 83492791; // cells that collide just share a list
      const list = grid.get(key);
      if (list) list.push(f); else grid.set(key, [f]);
    }
  };
  for (let f = 0; f < tris.length / 3; f++) if (!state.dead[f]) insert(f);
  const near = (lo, hi, visit) => {
    const x0 = at(lo[0]), x1 = at(hi[0]), y0 = at(lo[1]), y1 = at(hi[1]), z0 = at(lo[2]), z1 = at(hi[2]);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) return scan(lo, hi, visit); // a big box: the plain scan is cheaper
    const seen = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      for (const f of grid.get(x * 73856093 ^ y * 19349663 ^ z * 83492791) || []) {
        if (seen.has(f) || state.dead[f]) continue;
        seen.add(f);
        const [flo, fhi] = boxOf(f);
        if (flo[0] > hi[0] || fhi[0] < lo[0] || flo[1] > hi[1] || fhi[1] < lo[1] || flo[2] > hi[2] || fhi[2] < lo[2]) continue;
        visit(f);
      }
    }
  };
  return { near, add: insert };
}

/**
 * Triangulate a ring of rim vertices without adding a point, by cutting off one corner
 * ("ear") at a time in the ring's own plane. Used where a fan around the middle would
 * fold over itself, as it does for an L-shaped or crescent-shaped hole. Returns null if
 * the ring cannot be cut up this way.
 */
function clipEars(ring, positions, used) {
  const point = v => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  const pts = ring.map(point);
  // The ring's plane, from Newell's sum, and two axes within it.
  const normal = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    normal[0] += (p[1] - q[1]) * (p[2] + q[2]); normal[1] += (p[2] - q[2]) * (p[0] + q[0]); normal[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const length = Math.hypot(...normal);
  if (!(length > 0)) return null;
  const n = normal.map(value => value / length);
  const seed = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ux = [seed[1] * n[2] - seed[2] * n[1], seed[2] * n[0] - seed[0] * n[2], seed[0] * n[1] - seed[1] * n[0]];
  const ul = Math.hypot(...ux);
  const u = ux.map(value => value / ul);
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const flat = pts.map(p => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]]);
  const turn = (a, b, c) => (flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[c][0] - flat[a][0]);
  const inside = (p, a, b, c) => turn(a, b, p) >= 0 && turn(b, c, p) >= 0 && turn(c, a, p) >= 0;
  const left = ring.map((_, i) => i);
  const out = [];
  while (left.length > 3) {
    let cut = -1;
    for (let i = 0; i < left.length && cut < 0; i++) {
      const a = left[(i + left.length - 1) % left.length], b = left[i], c = left[(i + 1) % left.length];
      if (turn(a, b, c) <= 0) continue;                 // a reflex corner is not an ear
      if (used(ring[a], ring[c]) !== 0) continue;       // that diagonal is already an edge of the model
      if (left.some(p => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      cut = i;
    }
    if (cut < 0) return null;
    const a = left[(cut + left.length - 1) % left.length], b = left[cut], c = left[(cut + 1) % left.length];
    out.push([ring[a], ring[b], ring[c]]);
    left.splice(cut, 1);
  }
  out.push([ring[left[0]], ring[left[1]], ring[left[2]]]);
  return out;
}

/** Does a fan of triangles around `centre` fold back over itself? */
function fanFolds(ring, centre, positions) {
  const normals = [];
  const sum = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] * 3, b = ring[(i + 1) % ring.length] * 3;
    const ux = positions[a] - centre[0], uy = positions[a + 1] - centre[1], uz = positions[a + 2] - centre[2];
    const vx = positions[b] - centre[0], vy = positions[b + 1] - centre[1], vz = positions[b + 2] - centre[2];
    const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    normals.push(normal);
    for (let c = 0; c < 3; c++) sum[c] += normal[c];
  }
  return normals.some(normal => normal[0] * sum[0] + normal[1] * sum[1] + normal[2] * sum[2] < 0);
}

/**
 * How many holes there are, and how many are flat. A flat hole has its whole rim in one
 * plane, like a missing panel, and is simple to close; a curved one wraps around the
 * surface and is harder, for any tool. Counted before anything is patched.
 */
function describeHoles(rings, positions) {
  const out = { flat: 0, curved: 0 };
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const point = v => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
    const pts = ring.map(point);
    const normal = [0, 0, 0], centre = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      normal[0] += (p[1] - q[1]) * (p[2] + q[2]); normal[1] += (p[2] - q[2]) * (p[0] + q[0]); normal[2] += (p[0] - q[0]) * (p[1] + q[1]);
      for (let c = 0; c < 3; c++) centre[c] += p[c] / pts.length;
    }
    const length = Math.hypot(...normal);
    let span = 0, lift = 0;
    for (const p of pts) {
      span = Math.max(span, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
      if (length > 0) lift = Math.max(lift, Math.abs((p[0] - centre[0]) * normal[0] + (p[1] - centre[1]) * normal[1] + (p[2] - centre[2]) * normal[2]) / length);
    }
    // Rim points within 8% of the hole's size from one plane: flat.
    if (length > 0 && lift <= 0.08 * span) out.flat++; else out.curved++;
  }
  return out;
}

function fillHoles(state, report, opts) {
  const { positions, tris } = state;
  const edges = edgeUse(state);
  const { loops, broken, blockedRims } = holeLoops(state, edges);
  if (broken) report.holesLeftOpen.push('rim walk failed');
  for (let i = 0; i < blockedRims; i++) report.holesLeftOpen.push('beside touching surfaces');
  // How many faces use an edge: what the table knew, plus what the patches have added since.
  const extra = new Map();
  const name = (a, b) => (a < b ? a * 67108864 + b : b * 67108864 + a);
  const used = (a, b) => edges.uses(a, b) + (extra.get(name(a, b)) || 0);
  const rings = loops.flatMap(splitRepeats);
  if (!report.holes) report.holes = describeHoles(rings, positions);
  const finder = faceFinder(state, rings.length);
  let grew = false;
  const add = (a, b, c) => {
    const f = tris.length / 3;
    tris.push(a, b, c); grew = true; state.version++;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) extra.set(name(u, v), (extra.get(name(u, v)) || 0) + 1);
    finder.add(f);
    report.trianglesAdded++;
  };
  const distance = (a, b) => Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);

  // How many existing triangles would a proposed patch cut through?
  const point = v => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  const crossings = patch => {
    const corners = patch.map(triangle => triangle.map(v => (Array.isArray(v) ? v : point(v))));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const triangle of corners) for (const q of triangle) for (let c = 0; c < 3; c++) { if (q[c] < lo[c]) lo[c] = q[c]; if (q[c] > hi[c]) hi[c] = q[c]; }
    let count = 0;
    finder.near(lo, hi, f => {
      const a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2];
      const face = [point(a), point(b), point(c)];
      for (let i = 0; i < patch.length; i++) {
        if (patch[i].some(v => v === a || v === b || v === c)) continue; // neighbours touch by design
        if (trianglesCross(corners[i], face)) count++;
      }
    });
    return count;
  };

  for (const ring of rings) {
    const size = ring.length;
    if (size < 3) { report.holesLeftOpen.push('a slit'); continue; }
    // A patch must run along the rim the opposite way to the face already there, so that
    // it faces the same side as its neighbours from the start.
    const rim = edges.find(ring[0], ring[1]);
    if (rim >= 0 && edges.count[rim] === 1 && direction(tris, edges.first[rim], ring[0], ring[1]) === 1) ring.reverse();
    if (size > opts.maxHoleEdges) { report.holesLeftOpen.push(size); continue; }
    // A wide opening is not a small hole however few edges it has, and may be meant.
    // (An opening made by cutting touching surfaces apart is not "meant", and is closed.)
    if (!opts.patchWide && !(state.cut && ring.some(v => state.cut.has(v)))) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of ring) for (let c = 0; c < 3; c++) { const value = positions[v * 3 + c]; if (value < lo[c]) lo[c] = value; if (value > hi[c]) hi[c] = value; }
      if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > opts.maxHoleSpan * state.span) { report.holesLeftOpen.push('wide'); continue; }
    }
    const centre = [0, 0, 0];
    for (const v of ring) for (let c = 0; c < 3; c++) centre[c] += positions[v * 3 + c] / size;
    // Candidate patches, simplest first. A diagonal that is already an edge of the
    // model is not offered: it would become shared by too many faces.
    const candidates = [];
    if (size === 3) candidates.push({ flat: [[ring[0], ring[1], ring[2]]] });
    if (size === 4) {
      const diagonals = [[0, 2], [1, 3]].filter(([i, j]) => used(ring[i], ring[j]) === 0)
        .sort((p, q) => distance(ring[p[0]], ring[p[1]]) - distance(ring[q[0]], ring[q[1]]));
      for (const [i] of diagonals) candidates.push({ flat: [[ring[i], ring[(i + 1) % 4], ring[(i + 2) % 4]], [ring[(i + 2) % 4], ring[(i + 3) % 4], ring[i]]] });
    }
    // A flat hole, with its rim in one plane like a missing panel, is closed in that plane
    // with no new point. A curved hole gets a fan around a new middle point, which caps
    // it more smoothly; where a fan would fold over itself, as around an L or a crescent,
    // the rim is cut up corner by corner instead.
    const isFlat = size > 4 && describeHoles([ring], positions).flat === 1;
    const ears = size > 4 && (isFlat || fanFolds(ring, centre, positions)) ? clipEars(ring, positions, used) : null;
    if (ears) candidates.push({ flat: ears });
    if (!fanFolds(ring, centre, positions)) candidates.push({ fan: true });
    // Take the first candidate that cuts through nothing; failing that, the one that
    // cuts least. Where a model's surface already runs through itself, as sculpted models
    // often do, a patch there cannot avoid grazing a triangle or two; that is accepted
    // and reported. A patch that would cut through more is not made: the hole stays open.
    let chosen = null, least = Infinity;
    for (const candidate of candidates) {
      const patch = candidate.fan ? ring.map((v, i) => [v, ring[(i + 1) % size], centre]) : candidate.flat;
      const cost = crossings(patch);
      if (cost < least) { least = cost; chosen = candidate; }
      if (cost === 0) break;
    }
    if (!chosen) { report.holesLeftOpen.push('an awkward shape'); continue; }
    if (least > opts.maxPatchCrossings) { report.holesLeftOpen.push('would cut through the surface'); continue; }
    if (least > 0) { report.patchCrossings += least; report.patchesCrossing++; }
    report.holesFilled.push(size);
    if (chosen.fan) {
      const id = positions.length / 3;
      positions.push(centre[0], centre[1], centre[2]);
      for (let i = 0; i < size; i++) add(ring[i], ring[(i + 1) % size], id);
    } else {
      for (const [x, y, z] of chosen.flat) add(x, y, z);
    }
  }
  if (grew) {
    const grown = new Uint8Array(tris.length / 3);
    grown.set(state.dead);
    state.dead = grown;
  }
}

/**
 * Drop deleted faces and vertices nothing refers to, keeping the original order.
 * `origin[i]` is the input face that output face i came from, or -1 for a patch.
 */
function compact({ positions, tris, dead }, inputFaces) {
  const used = new Uint8Array(positions.length / 3);
  for (let f = 0; f < tris.length / 3; f++) {
    if (!dead[f]) for (let k = 0; k < 3; k++) used[tris[f * 3 + k]] = 1;
  }
  const remap = new Int32Array(used.length).fill(-1);
  const outPositions = [];
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue;
    remap[v] = outPositions.length / 3;
    outPositions.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  }
  const outTris = [];
  const origin = [];
  for (let f = 0; f < tris.length / 3; f++) {
    if (dead[f]) continue;
    for (let k = 0; k < 3; k++) outTris.push(remap[tris[f * 3 + k]]);
    origin.push(f < inputFaces ? f : -1);
  }
  return { positions: Float64Array.from(outPositions), tris: Uint32Array.from(outTris), origin: Int32Array.from(origin) };
}

/**
 * Make neighbouring faces agree on which side is out, changing as few faces as possible.
 * An outermost closed shell is then turned so it faces outward. A closed shell inside
 * another keeps the sense most of its faces already had: it may be a deliberate cavity
 * (facing inward) or an inner solid (facing outward), and only the model's author knows.
 * Returns how many faces were flipped, and which.
 */
function orient(positions, tris, edges) {
  const faceCount = tris.length / 3;
  const runs = (f, a, b) => { for (let k = 0; k < 3; k++) if (tris[f * 3 + k] === a && tris[f * 3 + (k + 1) % 3] === b) return true; return false; };
  const flags = new Uint8Array(faceCount);
  const flip = f => { const t = tris[f * 3 + 1]; tris[f * 3 + 1] = tris[f * 3 + 2]; tris[f * 3 + 2] = t; flags[f] ^= 1; };
  const seen = new Uint8Array(faceCount);
  const shells = [];
  let flipped = 0;
  for (let start = 0; start < faceCount; start++) {
    if (seen[start]) continue;
    const faces = [start];
    seen[start] = 1;
    const turnedFaces = [];
    // `closed`: every edge has exactly two faces. `sealed`: no edge is open. A shell that
    // touches another along an edge is sealed but not closed, and still has an inside.
    let closed = true, sealed = true;
    for (let head = 0; head < faces.length; head++) {
      const f = faces[head];
      for (let k = 0; k < 3; k++) {
        const a = tris[f * 3 + k], b = tris[f * 3 + (k + 1) % 3];
        const slot = edges.find(a, b);
        if (edges.count[slot] !== 2) { closed = false; if (edges.count[slot] === 1) sealed = false; continue; }
        const g = edges.first[slot] === f ? edges.second[slot] : edges.first[slot];
        if (seen[g]) continue;
        seen[g] = 1;
        if (runs(g, a, b)) { flip(g); turnedFaces.push(g); }
        faces.push(g);
      }
    }
    // Keep whichever sense most faces started with.
    let turned = turnedFaces.length;
    if (turned > faces.length / 2) { for (const f of faces) flip(f); turned = faces.length - turned; }
    shells.push({ faces, closed, sealed, turned });
    flipped += turned;
  }
  // Anything sealed can hold another shell inside it. That includes a body that touches
  // a neighbour along an edge: leaving it out once turned a deliberate cavity in such a
  // body inside out, filling the cavity in.
  const sealedShells = shells.filter(shell => shell.sealed);
  let flat = 0;
  for (const shell of sealedShells) {
    const inside = shellVolume(positions, tris, shell.faces);
    if (shell.closed && isFlat(inside, shellBox(positions, tris, shell))) flat++;
    if (inside >= 0) continue;
    // Only a shell whose box lies within another's can be inside it, which rules out
    // nearly every pair before any ray is cast.
    const box = shellBox(positions, tris, shell);
    const nested = sealedShells.length > 1 && sealedShells.some(other => other !== shell && boxWithin(box, shellBox(positions, tris, other)) && contains(positions, tris, other.faces, shell.faces));
    if (nested) continue;
    for (const f of shell.faces) flip(f);
    flipped += shell.faces.length - 2 * shell.turned;
  }
  return { count: flipped, flags, flat };
}

/** A closed shell that encloses no volume, measured against the box around it. */
function isFlat(inside, [lo, hi]) {
  const span = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return Math.abs(inside) <= 1e-9 * span * span * span;
}

function shellVolume(positions, tris, faces) {
  const shellTris = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) { const f = faces[i] * 3; shellTris[i * 3] = tris[f]; shellTris[i * 3 + 1] = tris[f + 1]; shellTris[i * 3 + 2] = tris[f + 2]; }
  return volume(positions, shellTris);
}

function shellBox(positions, tris, shell) {
  if (shell.box) return shell.box;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const f of shell.faces) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) {
    const value = positions[tris[f * 3 + k] * 3 + c];
    if (value < lo[c]) lo[c] = value;
    if (value > hi[c]) hi[c] = value;
  }
  return (shell.box = [lo, hi]);
}

const boxWithin = (inner, outer) => [0, 1, 2].every(c => inner[0][c] >= outer[0][c] && inner[1][c] <= outer[1][c]);

/**
 * How many closed pieces enclose no volume. Such a piece is a flat sheet whose two sides
 * have been joined at the rim: every edge has two faces, so a slicer's edge check passes,
 * but there is nothing inside it to print. Used when facing is switched off; otherwise
 * `orient` counts them as it goes.
 */
function flatShells(positions, tris, edges) {
  const faceCount = tris.length / 3;
  const seen = new Uint8Array(faceCount);
  let flat = 0;
  for (let start = 0; start < faceCount; start++) {
    if (seen[start]) continue;
    const shell = { faces: [start] };
    seen[start] = 1;
    let closed = true;
    for (let head = 0; head < shell.faces.length; head++) {
      const f = shell.faces[head];
      for (let k = 0; k < 3; k++) {
        const slot = edges.find(tris[f * 3 + k], tris[f * 3 + (k + 1) % 3]);
        if (edges.count[slot] !== 2) { closed = false; continue; }
        const g = edges.first[slot] === f ? edges.second[slot] : edges.first[slot];
        if (!seen[g]) { seen[g] = 1; shell.faces.push(g); }
      }
    }
    if (closed && isFlat(shellVolume(positions, tris, shell.faces), shellBox(positions, tris, shell))) flat++;
  }
  return flat;
}

/**
 * Is the `inner` shell inside the closed `outer` shell? Casts rays from a point on the
 * inner shell and counts crossings. A ray that grazes an edge or corner is ambiguous,
 * so it is thrown away and another direction is tried; if every ray from one point is
 * ambiguous, as can happen on a boxy model lined up with the axes, another point is tried.
 */
const RAYS = [[0.3713, 0.5571, 0.7428], [-0.2857, 0.4286, 0.8571], [0.8729, -0.4364, 0.2182], [-0.6396, -0.4264, 0.6396],
  [0.1826, 0.9129, -0.3651], [0.7001, 0.1400, -0.7001], [-0.4575, 0.8006, 0.3873], [0.5345, -0.8018, -0.2673]];

function contains(positions, tris, outer, inner) {
  const tries = [inner[0], inner[inner.length >> 1], inner[inner.length - 1]];
  for (const f of tries) {
    const origin = [0, 1, 2].map(c => (positions[tris[f * 3] * 3 + c] + positions[tris[f * 3 + 1] * 3 + c] + positions[tris[f * 3 + 2] * 3 + c]) / 3);
    let inside = 0, outside = 0;
    for (const direction of RAYS) {
      let hits = 0, ambiguous = false;
      for (const g of outer) {
        const hit = rayHits(positions, tris, g, origin, direction);
        if (hit === 2) { ambiguous = true; break; }
        hits += hit;
      }
      if (ambiguous) continue;
      if (hits % 2) inside++; else outside++;
      if (inside + outside === 3) break;
    }
    if (inside + outside > 0) return inside > outside;
  }
  return false;
}

/** 0 for a miss, 1 for a clean hit, 2 for a hit too close to an edge to trust. */
function rayHits(positions, tris, f, o, d) {
  const a = tris[f * 3] * 3, b = tris[f * 3 + 1] * 3, c = tris[f * 3 + 2] * 3;
  const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
  const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
  const px = d[1] * e2[2] - d[2] * e2[1], py = d[2] * e2[0] - d[0] * e2[2], pz = d[0] * e2[1] - d[1] * e2[0];
  const det = e1[0] * px + e1[1] * py + e1[2] * pz;
  if (Math.abs(det) < 1e-18) return 0;
  const tx = o[0] - positions[a], ty = o[1] - positions[a + 1], tz = o[2] - positions[a + 2];
  const u = (tx * px + ty * py + tz * pz) / det;
  const qx = ty * e1[2] - tz * e1[1], qy = tz * e1[0] - tx * e1[2], qz = tx * e1[1] - ty * e1[0];
  const w = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
  const edge = 1e-9;
  if (u < -edge || w < -edge || u + w > 1 + edge) return 0;
  if ((e2[0] * qx + e2[1] * qy + e2[2] * qz) / det <= 1e-12) return 0;
  return u < edge || w < edge || u + w > 1 - edge ? 2 : 1;
}
