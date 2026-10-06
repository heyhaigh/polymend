// Unpack Draco-compressed geometry, which many published GLB files use (museum scans
// especially). The decoder is Google's own, vendored in src/vendor/ under the Apache 2.0
// license (see DRACO-LICENSE.txt there), in its plain-JavaScript build so that no WebAssembly
// or extra file is loaded. It is 700 KB, so it is only loaded when a file needs it.
import DracoDecoderModule from './vendor/draco-decoder.js';

let ready = null;

/** The decoder, set up once. */
function module() {
  ready ||= DracoDecoderModule();
  return ready;
}

/**
 * Decode one compressed primitive. `attribute` is the unique id Draco gave its positions
 * (the glTF extension says which). Returns the points, three floats each, and the corners
 * of each triangle as indexes into them. `maxTriangles` is checked before the points are
 * copied out, since a small compressed buffer can unpack into a very large mesh.
 */
export async function decodeDraco(bytes, attribute, { maxTriangles = Infinity } = {}) {
  const draco = await module();
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  const mesh = new draco.Mesh();
  try {
    buffer.Init(bytes, bytes.byteLength);
    if (decoder.GetEncodedGeometryType(buffer) !== draco.TRIANGULAR_MESH) throw new Error('This GLB file holds compressed points or lines, not a surface.');
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error('The compressed geometry in this GLB file could not be unpacked.');
    const points = mesh.num_points(), faces = mesh.num_faces();
    if (faces > maxTriangles) throw Object.assign(new Error('Too many triangles'), { tooMany: faces });
    const position = decoder.GetAttributeByUniqueId(mesh, attribute);
    if (!position || position.ptr === 0 || position.num_components() !== 3) throw new Error('The compressed geometry in this GLB file has no positions.');
    const positionBytes = points * 3 * 4;
    const positionPtr = draco._malloc(positionBytes);
    let positions, indices;
    try {
      decoder.GetAttributeDataArrayForAllPoints(mesh, position, draco.DT_FLOAT32, positionBytes, positionPtr);
      positions = new Float32Array(draco.HEAPF32.buffer, positionPtr, points * 3).slice();
    } finally { draco._free(positionPtr); }
    const indexBytes = faces * 3 * 4;
    const indexPtr = draco._malloc(indexBytes);
    try {
      decoder.GetTrianglesUInt32Array(mesh, indexBytes, indexPtr);
      indices = new Uint32Array(draco.HEAPU32.buffer, indexPtr, faces * 3).slice();
    } finally { draco._free(indexPtr); }
    return { positions, indices };
  } finally {
    draco.destroy(mesh); draco.destroy(buffer); draco.destroy(decoder);
  }
}
