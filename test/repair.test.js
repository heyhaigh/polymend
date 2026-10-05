import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, weld } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { parseSTL, writeSTL } from '../src/stl.js';

// A closed tetrahedron, wound so its volume is positive.
const corners = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const tetra = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2];
const mesh = (positions, tris) => [Float64Array.from(positions), Uint32Array.from(tris)];
const defects = stats => [stats.openEdges, stats.nonManifoldEdges, stats.inconsistentEdges];
// Most of these meshes are toys: a tetrahedron, where a single missing face or a fin is
// as big as the whole model. The size limits that protect real models would refuse to
// touch them, so the tests that are about something else lift those limits.
const toy = { patchWide: true, straySpan: Infinity };

/** A closed, finely divided box, used where a model must dwarf a defect. */
function box(divisions = 6, offset = [0, 0, 0], size = 1) {
  const soup = [];
  const quad = (a, b, c, d) => soup.push(...a, ...b, ...c, ...a, ...c, ...d);
  const at = (axis, side, u, v) => {
    const p = [0, 0, 0];
    p[axis] = side; p[(axis + 1) % 3] = u; p[(axis + 2) % 3] = v;
    return p.map((value, i) => offset[i] + value * size);
  };
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
    for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions; j++) {
      const [u0, u1, v0, v1] = [i / divisions, (i + 1) / divisions, j / divisions, (j + 1) / divisions];
      const ring = [at(axis, side, u0, v0), at(axis, side, u1, v0), at(axis, side, u1, v1), at(axis, side, u0, v1)];
      quad(...(side ? ring : ring.reverse()));
    }
  }
  return weld(Float64Array.from(soup));
}

test('a sound mesh is left exactly as it was', () => {
  const [positions, tris] = mesh(corners, tetra);
  const result = repair(positions, tris);
  assert.equal(result.report.clean, true);
  assert.deepEqual([...result.tris], tetra);
  assert.deepEqual([...result.positions], corners);
  assert.equal(result.report.trianglesAdded + result.report.strayFacesRemoved + result.report.facesFlipped, 0);
});

test('the test box is closed and positive', () => {
  const { positions, tris } = box();
  const stats = analyze(positions, tris);
  assert.deepEqual(defects(stats), [0, 0, 0]);
  assert.ok(Math.abs(stats.volume - 1) < 1e-9);
});

test('a fin on a good edge is removed and nothing else changes', () => {
  const [positions, tris] = mesh([...corners, 2, 2, 2], [...tetra, 0, 1, 4]);
  assert.deepEqual(defects(analyze(positions, tris)).slice(0, 2), [2, 1]);
  const result = repair(positions, tris, toy);
  assert.equal(result.report.clean, true);
  assert.equal(result.report.strayFacesRemoved, 1);
  assert.equal(result.tris.length / 3, 4);
  assert.equal(result.positions.length / 3, 4, 'the fin tip is dropped');
});

test('a flap of two triangles is removed entirely', () => {
  const [positions, tris] = mesh([...corners, 2, 2, 2, 3, 3, 3], [...tetra, 0, 1, 4, 1, 5, 4]);
  const result = repair(positions, tris, toy);
  assert.equal(result.report.clean, true);
  assert.equal(result.tris.length / 3, 4);
});

test('a missing triangle is filled', () => {
  const [positions, tris] = mesh(corners, tetra.slice(0, 9));
  const result = repair(positions, tris, toy);
  assert.equal(result.report.clean, true);
  assert.deepEqual(result.report.holesFilled, [3]);
  assert.ok(Math.abs(result.report.after.volume - 1 / 6) < 1e-12);
});

test('a four-edge hole is filled with two triangles and no new vertex', () => {
  const { positions, tris } = box();
  const result = repair(positions, tris.slice(6), toy); // drop one square of the grid
  assert.equal(result.report.clean, true);
  assert.deepEqual(result.report.holesFilled, [4]);
  assert.equal(result.report.trianglesAdded, 2);
  assert.equal(result.positions.length, positions.length);
  assert.ok(Math.abs(result.report.after.volume - 1) < 1e-9);
});

test('a larger hole is filled with a fan, and holes over the limit are reported', () => {
  const { positions, tris } = box(6);
  const holed = tris.slice(6 * 2 * 3 * 2); // drop two strips of one side
  const filled = repair(positions, holed, toy);
  assert.equal(filled.report.clean, true);
  assert.ok(filled.report.holesFilled[0] > 4);
  const left = repair(positions, holed, { ...toy, maxHoleEdges: 4 });
  assert.equal(left.report.clean, false);
  assert.equal(left.report.holesLeftOpen.length, 1);
  assert.ok(left.report.after.openEdges > 0);
});

test('a face wound the wrong way is turned', () => {
  const flipped = [...tetra];
  [flipped[1], flipped[2]] = [flipped[2], flipped[1]];
  const [positions, tris] = mesh(corners, flipped);
  assert.ok(analyze(positions, tris).inconsistentEdges > 0);
  const result = repair(positions, tris);
  assert.equal(result.report.clean, true);
  assert.equal(result.report.facesFlipped, 1);
});

test('an inside-out shell is turned outward', () => {
  const inside = [];
  for (let i = 0; i < tetra.length; i += 3) inside.push(tetra[i], tetra[i + 2], tetra[i + 1]);
  const result = repair(...mesh(corners, inside));
  assert.equal(result.report.clean, true);
  assert.ok(result.report.after.volume > 0);
});

test('touching solids are left touching unless separation is asked for', () => {
  // Two tetrahedra sharing the edge 0-1: that edge has four faces.
  const positions = [...corners, 0, -1, 0, 0, 0, -1];
  const second = [0, 4, 1, 0, 5, 4, 4, 5, 1, 0, 1, 5];
  const [p, t] = mesh(positions, [...tetra, ...second]);
  assert.equal(analyze(p, t).nonManifoldEdges, 1);
  assert.ok(Math.abs(analyze(p, t).volume - 2 / 6) < 1e-12);
  const kept = repair(p, t);
  assert.equal(kept.report.status, 'partial');
  assert.equal(kept.report.pinchedEdgesLeft, 1);
  assert.equal(kept.report.pinchedEdgesCut, 0);
  assert.deepEqual([...kept.tris], [...t], 'nothing is cut');
  const result = repair(p, t, { separatePinches: true }); // the openings the cut leaves are closed whatever their size
  assert.equal(result.report.clean, true);
  assert.equal(result.report.pinchedEdgesCut, 1);
  assert.equal(result.report.specksRemoved, 0);
  assert.equal(result.report.after.shells, 2);
  // One side is patched back as it was; the other gets a small dent at the old edge.
  assert.ok(result.report.after.volume > 1.4 / 6 && result.report.after.volume <= 2 / 6);
});

test('a small pocket glued along an edge of a larger model is deleted whole', () => {
  const big = box(6);
  const count = big.positions.length / 3;
  // A pocket of three triangles around a new point, sharing the edge 0-1 of a grid square.
  const [a, b] = [big.tris[0], big.tris[1]];
  const at = v => [0, 1, 2].map(c => big.positions[v * 3 + c]);
  const mid = at(a).map((value, c) => (value + at(b)[c]) / 2);
  const positions = Float64Array.from([...big.positions, mid[0] - 0.01, mid[1] - 0.01, mid[2] - 0.01, mid[0] - 0.02, mid[1] - 0.005, mid[2] - 0.005]);
  const pocket = [a, b, count, b, count + 1, count, count + 1, a, count]; // the face a-b-(count+1) is missing
  const result = repair(positions, Uint32Array.from([...big.tris, ...pocket]), toy);
  assert.equal(result.report.clean, true);
  assert.equal(result.report.strayFacesRemoved, 3);
  assert.equal(result.report.pinchedEdgesCut, 0);
  assert.equal(result.report.trianglesAdded, 0);
  assert.deepEqual([...result.tris], [...big.tris], 'the real surface is untouched');
});

test('a pinch with one face missing is repaired', () => {
  const positions = [...corners, 0, -1, 0, 0, 0, -1];
  const second = [0, 5, 4, 4, 5, 1, 0, 1, 5]; // the face 0-4-1 is missing
  const result = repair(...mesh(positions, [...tetra, ...second]), toy);
  assert.equal(result.report.clean, true);
});

test('exact duplicate and degenerate faces are dropped', () => {
  const result = repair(...mesh(corners, [...tetra, 0, 2, 1, 0, 0, 1]));
  assert.equal(result.report.clean, true);
  assert.equal(result.report.duplicateRemoved, 1);
  assert.equal(result.report.degenerateRemoved, 1);
  assert.equal(result.tris.length / 3, 4);
});

test('a tiny closed speck is cleared from a faulty model, and a real second part is kept', () => {
  const big = box(6);
  const count = big.positions.length / 3;
  const speck = [...corners].map((value, i) => value * 0.01 + 5);
  const faulty = big.tris.slice(6); // the model has a hole, so it is being repaired anyway
  const withSpeck = repair(Float64Array.from([...big.positions, ...speck]), Uint32Array.from([...faulty, ...tetra.map(v => v + count)]), toy);
  assert.equal(withSpeck.report.specksRemoved, 1);
  assert.equal(withSpeck.report.after.shells, 1);
  const part = box(6, [3, 0, 0], 0.2);
  const twoParts = repair(Float64Array.from([...big.positions, ...part.positions]), Uint32Array.from([...faulty, ...[...part.tris].map(v => v + count)]), toy);
  assert.equal(twoParts.report.specksRemoved, 0);
  assert.equal(twoParts.report.after.shells, 2);
  assert.equal(twoParts.report.clean, true);
});

test('a sound model with a tiny separate part is left exactly as it is', () => {
  // A peg or a bolt head on a large part is tiny and closed, just like debris. In a model
  // with no faults there is no reason to think it is debris, so nothing is touched.
  const big = box(6);
  const count = big.positions.length / 3;
  const peg = box(1, [5, 5, 5], 0.01);
  const positions = Float64Array.from([...big.positions, ...peg.positions]);
  const tris = Uint32Array.from([...big.tris, ...[...peg.tris].map(v => v + count)]);
  const result = repair(positions, tris);
  assert.equal(result.report.status, 'sound');
  assert.equal(result.report.specksRemoved, 0);
  assert.deepEqual([...result.tris], [...tris]);
  assert.deepEqual([...result.positions], [...positions]);
});

test('repaired output survives a round trip through binary STL', () => {
  const { positions, tris } = box();
  const broken = Uint32Array.from([...tris.slice(6), 0, 1, positions.length / 3]);
  const result = repair(Float64Array.from([...positions, 9, 9, 9]), broken, toy);
  const again = weld(parseSTL(writeSTL(result.positions, result.tris)));
  assert.deepEqual(defects(analyze(again.positions, again.tris)), [0, 0, 0]);
});

test('ASCII STL is read', () => {
  const text = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n';
  assert.deepEqual([...parseSTL(new TextEncoder().encode(text))], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.throws(() => parseSTL(new TextEncoder().encode('not a model')), /does not look like an STL/);
});

test('the outcome is named: sound, repaired or partial', () => {
  assert.equal(repair(...mesh(corners, tetra)).report.status, 'sound');
  assert.equal(repair(...mesh(corners, tetra.slice(0, 9)), toy).report.status, 'repaired');
  const { positions, tris } = box(6);
  assert.equal(repair(positions, tris.slice(6 * 2 * 3 * 2), { maxHoleEdges: 4 }).report.status, 'partial');
});

test('a hollow part keeps its cavity facing inward', () => {
  const outer = box(6);
  const inner = box(4, [0.25, 0.25, 0.25], 0.5);
  const count = outer.positions.length / 3;
  const cavity = [];
  for (let i = 0; i < inner.tris.length; i += 3) cavity.push(inner.tris[i] + count, inner.tris[i + 2] + count, inner.tris[i + 1] + count);
  const positions = Float64Array.from([...outer.positions, ...inner.positions]);
  const hollow = Uint32Array.from([...outer.tris, ...cavity]);
  assert.ok(Math.abs(analyze(positions, hollow).volume - (1 - 0.125)) < 1e-9);
  const result = repair(positions, hollow);
  assert.equal(result.report.status, 'sound');
  assert.equal(result.report.facesFlipped, 0);
  assert.deepEqual([...result.tris], [...hollow]);
  // The same cavity with one face wound wrongly is corrected toward the cavity, not turned outward.
  const damaged = Uint32Array.from(hollow);
  const last = damaged.length - 3;
  [damaged[last + 1], damaged[last + 2]] = [damaged[last + 2], damaged[last + 1]];
  const mended = repair(positions, damaged);
  assert.equal(mended.report.facesFlipped, 1);
  assert.ok(Math.abs(mended.report.after.volume - (1 - 0.125)) < 1e-9);
});

test('an inner solid keeps facing outward, and an inside-out outer shell is still turned', () => {
  const outer = box(6);
  const inner = box(4, [0.25, 0.25, 0.25], 0.5);
  const count = outer.positions.length / 3;
  const positions = Float64Array.from([...outer.positions, ...inner.positions]);
  const both = Uint32Array.from([...outer.tris, ...[...inner.tris].map(v => v + count)]);
  assert.equal(repair(positions, both).report.facesFlipped, 0);
  const insideOut = Uint32Array.from(both);
  for (let i = 0; i < outer.tris.length; i += 3) [insideOut[i + 1], insideOut[i + 2]] = [insideOut[i + 2], insideOut[i + 1]];
  const result = repair(positions, insideOut);
  assert.equal(result.report.facesFlipped, outer.tris.length / 3);
  assert.ok(Math.abs(result.report.after.volume - 1.125) < 1e-9);
});

test('each output face reports the input face it came from', () => {
  const [positions, tris] = mesh([...corners, 2, 2, 2], [0, 1, 4, ...tetra.slice(0, 9)]);
  const result = repair(positions, tris, toy);
  assert.equal(result.report.clean, true);
  assert.deepEqual([...result.origin], [1, 2, 3, -1], 'the fin (face 0) is gone and the patch is marked -1');
});

test('a model made only of loose triangles does not overflow the stack', () => {
  // One group per triangle: 150,000 of them, far more than can be spread into Math.max.
  const count = 150000;
  const positions = new Float64Array(count * 9), tris = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions.set([i * 3, 0, 0, i * 3 + 1, 0, 0, i * 3, 1, 0], i * 9);
    tris.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  }
  const result = repair(positions, tris, { patchHoles: false });
  assert.equal(result.report.status, 'partial');
  assert.equal(result.report.before.shells, count);
});

test('binary STL with extra bytes at the end, or a header that starts with "solid", is read', () => {
  const plain = writeSTL(Float64Array.from(corners), Uint32Array.from(tetra));
  const padded = new Uint8Array(plain.length + 37);
  padded.set(plain);
  assert.equal(parseSTL(padded).length, 36);
  const named = Uint8Array.from(plain);
  named.set(new TextEncoder().encode('solid made by some exporter'), 0);
  assert.equal(parseSTL(named).length, 36);
  assert.throws(() => parseSTL(new Uint8Array(5000)), /does not look like an STL/);
});
