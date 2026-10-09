import test from 'node:test';
import assert from 'node:assert/strict';
import { openGLB, parseGLB } from '../src/glb.js';
import { load } from '../src/pipeline.js';
import { glb } from './glb-builder.js';

// One triangle, and one clip that moves the node it hangs on.
const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const position = { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' };
const near = (actual, expected, message) => expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < 1e-6, `${message || 'coordinate'} ${i}: ${actual[i]} is not ${value}`));

/** A file whose node 0 carries the triangle and is moved by one channel of clip 0. */
function moving(path, times, values, interpolation = 'LINEAR', width = path === 'rotation' ? 'VEC4' : 'VEC3') {
  return glb({
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [position, { bufferView: 1, componentType: 5126, count: times.length, type: 'SCALAR' }, { bufferView: 2, componentType: 5126, count: values.length / (width === 'VEC4' ? 4 : 3), type: width }],
    animations: [{ name: 'Rig|Slide', channels: [{ sampler: 0, target: { node: 0, path } }], samplers: [{ input: 1, output: 2, interpolation }] }],
  }, [triangle, new Float32Array(times), new Float32Array(values)]);
}

test('without a pose, an animated file is read exactly as stored', () => {
  const file = moving('translation', [0, 1], [0, 0, 0, 10, 0, 0]);
  assert.deepEqual([...parseGLB(file)], [...triangle]);
  assert.deepEqual([...openGLB(file).bake(null)], [...triangle]);
});

test('a pose moves a node part way between keyframes', () => {
  const file = moving('translation', [0, 1], [0, 0, 0, 10, 0, 0]);
  near(parseGLB(file, { pose: { clip: 0, time: 0.25 } }), [2.5, 0, 0, 3.5, 0, 0, 2.5, 1, 0]);
});

test('a moment before the first keyframe or after the last holds that keyframe', () => {
  const file = moving('translation', [0.5, 1], [4, 0, 0, 10, 0, 0]);
  near(parseGLB(file, { pose: { clip: 0, time: 0 } }), [4, 0, 0]);
  near(parseGLB(file, { pose: { clip: 0, time: 5 } }), [10, 0, 0]);
});

test('a stepped clip holds each keyframe until the next', () => {
  const file = moving('translation', [0, 1], [0, 0, 0, 10, 0, 0], 'STEP');
  near(parseGLB(file, { pose: { clip: 0, time: 0.99 } }), [0, 0, 0]);
  near(parseGLB(file, { pose: { clip: 0, time: 1 } }), [10, 0, 0]);
});

test('a rotation turns along the shortest arc', () => {
  const s = Math.SQRT1_2;
  // A quarter turn about Z, sampled halfway: an eighth of a turn.
  const file = moving('rotation', [0, 1], [0, 0, 0, 1, 0, 0, s, s]);
  const c = Math.cos(Math.PI / 8 * 2) /* 45 degrees */;
  near(parseGLB(file, { pose: { clip: 0, time: 0.5 } }), [0, 0, 0, c, c, 0, -c, c, 0]);
});

test('a curved clip follows its tangents', () => {
  // Values 0 then 0, leaving the first keyframe with a slope of 1: at the middle, 1/8.
  const values = [0, 0, 0, 0, 0, 0, 1, 0, 0, /* key 2: */ 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const file = moving('translation', [0, 1], values, 'CUBICSPLINE');
  near(parseGLB(file, { pose: { clip: 0, time: 0.5 } }), [0.125, 0, 0]);
});

/**
 * A triangle tied to two bones: its first two corners to bone A, its third to bone B, or
 * split half and half when `split`. The clip lifts bone B by 5. The mesh's own node is
 * far away, which a skinned mesh ignores.
 */
function rigged({ split = false, mirror = false } = {}) {
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, split ? 0 : 1, split ? 1 : 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, split ? 0.5 : 1, split ? 0.5 : 0, 0, 0]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return glb({
    scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, skin: 0, translation: [100, 0, 0] }, { children: [2], ...(mirror ? { scale: [-1, 1, 1] } : {}) }, { name: 'B' }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    accessors: [position, { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' }, { bufferView: 4, componentType: 5126, count: 2, type: 'MAT4' }, { bufferView: 5, componentType: 5126, count: 2, type: 'VEC3' }],
    animations: [{ name: 'Lift', channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }], samplers: [{ input: 3, output: 5 }] }],
  }, [triangle, joints, weights, new Float32Array([0, 1]), new Float32Array([...identity, ...identity]), new Float32Array([0, 0, 0, 0, 5, 0])]);
}

test('in a pose, each point follows the bone it is tied to', () => {
  near(parseGLB(rigged(), { pose: { clip: 0, time: 1 } }), [0, 0, 0, 1, 0, 0, 0, 6, 0]);
  // The rest pose is the shape as stored, where the mesh's own node does place it.
  near(parseGLB(rigged()), [100, 0, 0, 101, 0, 0, 100, 1, 0]);
});

test('a point tied to two bones moves by their weights', () => {
  near(parseGLB(rigged({ split: true }), { pose: { clip: 0, time: 1 } }).subarray(6), [0, 3.5, 0]);
});

test('a skeleton that mirrors the model keeps its triangles facing outward', () => {
  // Bone A is mirrored and carries corners 1 and 2, so most of the triangle is mirrored.
  const out = parseGLB(rigged({ mirror: true }), { pose: { clip: 0, time: 0 } });
  near(out, [0, 0, 0, 0, 1, 0, -1, 0, 0]);
});

test('blend shapes are applied at the weights the clip gives them, also when stored sparsely', () => {
  const file = glb({
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }], weights: [0] }],
    accessors: [position, { componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1, indices: { bufferView: 1, componentType: 5125 }, values: { bufferView: 2 } } },
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' }, { bufferView: 4, componentType: 5126, count: 2, type: 'SCALAR' }],
    animations: [{ channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }], samplers: [{ input: 2, output: 3 }] }],
  }, [triangle, new Uint32Array([1]), new Float32Array([0, 0, 2]), new Float32Array([0, 1]), new Float32Array([0, 1])]);
  near(parseGLB(file), [...triangle]);
  near(parseGLB(file, { pose: { clip: 0, time: 0.5 } }), [0, 0, 0, 1, 0, 1, 0, 1, 0]);
});

test('clips are listed with their length, keyframes and a short name', () => {
  const { clips } = openGLB(moving('translation', [0, 0.5, 2], [0, 0, 0, 1, 0, 0, 2, 0, 0]));
  assert.deepEqual(clips, [{ index: 0, name: 'Rig|Slide', label: 'Slide', duration: 2, keys: [0, 0.5, 2] }]);
});

test('the pipeline poses a file, says which pose, and keeps the time within the clip', () => {
  const file = moving('translation', [0, 1], [0, 0, 0, 10, 0, 0]);
  const rest = load(file, 'm.glb');
  assert.equal(rest.pose, null);
  assert.deepEqual(rest.clips.map(c => c.label), ['Slide']);
  const posed = load(file, 'm.glb', { pose: { clip: 0, time: 7 } });
  assert.deepEqual(posed.pose, { clip: 0, time: 1 });
  assert.ok(Math.min(...[0, 3, 6].map(i => posed.positions[i])) > 9.99);
  assert.throws(() => load(file, 'm.glb', { pose: { clip: 3, time: 0 } }), /no such animation/);
  // A quick preview of another pose, unwelded, without reading the file again.
  near(rest.posed({ clip: 0, time: 0.5 }), [5, 0, 0]);
});

test('a curved clip scales its tangents by the time between keyframes', () => {
  // The same slope of 1, over two seconds instead of one: at the middle, 2/8.
  const values = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  near(parseGLB(moving('translation', [0, 2], values, 'CUBICSPLINE'), { pose: { clip: 0, time: 1 } }), [0.25, 0, 0]);
});

test('a rotation stored with the opposite sign still takes the short way round', () => {
  const s = Math.SQRT1_2;
  // The second keyframe is the same quarter turn as before, written as its negative.
  const file = moving('rotation', [0, 1], [0, 0, 0, 1, 0, 0, -s, -s]);
  const c = Math.SQRT1_2;
  near(parseGLB(file, { pose: { clip: 0, time: 0.5 } }), [0, 0, 0, c, c, 0, -c, c, 0]);
});

test('bone weights that do not add up to one are scaled so that they do', () => {
  // Corner 3 is tied to bone B with a weight of 2, which is the same as a weight of 1.
  const file = rigged();
  const bytes = new Uint8Array(file);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer).getUint32(12, true))));
  const at = 20 + new DataView(bytes.buffer).getUint32(12, true) + 8 + json.bufferViews[2].byteOffset;
  new DataView(bytes.buffer).setFloat32(at + 2 * 16, 2, true); // corner 3's first weight
  near(parseGLB(bytes, { pose: { clip: 0, time: 1 } }).subarray(6), [0, 6, 0]);
});
