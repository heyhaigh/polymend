// Builds small GLB files for the tests. Not a test itself.

/** Build a GLB from a scene description and a list of typed arrays (one bufferView each). */
export function glb(json, arrays = []) {
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
