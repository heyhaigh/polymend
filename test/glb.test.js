import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGLB, yUpToZUp } from '../src/glb.js';

/** Build a GLB from a scene description and a list of typed arrays (one bufferView each). */
function glb(json, arrays = []) {
  let length = 0;
  const views = arrays.map(array => { const view = { buffer: 0, byteOffset: length, byteLength: array.byteLength }; length += array.byteLength + (-array.byteLength & 3); return view; });
  const bin = new Uint8Array(length);
  arrays.forEach((array, i) => bin.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), views[i].byteOffset));
  const doc = { asset: { version: '2.0' }, buffers: [{ byteLength: length }], bufferViews: views, ...json };
  let text = new TextEncoder().encode(JSON.stringify(doc));
  const padded = new Uint8Array(text.length + (-text.length & 3)).fill(0x20);
  padded.set(text);
  const out = new Uint8Array(12 + 8 + padded.length + (length ? 8 + length : 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(padded, 20);
  if (length) { view.setUint32(20 + padded.length, length, true); view.setUint32(24 + padded.length, 0x004e4942, true); out.set(bin, 28 + padded.length); }
  return out;
}

const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const position = { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' };
const scene = (node, extra = {}) => ({ scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, ...node }], accessors: [position], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], ...extra });

test('a plain triangle is read', () => {
  assert.deepEqual([...parseGLB(glb(scene({}), [triangle]))], [...triangle]);
});

test('indices choose the corner order', () => {
  const json = scene({}, { accessors: [position, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] });
  assert.deepEqual([...parseGLB(glb(json, [triangle, new Uint16Array([2, 0, 1])]))], [0, 1, 0, 0, 0, 0, 1, 0, 0]);
});

test('node translation, scale and nesting are applied', () => {
  const json = scene({}, { scenes: [{ nodes: [1] }], nodes: [{ mesh: 0, scale: [2, 2, 2] }, { children: [0], translation: [10, 0, 0] }] });
  assert.deepEqual([...parseGLB(glb(json, [triangle]))], [10, 0, 0, 12, 0, 0, 10, 2, 0]);
});

test('a quarter turn about Y is applied', () => {
  const s = Math.SQRT1_2;
  const out = parseGLB(glb(scene({ rotation: [0, s, 0, s] }), [triangle]));
  [0, 0, 0, 0, 0, -1, 0, 1, 0].forEach((value, i) => assert.ok(Math.abs(out[i] - value) < 1e-9, `coordinate ${i}`));
});

test('a mirrored node keeps its triangles facing outward', () => {
  assert.deepEqual([...parseGLB(glb(scene({ scale: [-1, 1, 1] }), [triangle]))], [0, 0, 0, 0, 1, 0, -1, 0, 0]);
});

test('a file with two triangles in a strip gives two triangles', () => {
  const quad = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const json = scene({}, { accessors: [{ ...position, count: 4 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }] });
  assert.equal(parseGLB(glb(json, [quad])).length, 18);
});

test('Y-up becomes Z-up', () => {
  assert.deepEqual([...yUpToZUp(Float64Array.from([1, 2, 3]))], [1, -3, 2]);
});

test('unsupported and broken files are refused with a reason', () => {
  assert.throws(() => parseGLB(new Uint8Array(40)), /does not look like a GLB/);
  assert.throws(() => parseGLB(glb(scene({}, { extensionsRequired: ['KHR_draco_mesh_compression'] }), [triangle])), /Draco/);
  assert.throws(() => parseGLB(glb(scene({}, { accessors: [{ ...position, count: 300 }] }), [triangle])), /past the end/);
  assert.throws(() => parseGLB(glb(scene({}, { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }] }), [triangle])), /No triangles were found/);
  const bad = scene({}, { accessors: [position, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }] });
  assert.throws(() => parseGLB(glb(bad, [triangle, new Uint16Array([0, 1, 9])])), /does not exist/);
});
