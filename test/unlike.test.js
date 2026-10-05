// Models unlike the dense sculpted figures the repair was first tuned on: low-poly parts,
// open vessels, thin sheets, seams that never welded, and files built to waste memory.
// The rule under test throughout is "fail safe": when the repair cannot be sure, it leaves
// the model alone and says "partly repaired", and it never says "repaired" about
// something that cannot print.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, weld, pinchedPoints, EdgeTable } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { parseSTL, writeSTL } from '../src/stl.js';
import { parseGLB } from '../src/glb.js';
import { selfIntersections } from '../src/intersect.js';
import { load, mend, countCrossings, LIMITS } from '../src/pipeline.js';
import { layout, write3MF } from '../src/output.js';
import { MAX_BYTES, FAILURES } from '../app/messages.js';

const corners = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const tetra = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];
const mesh = (positions, tris) => [Float64Array.from(positions), Uint32Array.from(tris)];

/** Triangle soup for a box with each side cut into `divisions` squares; `skip(axis, side, i, j)` leaves squares out. */
function boxSoup(divisions = 6, offset = [0, 0, 0], size = 1, skip = () => false, nudge = () => 0) {
  const soup = [];
  const quad = (a, b, c, d) => soup.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    const at = (u, v) => {
      const p = [0, 0, 0];
      p[axis] = side; p[(axis + 1) % 3] = u; p[(axis + 2) % 3] = v;
      const out = p.map((value, i) => offset[i] + value * size);
      out[axis] += nudge(axis, side);
      return out;
    };
    for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions; j++) {
      if (skip(axis, side, i, j)) continue;
      const [u0, u1, v0, v1] = [i / divisions, (i + 1) / divisions, j / divisions, (j + 1) / divisions];
      const ring = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
      quad(...(side ? ring : ring.reverse()));
    }
  }
  return soup;
}
const box = (...args) => weld(Float64Array.from(boxSoup(...args)));
const join = (...parts) => {
  const positions = [], tris = [];
  for (const part of parts) { const base = positions.length / 3; positions.push(...part.positions); tris.push(...[...part.tris].map(v => v + base)); }
  return { positions: Float64Array.from(positions), tris: Uint32Array.from(tris) };
};

// ---------------------------------------------------------------- never "repaired" when it cannot print

test('a single triangle is never called repaired', () => {
  const [positions, tris] = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
  const careful = repair(positions, tris);
  assert.equal(careful.report.status, 'partial');
  assert.equal(careful.tris.length, 3, 'nothing is added to it');
  // Even when told to close wide openings, the result is a flat sheet folded shut, and says so.
  const forced = repair(positions, tris, { patchWide: true });
  assert.equal(forced.report.status, 'partial');
  assert.equal(forced.report.flatPieces, 1);
});

test('a flat sheet does not become a "repaired" solid', () => {
  // One square of two triangles: closing its rim gives a pillow with nothing inside.
  const [positions, tris] = mesh([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
  assert.equal(repair(positions, tris).report.status, 'partial');
  const forced = repair(positions, tris, { patchWide: true });
  assert.equal(forced.report.clean, false);
  assert.equal(forced.report.status, 'partial');
});

test('a file in which every triangle is collapsed is refused, not called repaired', () => {
  const [positions, tris] = mesh([0, 0, 0, 1, 0, 0, 2, 2, 2], [0, 0, 1, 2, 2, 2]);
  assert.throws(() => repair(positions, tris), /Nothing printable/);
});

// ---------------------------------------------------------------- leave what may be meant

test('an open-topped vessel keeps its opening unless asked', () => {
  const vase = box(6, [0, 0, 0], 1, (axis, side) => axis === 2 && side === 1); // no top
  const kept = repair(vase.positions, vase.tris);
  assert.equal(kept.report.status, 'partial');
  assert.deepEqual(kept.report.holesLeftOpen, ['wide']);
  assert.deepEqual([...kept.tris], [...vase.tris], 'no lid is put on it');
  const closed = repair(vase.positions, vase.tris, { patchWide: true });
  assert.equal(closed.report.status, 'repaired');
});

test('holes are counted, and told apart as flat or curved, before any is patched', () => {
  // One square missing from a flat side, and one square missing across a box's corner edge.
  const part = box(20, [0, 0, 0], 1, (axis, side, i, j) => (axis === 0 && side === 0 && i === 5 && j === 5) || (axis === 1 && side === 1 && i === 0 && j === 3) || (axis === 2 && side === 0 && i === 3 && j === 19));
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.holes.flat + result.report.holes.curved, 2, 'two openings: the second and third squares share an edge, so they form one hole');
  assert.ok(result.report.holes.flat >= 1);
  assert.ok(result.report.holes.curved >= 1, 'the hole across the corner is not flat');
  const vase = box(6, [0, 0, 0], 1, (axis, side) => axis === 2 && side === 1);
  assert.deepEqual(repair(vase.positions, vase.tris).report.holes, { flat: 1, curved: 0 });
  assert.deepEqual(repair(vase.positions, vase.tris, { patchHoles: false }).report.holes, { flat: 1, curved: 0 }, 'counted even when patching is off');
});

test('a flat hole with many edges is closed in its own plane, with no new point', () => {
  const gone = new Set(['3,3', '4,3', '5,3', '3,4', '4,4', '5,4']); // a 2 x 3 panel missing from a flat side: a 10-edge hole
  const part = box(40, [0, 0, 0], 1, (axis, side, i, j) => axis === 1 && side === 0 && gone.has(`${i},${j}`));
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.status, 'repaired');
  assert.deepEqual(result.report.holes, { flat: 1, curved: 0 });
  assert.equal(result.positions.length, part.positions.length, 'no point was added');
  assert.equal(result.report.trianglesAdded, 8, 'a ten-sided panel takes eight triangles');
  assert.ok(Math.abs(result.report.after.volume - 1) < 1e-9);
});

test('a small hole in the same vessel is still patched', () => {
  const part = box(40, [0, 0, 0], 1, (axis, side, i, j) => axis === 0 && side === 0 && i === 7 && j === 9);
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.status, 'repaired');
  assert.deepEqual(result.report.holesFilled, [4]);
  assert.ok(Math.abs(result.report.after.volume - 1) < 1e-9);
});

test('a large sheet with no thickness, attached along an edge, is left for its author', () => {
  // A "cape": two triangles as large as the body, hanging from one of its edges.
  const body = box(6);
  const count = body.positions.length / 3;
  const [a, b] = [body.tris[0], body.tris[1]];
  const positions = Float64Array.from([...body.positions, 2, 2, 2, 3, 2, 2]);
  const tris = Uint32Array.from([...body.tris, a, b, count, b, count + 1, count]);
  const result = repair(positions, tris);
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.sheetsLeft, 1);
  assert.equal(result.report.strayFacesRemoved, 0);
  assert.deepEqual([...result.tris], [...tris], 'nothing is deleted');
});

test('a small scrap attached along an edge of a detailed model is still removed', () => {
  const body = box(40);
  const count = body.positions.length / 3;
  const [a, b] = [body.tris[0], body.tris[1]];
  const at = v => [0, 1, 2].map(c => body.positions[v * 3 + c]);
  const tip = at(a).map((value, c) => (value + at(b)[c]) / 2 - 0.01);
  const result = repair(Float64Array.from([...body.positions, ...tip]), Uint32Array.from([...body.tris, a, b, count]));
  assert.equal(result.report.status, 'repaired');
  assert.equal(result.report.strayFacesRemoved, 1);
  assert.deepEqual([...result.tris], [...body.tris]);
});

// ---------------------------------------------------------------- holes of awkward shape

test('an L-shaped hole is closed corner by corner, flat, with no new point', () => {
  const gone = new Set(['3,3', '4,3', '5,3', '3,4', '3,5']); // an L of five squares on one side
  const part = box(40, [0, 0, 0], 1, (axis, side, i, j) => axis === 2 && side === 1 && gone.has(`${i},${j}`));
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.status, 'repaired');
  assert.equal(result.report.holesFilled.length, 1);
  assert.equal(result.positions.length, part.positions.length, 'an ear-cut patch adds no vertex');
  assert.ok(Math.abs(result.report.after.volume - 1) < 1e-9, 'the side is flat again');
  assert.equal(selfIntersections(result.positions, result.tris).pairs, 0);
});

test('a hole is left open when every patch would cut through the model', () => {
  // A square hole with a thin spike standing in it, poking out through the opening.
  const part = box(20, [0, 0, 0], 1, (axis, side, i, j) => axis === 2 && side === 1 && i === 9 && j === 9);
  const spike = { positions: [0.47, 0.47, 0.5, 0.48, 0.47, 0.5, 0.475, 0.48, 0.5, 0.475, 0.475, 1.5], tris: tetra };
  const both = join(part, spike);
  const strict = repair(both.positions, both.tris, { maxPatchCrossings: 0 });
  assert.equal(strict.report.status, 'partial');
  assert.deepEqual(strict.report.holesLeftOpen, ['would cut through the surface']);
  assert.equal(strict.report.trianglesAdded, 0);
  // With the default allowance a grazing patch is made, and is reported, never silent.
  const lenient = repair(both.positions, both.tris);
  if (lenient.report.holesFilled.length) assert.ok(lenient.report.patchesCrossing === 1 && lenient.report.patchCrossings > 0);
  else assert.deepEqual(lenient.report.holesLeftOpen, ['would cut through the surface']);
});

test('many small holes are all patched, quickly', () => {
  // Enough holes to use the grid of faces rather than a scan of the whole mesh per hole.
  const part = box(60, [0, 0, 0], 1, (axis, side, i, j) => i % 6 === 2 && j % 6 === 3);
  const started = performance.now();
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.status, 'repaired');
  assert.equal(result.report.holesFilled.length, 600);
  assert.equal(result.report.patchCrossings, 0);
  assert.ok(Math.abs(result.report.after.volume - 1) < 1e-9);
  assert.ok(performance.now() - started < 5000, 'six hundred holes should take well under five seconds');
});

// ---------------------------------------------------------------- seams

test('a seam whose two sides differ by a hair is joined', () => {
  // The top is its own sheet, a ten-millionth of the model's size above the rim it belongs on.
  const part = weld(Float64Array.from(boxSoup(6, [0, 0, 0], 1, () => false, (axis, side) => (axis === 2 && side === 1 ? 1e-7 : 0))));
  assert.ok(analyze(part.positions, part.tris).openEdges > 0, 'the fixture really is split');
  const result = repair(part.positions, part.tris);
  assert.equal(result.report.status, 'repaired');
  assert.equal(result.report.seamPointsJoined, 24);
  assert.equal(result.tris.length, part.tris.length, 'no triangle is added or removed');
  assert.equal(result.report.after.shells, 1);
  const apart = repair(part.positions, part.tris, { joinSeams: false });
  assert.equal(apart.report.clean, false);
});

test('points that are close but belong to one edge are never joined', () => {
  // A sliver triangle: two of its corners are nearer than the seam distance, but they are
  // the two ends of an edge, and joining them would collapse the triangle.
  const [positions, tris] = mesh([0, 0, 0, 1, 0, 0, 1, 1e-9, 0, 0, 1, 0], [0, 1, 2, 0, 2, 3]);
  assert.equal(repair(positions, tris).report.seamPointsJoined, 0);
});

// ---------------------------------------------------------------- the same answer at any size or place

test('the repair does not depend on the model\'s size or position', () => {
  const part = box(20, [0, 0, 0], 1, (axis, side, i, j) => axis === 1 && side === 0 && i === 4 && j === 4);
  const count = part.positions.length / 3;
  const [a, b] = [part.tris[0], part.tris[1]];
  const at = v => [0, 1, 2].map(c => part.positions[v * 3 + c]);
  const tip = at(a).map((value, c) => (value + at(b)[c]) / 2 - 0.02);
  const positions = [...part.positions, ...tip];
  const tris = Uint32Array.from([...part.tris, a, b, count]);
  const base = repair(Float64Array.from(positions), tris);
  assert.equal(base.report.status, 'repaired');
  for (const [scale, shift] of [[0.001, 0], [1000, 0], [1, 500], [25.4, -80]]) {
    const moved = repair(Float64Array.from(positions, value => value * scale + shift), tris);
    assert.equal(moved.report.status, 'repaired', `scale ${scale}, shift ${shift}`);
    assert.deepEqual([...moved.tris], [...base.tris], `same triangles at scale ${scale}, shift ${shift}`);
    assert.equal(moved.report.strayFacesRemoved, base.report.strayFacesRemoved);
  }
});

test('a cavity is kept even when the body around it touches another along an edge', () => {
  // Found on a real printer part: the body had one edge shared with a neighbour, so it
  // was not counted as able to contain anything, and its cavity was turned inside out.
  const body = box(6);
  const hollow = box(2, [0.4, 0.4, 0.4], 0.2);
  const inward = [];
  for (let i = 0; i < hollow.tris.length; i += 3) inward.push(hollow.tris[i], hollow.tris[i + 2], hollow.tris[i + 1]);
  // A second solid sharing the whole edge x = 1, y = 0 with the body, corner for corner.
  const neighbour = box(6, [1, -1, 0], 1);
  const all = weld(Float64Array.from([
    ...[...body.tris].flatMap(v => [...body.positions.slice(v * 3, v * 3 + 3)]),
    ...inward.flatMap(v => [...hollow.positions.slice(v * 3, v * 3 + 3)]),
    ...[...neighbour.tris].flatMap(v => [...neighbour.positions.slice(v * 3, v * 3 + 3)]),
  ]));
  const before = analyze(all.positions, all.tris);
  assert.ok(before.nonManifoldEdges > 0, 'the two solids really do share an edge');
  assert.ok(Math.abs(before.volume - (2 - 0.008)) < 1e-9);
  const result = repair(all.positions, all.tris);
  assert.equal(result.report.facesFlipped, 0, 'the cavity is not turned');
  assert.ok(Math.abs(result.report.after.volume - (2 - 0.008)) < 1e-9, 'the cavity is still a cavity');
  assert.deepEqual([...result.tris], [...all.tris]);
});

// ---------------------------------------------------------------- things an edge check cannot see

test('two solids touching at a single point are counted, and left alone', () => {
  const second = corners.map((value, i) => -value + [0, 0, 0][i % 3]); // mirrored through the shared corner at 0,0,0
  const both = weld(Float64Array.from([...tetra.flatMap(v => corners.slice(v * 3, v * 3 + 3)), ...[0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3].flatMap(v => second.slice(v * 3, v * 3 + 3))]));
  assert.equal(analyze(both.positions, both.tris).nonManifoldEdges, 0);
  assert.equal(pinchedPoints(both.positions, both.tris), 1);
  const result = repair(both.positions, both.tris);
  assert.equal(result.report.pointsTouching, 1);
  assert.deepEqual([...result.positions], [...both.positions]);
  assert.equal(pinchedPoints(...mesh(corners, tetra)), 0);
});

// ---------------------------------------------------------------- bounded work

test('an edge table that is almost full still answers at once', () => {
  // 87,381 triangles that share nothing: 262,143 edges in a table of 262,144 slots.
  const count = 87381;
  const tris = new Uint32Array(count * 3);
  for (let i = 0; i < tris.length; i++) tris[i] = i;
  const started = performance.now();
  const edges = new EdgeTable(tris);
  assert.equal(edges.size, count * 3);
  assert.equal(edges.uses(0, 5), 0, 'looking for an edge that is not there ends');
  assert.equal(edges.uses(3, 4), 1);
  assert.ok(performance.now() - started < 2000);
});

test('one huge triangle among thousands of tiny ones is still checked for crossings', () => {
  // A triangle the size of the model, tilted through a finely divided box: the case of a
  // detailed figure standing on a plain two-triangle base.
  const part = box(60);
  const count = part.positions.length / 3;
  const positions = Float64Array.from([...part.positions, -5, -5, 0.31, 6, -5, 0.52, 0.5, 6, 0.47]);
  const tris = Uint32Array.from([...part.tris, count, count + 1, count + 2]);
  const started = performance.now();
  const checked = selfIntersections(positions, tris);
  assert.ok(checked.pairs > 100, `the big triangle cuts through the box's sides (${checked.pairs} pairs)`);
  assert.equal(checked.flagged[tris.length / 3 - 1], 1);
  assert.ok(performance.now() - started < 2000);
  assert.equal(selfIntersections(part.positions, part.tris).pairs, 0);
});

test('the self-crossing check gives up, and says so, when it would take too long', () => {
  const part = box(60);
  const started = performance.now();
  const checked = selfIntersections(part.positions, part.tris, { budget: 1000 });
  assert.equal(checked.pairs, null);
  assert.equal(checked.skipped, true);
  assert.ok(performance.now() - started < 500);
  const same = { positions: part.positions, tris: part.tris };
  assert.equal(countCrossings(same, same).crossingsSkipped, false);
  // Above the size where the count is worth its memory, it is skipped and the page is told.
  const huge = { positions: part.positions, tris: { length: (LIMITS.crossingCheck + 1) * 3 } };
  assert.deepEqual(countCrossings(huge, huge), { crossingsBefore: null, crossingsAfter: null, crossingsSkipped: true });
});

// ---------------------------------------------------------------- files built to waste memory

/** A GLB holding only a scene description, to make dishonest claims with. */
function glb(json, bin = new Uint8Array(0)) {
  const text = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json }));
  const padded = new Uint8Array(text.length + (-text.length & 3)).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(20 + padded.length + (bin.length ? 8 + bin.length : 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(padded, 20);
  if (bin.length) { view.setUint32(20 + padded.length, bin.length, true); view.setUint32(24 + padded.length, 0x004e4942, true); out.set(bin, 28 + padded.length); }
  return out;
}
const triangleBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const oneTriangle = extra => ({
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], ...extra,
});

test('a small GLB that claims a billion points is refused without setting memory aside', () => {
  const started = performance.now();
  const lying = oneTriangle({ accessors: [{ bufferView: 0, componentType: 5126, count: 1_000_000_000, type: 'VEC3' }] });
  assert.throws(() => load(glb(lying, triangleBytes), 'big.glb'), /more than this page can handle/);
  // Under the triangle limit but still more than the file holds.
  const past = oneTriangle({ accessors: [{ bufferView: 0, componentType: 5126, count: 3000, type: 'VEC3' }] });
  assert.throws(() => load(glb(past, triangleBytes), 'past.glb'), /runs past the end/);
  // A claim with no data behind it at all.
  const empty = oneTriangle({ accessors: [{ componentType: 5126, count: 900_000_000, type: 'VEC3' }] });
  assert.throws(() => load(glb(empty, triangleBytes), 'empty.glb'), /more than this page can handle/);
  assert.ok(performance.now() - started < 500);
});

test('a GLB whose scene loops, or lists one mesh endlessly, is refused', () => {
  const loop = oneTriangle({ nodes: [{ mesh: 0, children: [1] }, { children: [0] }] });
  assert.throws(() => load(glb(loop, triangleBytes), 'loop.glb'), /loops back on itself/);
  // Twenty levels, each listing the next level twenty times: 20^20 copies of one triangle.
  const nodes = Array.from({ length: 20 }, (_, i) => ({ children: i < 19 ? Array(20).fill(i + 1) : [], ...(i === 19 ? { mesh: 0 } : {}) }));
  const started = performance.now();
  assert.throws(() => load(glb(oneTriangle({ nodes }), triangleBytes), 'fan.glb'), /more than this page can handle|loops back on itself|nested too deeply/);
  assert.ok(performance.now() - started < 3000);
});

test('a GLB that needs something this page does not understand is refused, and broken ones do not crash', () => {
  assert.throws(() => load(glb(oneTriangle({ extensionsRequired: ['VENDOR_shape_changer'] }), triangleBytes), 'x.glb'), /does not understand/);
  // Material and texture extensions do not change the shape, so they are fine.
  assert.equal(load(glb(oneTriangle({ extensionsRequired: ['KHR_materials_unlit', 'KHR_texture_transform'] }), triangleBytes), 'ok.glb').tris.length, 3);
  // Triangle lists must be whole numbers.
  const floats = oneTriangle({ accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 0, componentType: 5126, count: 3, type: 'SCALAR' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] });
  assert.throws(() => load(glb(floats, triangleBytes), 'f.glb'), /whole numbers/);
  // Nonsense where a list should be gives a plain message, not a programming error.
  for (const nodes of [[{ mesh: 0, rotation: 7 }], [{ mesh: 0, children: 'all' }], [{ mesh: 0, matrix: [1, 2] }]]) {
    try { load(glb(oneTriangle({ nodes }), triangleBytes), 'odd.glb'); } catch (error) { assert.ok(!/is not iterable|undefined|null/.test(error.message), error.message); }
  }
  assert.throws(() => load(glb(oneTriangle({ accessors: [{ bufferView: 0, componentType: 5126, count: -4, type: 'VEC3' }] }), triangleBytes), 'neg.glb'), /impossible|damaged/);
});

test('a GLB with a rig, animation or blend shapes is read, and says which it had', () => {
  assert.deepEqual(load(glb(oneTriangle(), triangleBytes), 'plain.glb').notes, []);
  const rigged = oneTriangle({ nodes: [{ mesh: 0, skin: 0 }, {}], skins: [{ joints: [1] }], animations: [{ channels: [], samplers: [] }] });
  assert.deepEqual(load(glb(rigged, triangleBytes), 'rigged.glb').notes, ['rigged', 'animated']);
  const morph = oneTriangle({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] }] }] });
  assert.deepEqual(load(glb(morph, triangleBytes), 'morph.glb').notes, ['morphs']);
  // The shape read is the one stored in the file: nothing is moved by the rig.
  assert.deepEqual([...load(glb(rigged, triangleBytes), 'rigged.glb').positions], [...load(glb(oneTriangle(), triangleBytes), 'plain.glb').positions]);
  assert.deepEqual(load(writeSTL(Float64Array.from(corners), Uint32Array.from(tetra)), 't.stl').notes, []);
});

test('an STL that claims more triangles than it holds, or than allowed, is refused cheaply', () => {
  const lying = new Uint8Array(84 + 50 * 2);
  new DataView(lying.buffer).setUint32(80, 4_000_000_000, true);
  const started = performance.now();
  assert.throws(() => parseSTL(lying), /cut short/);
  const two = writeSTL(Float64Array.from(corners), Uint32Array.from(tetra.slice(0, 6)));
  assert.throws(() => parseSTL(two, { maxTriangles: 1 }), error => error.tooMany === 2);
  assert.equal(parseSTL(two, { maxTriangles: 2 }).length, 18);
  assert.ok(performance.now() - started < 200);
});

test('a text STL is read piece by piece and comes out the same', () => {
  // Larger than one four-megabyte piece, so entries straddle the joins.
  const lines = ['solid big'];
  const expected = [];
  for (let i = 0; i < 40000; i++) {
    const p = [[i, 0.5, 0], [i + 1, 0.25, 0], [i, 1.5, 0.125]];
    lines.push('  facet normal 0 0 1', '    outer loop', ...p.map(v => `      vertex ${v[0]}.0 ${v[1]} ${v[2]}`), '    endloop', '  endfacet');
    expected.push(...p.flat());
  }
  lines.push('endsolid big');
  const bytes = new TextEncoder().encode(lines.join('\n'));
  assert.ok(bytes.length > (1 << 22), 'the fixture spans more than one piece');
  assert.deepEqual([...parseSTL(bytes)], expected);
  assert.throws(() => parseSTL(bytes, { maxTriangles: 1000 }), error => error.tooMany > 1000);
});

test('a binary STL whose header says "solid ... facet" is still read as binary', () => {
  const bytes = writeSTL(Float64Array.from(corners), Uint32Array.from(tetra));
  bytes.set(new TextEncoder().encode('solid made by facet tool'.padEnd(80, ' ')));
  assert.equal(parseSTL(bytes).length, 36);
});

// ---------------------------------------------------------------- limits and sizes that mean what they say

test('the page and the engine agree on the largest file, and say the same number', () => {
  assert.equal(MAX_BYTES, LIMITS.bytes);
  const megabytes = String(LIMITS.bytes / (1024 * 1024));
  assert.ok(FAILURES.tooLarge.detail.includes(`${megabytes} MB`));
  assert.throws(() => load({ length: LIMITS.bytes + 1 }, 'huge.stl'), new RegExp(`larger than ${megabytes} MB`));
});

test('a GLB with no height chosen is written in millimeters, not a thousand times too small', () => {
  const positions = Float64Array.from([0, 0, 0, 0.05, 0, 0, 0, 0.02, 0, 0, 0, 0.08]); // an 8 cm model, in meters
  const sized = layout(positions, { unitMm: 1000 });
  assert.deepEqual(sized.size.map(value => Math.round(value)), [50, 20, 80]);
  assert.ok(Math.abs(sized.positions[11] - 80) < 1e-9);
  // A height, when given, wins as before.
  assert.ok(Math.abs(layout(positions, { heightMm: 40, unitMm: 1000 }).size[2] - 40) < 1e-9);
  assert.equal(load(glb(oneTriangle(), triangleBytes), 't.glb').unit, 'meter');
  assert.equal(load(writeSTL(Float64Array.from(corners), Uint32Array.from(tetra)), 't.stl').unit, null);
});

/** The model part of a 3MF archive, as text. */
async function modelOf(bytes) {
  const view = new DataView(bytes.buffer);
  let at = view.getUint32(bytes.length - 22 + 16, true);
  for (let i = 0; i < 3; i++) {
    const method = view.getUint16(at + 10, true), packed = view.getUint32(at + 20, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + packed);
    if (name === '3D/3dmodel.model') return new TextDecoder().decode(method === 8 ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : body);
    at += 46 + nameLength;
  }
  throw new Error('no model part');
}

test('a 3MF of a model with very small numbers keeps its points apart', async () => {
  // Two points a millionth of a unit apart, in a model a thousandth of a unit across.
  const positions = Float64Array.from([0, 0, 0, 0.001, 0, 0, 0.001, 0.000001, 0, 0, 0.001, 0]);
  const model = await modelOf(await write3MF(positions, Uint32Array.from([0, 1, 2, 0, 2, 3])));
  const written = [...model.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map(m => m.slice(1, 4).join(' '));
  assert.equal(new Set(written).size, 4, `four different points must stay four: ${written.join(' | ')}`);
  assert.match(model, /y="0\.000001"/);
  // An ordinary model is written to five places, as it always was.
  const plain = await modelOf(await write3MF(Float64Array.from([0, 0, 0, 10.123456789, 0, 0, 0, 10, 0, 0, 0, 7]), Uint32Array.from(tetra)));
  assert.match(plain, /x="10\.12346"/);
});

test('a repaired file read back from STL is still sound, for an awkward model too', () => {
  const gone = new Set(['3,3', '4,3', '5,3', '3,4', '3,5']);
  const part = box(40, [0, 0, 0], 1, (axis, side, i, j) => axis === 2 && side === 1 && gone.has(`${i},${j}`));
  const result = mend(load(writeSTL(part.positions, part.tris), 'l.stl'));
  assert.equal(result.report.status, 'repaired');
  const again = load(writeSTL(result.positions, result.tris), 'again.stl');
  const stats = analyze(again.positions, again.tris);
  assert.deepEqual([stats.openEdges, stats.nonManifoldEdges, stats.inconsistentEdges], [0, 0, 0]);
});
