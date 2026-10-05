import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, write3MF, zip } from '../src/output.js';
import { parseSTL, writeSTL } from '../src/stl.js';

test('layout scales to a height, stands the model on the bed and centres it', () => {
  const result = layout(Float64Array.from([1, 1, 5, 3, 1, 5, 1, 5, 9]), { heightMm: 40 });
  assert.equal(result.scale, 10);
  assert.deepEqual(result.size, [20, 40, 40]);
  assert.deepEqual([...result.positions], [-10, -20, 0, 10, -20, 0, -10, 20, 40]);
});

test('layout without a height leaves the model exactly where it was', () => {
  const input = Float64Array.from([0, 0, 2, 1, 0, 2, 0, 1, 3]);
  const result = layout(input);
  assert.equal(result.scale, 1);
  assert.deepEqual([...result.positions], [...input]);
  assert.deepEqual(result.size, [1, 1, 1]);
});

test('the STL header carries a note and never looks like an ASCII file', () => {
  const bytes = writeSTL(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]), 1, 'solid test note');
  const header = new TextDecoder().decode(bytes.subarray(0, 80));
  assert.ok(header.startsWith('binary STL solid test note'));
  assert.deepEqual([...parseSTL(bytes)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
});

test('a 3MF file is a valid archive holding the mesh in millimetres', async () => {
  const bytes = await write3MF(Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10.5, 0, 0, 0, 7.25]), Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]), { title: 'A & B <test>' });
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 3);
  // Read each entry back through the central directory.
  const files = {};
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < 3; i++) {
    const method = view.getUint16(at + 10, true), packed = view.getUint32(at + 20, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + packed);
    const raw = method === 8 ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : body;
    files[name] = new TextDecoder().decode(raw);
    at += 46 + nameLength;
  }
  assert.deepEqual(Object.keys(files), ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
  const model = files['3D/3dmodel.model'];
  assert.match(model, /unit="millimeter"/);
  assert.match(model, /A &amp; B &lt;test&gt;/);
  assert.equal((model.match(/<vertex /g) || []).length, 4);
  assert.equal((model.match(/<triangle /g) || []).length, 4);
  assert.match(model, /<vertex x="0" y="10.5" z="0"\/>/);
  assert.match(model, /<triangle v1="0" v2="2" v3="1"\/>/);
});

test('a ZIP of two files lists both, each with a correct checksum and size', async () => {
  const one = new TextEncoder().encode('first file '.repeat(200)), two = Uint8Array.from([1, 2, 3, 4, 5]);
  const bytes = await zip([['model-mended.stl', one], ['model-mended.3mf', two]]);
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let at = view.getUint32(end + 16, true);
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const method = view.getUint16(at + 10, true), packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + packed);
    const raw = method === 8 ? new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : body;
    seen.push([name, size, raw.length, method]);
    assert.deepEqual([...raw.subarray(0, 5)], [...(i ? two : one).subarray(0, 5)]);
    at += 46 + nameLength;
  }
  assert.deepEqual(seen.map(entry => entry.slice(0, 3)), [['model-mended.stl', one.length, one.length], ['model-mended.3mf', 5, 5]]);
  assert.equal(seen[0][3], 8, 'repetitive data is compressed');
  assert.equal(seen[1][3], 0, 'tiny data is stored as is');
});

test('3MF numbers never read "-0"', async () => {
  const bytes = await write3MF(Float64Array.from([-0.0000001, 0, 0, 1, 0, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2]));
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(!text.includes('"-0"'));
});
