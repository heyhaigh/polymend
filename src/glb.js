// Read triangle geometry from a binary glTF (.glb) file. No dependencies.
//
// Returns the same "triangle soup" as the STL reader: nine numbers per triangle, with
// every node's position, rotation and scale applied. Materials, textures, skins and
// animation are ignored; only the shape is needed for printing.

const COMPONENTS = {
  5120: [Int8Array, 1, 127], 5121: [Uint8Array, 1, 255], 5122: [Int16Array, 2, 32767],
  5123: [Uint16Array, 2, 65535], 5125: [Uint32Array, 4, 4294967295], 5126: [Float32Array, 4, 1],
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const UNSUPPORTED = { KHR_draco_mesh_compression: 'Draco-compressed', EXT_meshopt_compression: 'meshopt-compressed' };

export function parseGLB(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('This does not look like a GLB file.');
  if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 files are supported.');
  let json = null, bin = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const length = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (chunk.byteLength !== length) throw new Error('This GLB file is cut short.');
    if (kind === 0x4e4f534a && !json) json = JSON.parse(new TextDecoder().decode(chunk).replace(/\0+$/, ''));
    else if (kind === 0x004e4942 && !bin) bin = chunk;
    offset += 8 + length + (length % 4 ? 4 - (length % 4) : 0);
  }
  if (!json) throw new Error('This GLB file has no scene description.');
  for (const name of json.extensionsRequired || []) {
    if (UNSUPPORTED[name]) throw new Error(`This file is ${UNSUPPORTED[name]}, which is not supported yet. Re-export it without compression.`);
  }

  const read = index => {
    const accessor = json.accessors?.[index];
    if (!accessor) throw new Error('GLB file refers to missing geometry data');
    if (accessor.sparse) throw new Error('Sparse geometry data is not supported');
    const [Type, size, max] = COMPONENTS[accessor.componentType] || [];
    const width = WIDTHS[accessor.type];
    if (!Type || !width) throw new Error('GLB file uses an unknown data type');
    const out = new Float64Array(accessor.count * width);
    if (accessor.bufferView === undefined) return { values: out, width };
    const bufferView = json.bufferViews?.[accessor.bufferView];
    if (!bufferView || (bufferView.buffer || 0) !== 0 || !bin || json.buffers?.[0]?.uri) throw new Error('Only GLB files with their data embedded are supported');
    const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = bufferView.byteStride || size * width;
    if (start + stride * (accessor.count - 1) + size * width > bin.byteLength) throw new Error('GLB geometry data runs past the end of the file');
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[accessor.componentType];
    for (let i = 0; i < accessor.count; i++) {
      for (let k = 0; k < width; k++) {
        const raw = data[get](start + i * stride + k * size, true);
        out[i * width + k] = accessor.normalized ? Math.max(raw / max, -1) : raw;
      }
    }
    return { values: out, width };
  };

  const soup = [];
  const emit = (meshIndex, matrix) => {
    for (const primitive of json.meshes?.[meshIndex]?.primitives || []) {
      const mode = primitive.mode ?? 4;
      if (mode < 4) continue; // points and lines have no surface
      if (primitive.extensions && Object.keys(primitive.extensions).some(name => UNSUPPORTED[name])) throw new Error('This file uses compressed geometry, which is not supported yet. Re-export it without compression.');
      if (primitive.attributes?.POSITION === undefined) continue;
      const { values: p, width } = read(primitive.attributes.POSITION);
      if (width !== 3) throw new Error('GLB vertex positions must have three coordinates');
      const count = p.length / 3;
      const order = primitive.indices !== undefined ? read(primitive.indices).values : Float64Array.from({ length: count }, (_, i) => i);
      const corner = i => {
        const v = order[i];
        if (!(v >= 0 && v < count)) throw new Error('GLB file refers to a vertex that does not exist');
        const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
        soup.push(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                  matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                  matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);
      };
      // A mirrored node turns its triangles inside out, so reverse them.
      const mirrored = determinant(matrix) < 0;
      const triangle = (a, b, c) => { if (mirrored) { corner(a); corner(c); corner(b); } else { corner(a); corner(b); corner(c); } };
      if (mode === 4) for (let i = 0; i + 2 < order.length; i += 3) triangle(i, i + 1, i + 2);
      else if (mode === 5) for (let i = 0; i + 2 < order.length; i++) (i % 2 ? triangle(i + 1, i, i + 2) : triangle(i, i + 1, i + 2));
      else if (mode === 6) for (let i = 1; i + 1 < order.length; i++) triangle(0, i, i + 1);
    }
  };

  const visit = (index, parent, depth) => {
    const node = json.nodes?.[index];
    if (!node || depth > 64) return;
    const matrix = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) emit(node.mesh, matrix);
    for (const child of node.children || []) visit(child, matrix, depth + 1);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) for (const root of scene.nodes || []) visit(root, identity, 0);
  else (json.meshes || []).forEach((_, index) => emit(index, identity));
  if (!soup.length) throw new Error('No triangles were found in this GLB file.');
  return Float64Array.from(soup);
}

/** glTF is Y-up; slicers expect Z-up. Rotates the soup in place and returns it. */
export function yUpToZUp(soup) {
  for (let i = 0; i < soup.length; i += 3) {
    const y = soup[i + 1];
    soup[i + 1] = -soup[i + 2];
    soup[i + 2] = y;
  }
  return soup;
}

function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
  }
  return out;
}

function determinant(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}
