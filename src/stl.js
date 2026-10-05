// Binary and ASCII STL reading, binary STL writing. No dependencies.

export function parseSTL(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // A text STL starts with "solid" and soon says "facet". Some binary files also start
  // with "solid" in their free-text header, so both signs are needed to call it text.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
  const text = /^\s*solid/.test(head) && (/facet|endsolid/.test(head) || bytes.byteLength < 84);
  if (!text && bytes.byteLength >= 84) {
    const count = view.getUint32(80, true);
    // Exactly the right length is normal; a few exporters add bytes after the triangles.
    if (count > 0 && 84 + count * 50 <= bytes.byteLength) {
      const soup = new Float32Array(count * 9);
      for (let f = 0, o = 84; f < count; f++, o += 50) {
        for (let k = 0; k < 9; k++) soup[f * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
      }
      return soup;
    }
  }
  if (!text) throw new Error('This does not look like an STL file.');
  const values = [];
  const pattern = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const body = new TextDecoder().decode(bytes);
  for (let m; (m = pattern.exec(body));) values.push(+m[1], +m[2], +m[3]);
  if (values.length === 0 || values.length % 9) throw new Error('This text STL file has incomplete triangles.');
  return Float32Array.from(values);
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
