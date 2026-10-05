import test from 'node:test';
import assert from 'node:assert/strict';
import { load, mend, sniff } from '../src/pipeline.js';
import { writeSTL } from '../src/stl.js';

const corners = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2]);
const withFin = Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2, 0, 1, 4]);

test('format is taken from the contents, then the name', () => {
  assert.equal(sniff(Uint8Array.from([0x67, 0x6c, 0x54, 0x46]), 'model.stl'), 'glb');
  assert.equal(sniff(new Uint8Array(100), 'model.STL'), 'stl');
  assert.throws(() => sniff(new Uint8Array(100), 'model.obj'), /OBJ files are not supported/);
  assert.throws(() => sniff(new Uint8Array(100), 'holiday photo.PNG'), /PNG files are not supported/);
  assert.equal(sniff(new Uint8Array(100), 'no-extension'), 'stl');
  assert.throws(() => sniff(new Uint8Array(100), 'model.gltf'), /single \.glb/);
});

test('an STL goes in broken and comes out repaired, with the changes marked', () => {
  const mesh = load(writeSTL(corners, withFin), 'tetra.stl');
  assert.equal(mesh.format, 'stl');
  const result = mend(mesh);
  assert.equal(result.report.status, 'repaired');
  assert.deepEqual([...result.kept], [1, 1, 1, 1, 0]);
  assert.equal(result.report.crossingsBefore, 0);
  assert.equal(result.report.crossingsAfter, 0);
});

test('switches turn individual repairs off', () => {
  const mesh = load(writeSTL(corners, withFin), 'tetra.stl');
  const untouched = mend(mesh, { removeStray: false });
  assert.equal(untouched.report.status, 'partial');
  assert.equal(untouched.report.strayFacesRemoved, 0);
  const holed = load(writeSTL(corners, withFin.slice(0, 9)), 'open.stl');
  assert.equal(mend(holed, { patchHoles: false }).report.after.openEdges, 3);
  assert.equal(mend(holed).report.status, 'repaired');
  const wrong = Uint32Array.from([0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 3, 2]);
  assert.equal(mend(load(writeSTL(corners, wrong), 'w.stl'), { fixFacing: false }).report.facesFlipped, 0);
  assert.equal(mend(load(writeSTL(corners, wrong), 'w.stl')).report.facesFlipped, 1);
});

test('bad files are refused with a plain reason', () => {
  assert.throws(() => load(new TextEncoder().encode('hello'), 'x.stl'), /does not look like an STL/);
  const nan = writeSTL(Float64Array.from([0, 0, 0, 1, 0, 0, 0, NaN, 0]), Uint32Array.from([0, 1, 2]));
  assert.throws(() => load(nan, 'nan.stl'), /invalid coordinates/);
});
