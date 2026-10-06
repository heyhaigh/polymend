// Read triangle geometry from a binary glTF (.glb) file. No dependencies.
//
// Returns the same "triangle soup" as the STL reader: nine numbers per triangle, with
// every node's position, rotation and scale applied. Materials and textures are ignored;
// only the shape is needed for printing. Skeletons, animation and blend shapes are not
// applied either: the model is read in the pose it is stored in, and `notes` says so.

const COMPONENTS = {
  5120: [Int8Array, 1, 127], 5121: [Uint8Array, 1, 255], 5122: [Int16Array, 2, 32767],
  5123: [Uint16Array, 2, 65535], 5125: [Uint32Array, 4, 4294967295], 5126: [Float32Array, 4, 1],
};
const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const UNSUPPORTED = { EXT_meshopt_compression: 'meshopt-compressed' };
const DRACO = 'KHR_draco_mesh_compression';
// The most compressed geometry one primitive may hold. Draco packs a mesh ten to twenty
// times smaller, so this still allows far more than the page will accept once unpacked.
const MAX_PACKED = 64 * 1024 * 1024;
// Extensions a file may insist on that do not change its shape, so they are safe to ignore.
// Draco compression is handled, not ignored: see `draco` below.
const HARMLESS = /^(KHR_materials_|KHR_texture_|KHR_lights_|KHR_mesh_quantization$|KHR_xmp|EXT_texture_|KHR_animation_pointer$|KHR_draco_mesh_compression$)/;
const INDEX_TYPES = new Set([5121, 5123, 5125]);

const count = (value, what) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`This GLB file gives an impossible ${what}.`);
  return value;
};

/**
 * `maxTriangles` is enforced while reading, before memory is set aside: every size in a
 * GLB is the file's own claim, and a small file can claim to hold billions of points or
 * list one mesh a million times over.
 *
 * Draco-compressed primitives need a decoder, which is slow to load and asynchronous, so
 * this reader stays simple: `draco` maps "mesh:primitive" to geometry already unpacked.
 * On meeting a compressed primitive that is not in the map it stops and throws an error
 * carrying `needsDraco`, a list of what to unpack; the caller unpacks and reads again.
 */
export function parseGLB(buffer, { maxTriangles = Infinity, tooMany = total => new Error(`Too many triangles (${total})`), notes = [], draco = new Map() } = {}) {
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
    // Anything else the file says it cannot be read without might change its shape.
    if (!HARMLESS.test(String(name))) throw new Error(`This GLB file needs "${String(name).slice(0, 60)}", which this page does not understand.`);
  }
  const maxPoints = maxTriangles * 3;
  // A model can carry a skeleton, animation clips or blend shapes that move its surface.
  // None of them is applied: the shape is read as it is stored, which is its rest pose.
  // The caller is told, so that the page can say which pose was repaired.
  const some = list => Array.isArray(list) && list.length > 0;
  if (some(json.skins) || (json.nodes || []).some(node => node && node.skin !== undefined)) notes.push('rigged');
  if (some(json.animations)) notes.push('animated');
  if ((json.meshes || []).some(mesh => (mesh?.primitives || []).some(primitive => some(primitive?.targets)))) notes.push('morphs');

  const read = index => {
    const accessor = json.accessors?.[index];
    if (!accessor) throw new Error('GLB file refers to missing geometry data');
    if (accessor.sparse) throw new Error('Sparse geometry data is not supported');
    const [Type, size, max] = COMPONENTS[accessor.componentType] || [];
    const width = WIDTHS[accessor.type];
    if (!Type || !width) throw new Error('GLB file uses an unknown data type');
    // Check every size the file claims before setting memory aside for it.
    const total = count(accessor.count, 'number of points');
    if (total > maxPoints) throw tooMany(Math.ceil(total / 3));
    if (accessor.bufferView === undefined) return { values: new Float64Array(total * width), width, type: accessor.componentType };
    const bufferView = json.bufferViews?.[accessor.bufferView];
    if (!bufferView || (bufferView.buffer || 0) !== 0 || !bin || json.buffers?.[0]?.uri) throw new Error('Only GLB files with their data embedded are supported');
    const viewStart = count(bufferView.byteOffset || 0, 'data position'), viewLength = count(bufferView.byteLength ?? 0, 'data length');
    const start = viewStart + count(accessor.byteOffset || 0, 'data position');
    const stride = count(bufferView.byteStride || size * width, 'data spacing');
    if (stride < size * width) throw new Error('GLB geometry data overlaps itself');
    const end = total ? start + stride * (total - 1) + size * width : start;
    if (end > viewStart + viewLength || end > bin.byteLength) throw new Error('GLB geometry data runs past the end of the file');
    const out = new Float64Array(total * width);
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[accessor.componentType];
    for (let i = 0; i < total; i++) {
      for (let k = 0; k < width; k++) {
        const raw = data[get](start + i * stride + k * size, true);
        out[i * width + k] = accessor.normalized ? Math.max(raw / max, -1) : raw;
      }
    }
    return { values: out, width, type: accessor.componentType };
  };

  const soup = [];
  const needsDraco = [];
  let emitted = 0;
  // The same mesh is often used by several nodes; read its data once.
  const cache = new Map();
  const readOnce = index => { if (!cache.has(index)) cache.set(index, read(index)); return cache.get(index); };
  const emit = (meshIndex, matrix) => {
    (json.meshes?.[meshIndex]?.primitives || []).forEach((primitive, primitiveIndex) => {
      const mode = primitive.mode ?? 4;
      if (mode < 4) return; // points and lines have no surface
      if (primitive.extensions && Object.keys(primitive.extensions).some(name => UNSUPPORTED[name])) throw new Error('This file uses meshopt-compressed geometry, which is not supported yet. Re-export it without compression.');
      if (primitive.attributes?.POSITION === undefined) return;
      let p, width, order;
      const packed = primitive.extensions?.[DRACO];
      if (packed) {
        const key = `${meshIndex}:${primitiveIndex}`;
        const unpacked = draco.get(key);
        if (!unpacked) {
          const bufferView = json.bufferViews?.[packed.bufferView];
          if (!bufferView || (bufferView.buffer || 0) !== 0 || !bin) throw new Error('Only GLB files with their data embedded are supported');
          const start = count(bufferView.byteOffset || 0, 'data position'), length = count(bufferView.byteLength ?? 0, 'data length');
          if (start + length > bin.byteLength) throw new Error('GLB geometry data runs past the end of the file');
          if (length > MAX_PACKED) throw new Error('The compressed geometry in this GLB file is larger than this page can unpack.');
          if (!Number.isSafeInteger(packed.attributes?.POSITION)) throw new Error('The compressed geometry in this GLB file has no positions.');
          needsDraco.push({ key, bytes: bin.subarray(start, start + length), attribute: packed.attributes.POSITION });
          return;
        }
        p = unpacked.positions; width = 3; order = unpacked.indices;
      } else {
        ({ values: p, width } = readOnce(primitive.attributes.POSITION));
        if (width !== 3) throw new Error('GLB vertex positions must have three coordinates');
        if (primitive.indices !== undefined) {
          const indices = readOnce(primitive.indices);
          if (indices.width !== 1 || !INDEX_TYPES.has(indices.type)) throw new Error('GLB triangle lists must be whole numbers');
          order = indices.values;
        } else {
          order = Float64Array.from({ length: p.length / 3 }, (_, i) => i);
        }
      }
      const points = p.length / 3;
      // Stop before building more triangles than the page will accept.
      emitted += mode === 4 ? Math.floor(order.length / 3) : Math.max(0, order.length - 2);
      if (emitted > maxTriangles) throw tooMany(emitted);
      const corner = i => {
        const v = order[i];
        if (!(v >= 0 && v < points)) throw new Error('GLB file refers to a vertex that does not exist');
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
    });
  };

  // A scene is a tree. A file whose nodes loop back on themselves, or that lists a node
  // thousands of times, is refused rather than followed.
  const path = new Set();
  let visits = 0;
  const visit = (index, parent) => {
    const node = json.nodes?.[index];
    if (!node) return;
    if (path.has(index) || path.size > 64 || ++visits > 100_000) throw new Error('This GLB file has a scene that loops back on itself or is nested too deeply to read.');
    path.add(index);
    const matrix = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) emit(node.mesh, matrix);
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, matrix);
    path.delete(index);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) for (const root of Array.isArray(scene.nodes) ? scene.nodes : []) visit(root, identity);
  else (json.meshes || []).forEach((_, index) => emit(index, identity));
  if (needsDraco.length) throw Object.assign(new Error('This GLB file holds Draco-compressed geometry, which needs unpacking first.'), { needsDraco });
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
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
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
