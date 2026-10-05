import test from 'node:test';
import assert from 'node:assert/strict';
import { selfIntersections } from '../src/intersect.js';

const run = (positions, tris) => selfIntersections(Float64Array.from(positions), Uint32Array.from(tris));

test('a triangle pierced through its middle is found', () => {
  const result = run([0, 0, 0, 4, 0, 0, 0, 4, 0, 1, 1, -1, 1, 1, 1, 3, 3, 2], [0, 1, 2, 3, 4, 5]);
  assert.equal(result.pairs, 1);
  assert.deepEqual([...result.flagged], [1, 1]);
});

test('separate, stacked and neighbouring triangles are not counted', () => {
  assert.equal(run([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5], [0, 1, 2, 3, 4, 5]).pairs, 0);
  assert.equal(run([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], [0, 1, 2, 3, 4, 5]).pairs, 0, 'parallel sheets');
  assert.equal(run([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1], [0, 1, 2, 1, 3, 2]).pairs, 0, 'sharing an edge');
});

test('a closed box has none, two overlapping boxes have many', () => {
  const box = (o, s) => {
    const p = []; for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) p.push(o + x * s, o + y * s, o + z * s);
    return p;
  };
  const faces = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  assert.equal(run(box(0, 1), faces).pairs, 0);
  const both = run([...box(0, 1), ...box(0.5, 1.03)], [...faces, ...faces.map(v => v + 8)]);
  assert.ok(both.pairs >= 6, `found ${both.pairs}`);
});
