// Binary and ASCII STL reading, binary STL writing. No dependencies.

/** Thrown by the readers when a file holds more triangles than the caller allows. */
export function tooMany(count) {
  return Object.assign(new Error('Too many triangles'), { tooMany: count });
}

/**
 * Read an STL file into nine numbers per triangle. `maxTriangles` is checked before any
 * large amount of memory is set aside, so an oversized or dishonest file is refused
 * cheaply instead of exhausting the browser tab.
 */
export function parseSTL(buffer, { maxTriangles = Infinity } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const binary = () => {
    if (count > maxTriangles) throw tooMany(count);
    const soup = new Float32Array(count * 9);
    for (let f = 0, o = 84; f < count; f++, o += 50) {
      for (let k = 0; k < 9; k++) soup[f * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
    }
    return soup;
  };
  // A binary file's length follows exactly from its triangle count. When the two agree
  // the file is binary, whatever its free-text header says.
  if (count > 0 && 84 + count * 50 === bytes.byteLength) return binary();
  // A text STL starts with "solid" and soon says "facet". Some binary files also start
  // with "solid" in their header, so both signs are needed to call it text.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
  const text = /^\s*solid/.test(head) && (/facet|endsolid/.test(head) || bytes.byteLength < 84);
  if (!text) {
    // A few exporters add bytes after the triangles; that is harmless.
    if (count > 0 && 84 + count * 50 < bytes.byteLength) return binary();
    if (count > 0 && bytes.byteLength > 84 && (bytes.byteLength - 84) % 50 === 0) throw new Error('This STL file is cut short: part of the model is missing from it.');
    throw new Error('This does not look like an STL file.');
  }
  // Text is read a piece at a time, so a very large file never becomes one enormous string.
  const decoder = new TextDecoder();
  const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const PIECE = 1 << 22;
  let values = new Float32Array(9 * 4096), used = 0, carry = '';
  for (let offset = 0; offset < bytes.byteLength; offset += PIECE) {
    const last = offset + PIECE >= bytes.byteLength;
    const piece = carry + decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + PIECE)), { stream: !last });
    // Hold back the final, possibly unfinished, "vertex" entry for the next piece.
    const cut = last ? piece.length : Math.max(0, piece.lastIndexOf('vertex'));
    carry = piece.slice(cut);
    if (carry.length > PIECE) throw new Error('This text STL file is not laid out as an STL should be.');
    const body = piece.slice(0, cut);
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(body));) {
      if (used + 3 > values.length) {
        if (used / 9 > maxTriangles) throw tooMany(Math.round((used / 9) * (bytes.byteLength / Math.max(1, offset + PIECE))));
        const grown = new Float32Array(values.length * 2);
        grown.set(values);
        values = grown;
      }
      values[used++] = +m[1]; values[used++] = +m[2]; values[used++] = +m[3];
    }
  }
  if (used / 9 > maxTriangles) throw tooMany(used / 9);
  if (used === 0 || used % 9) throw new Error('This text STL file has incomplete triangles.');
  return values.slice(0, used);
}

export function writeSTL(positions, tris, scale = 1, note = '') {
  const count = tris.length / 3;
  const out = new Uint8Array(84 + count * 50);
  const view = new DataView(out.buffer);
  // The 80-byte header is free text. It must not begin with "solid", which marks an ASCII file.
  out.set(new TextEncoder().encode(('binary STL ' + note).slice(0, 80)));
  view.setUint32(80, count, true);
  for (let f = 0, o = 84; f < count; f++, o += 50) {
    const p = [0, 1, 2].map(k => {
      const v = tris[f * 3 + k] * 3;
      return [positions[v] * scale, positions[v + 1] * scale, positions[v + 2] * scale];
    });
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(o, nx / length, true); view.setFloat32(o + 4, ny / length, true); view.setFloat32(o + 8, nz / length, true);
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) view.setFloat32(o + 12 + k * 12 + c * 4, p[k][c], true);
  }
  return out;
}
