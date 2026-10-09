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
 *
 * `pose` picks a moment of one of the file's animation clips, `{ clip, time }` with the
 * time in seconds, and the shape is read as it stands then. Without it the shape is read
 * as it is stored, which is its rest pose.
 */
export function parseGLB(buffer, options = {}) {
  return openGLB(buffer, options).bake(options.pose ?? null);
}

/**
 * Read a GLB file's scene once, so that it can be shaped into several poses without being
 * read again: `clips` lists its animation clips, and `bake(pose)` gives the triangles for
 * one moment of one of them (or for the rest pose, with no pose).
 */
export function openGLB(buffer, { maxTriangles = Infinity, tooMany = total => new Error(`Too many triangles (${total})`), notes = [], draco = new Map() } = {}) {
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
  // In the rest pose none of them is applied: the shape is read as it is stored. The
  // caller is told, so that the page can say which pose was repaired and offer the others.
  const some = list => Array.isArray(list) && list.length > 0;
  if (some(json.skins) || (json.nodes || []).some(node => node && node.skin !== undefined)) notes.push('rigged');
  if (some(json.animations)) notes.push('animated');
  if ((json.meshes || []).some(mesh => (mesh?.primitives || []).some(primitive => some(primitive?.targets)))) notes.push('morphs');

  const data = bin ? new DataView(bin.buffer, bin.byteOffset, bin.byteLength) : null;
  const GETTERS = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
  // Where one run of numbers lies in the binary chunk, checked against its edges.
  const locate = (bufferViewIndex, byteOffset, total, size, width) => {
    const bufferView = json.bufferViews?.[bufferViewIndex];
    if (!bufferView || (bufferView.buffer || 0) !== 0 || !bin || json.buffers?.[0]?.uri) throw new Error('Only GLB files with their data embedded are supported');
    const viewStart = count(bufferView.byteOffset || 0, 'data position'), viewLength = count(bufferView.byteLength ?? 0, 'data length');
    const start = viewStart + count(byteOffset || 0, 'data position');
    const stride = count(bufferView.byteStride || size * width, 'data spacing');
    if (stride < size * width) throw new Error('GLB geometry data overlaps itself');
    const end = total ? start + stride * (total - 1) + size * width : start;
    if (end > viewStart + viewLength || end > bin.byteLength) throw new Error('GLB geometry data runs past the end of the file');
    return { start, stride };
  };
  const read = index => {
    const accessor = json.accessors?.[index];
    if (!accessor) throw new Error('GLB file refers to missing geometry data');
    const [Type, size, max] = COMPONENTS[accessor.componentType] || [];
    const width = WIDTHS[accessor.type];
    if (!Type || !width) throw new Error('GLB file uses an unknown data type');
    // Check every size the file claims before setting memory aside for it.
    const total = count(accessor.count, 'number of points');
    if (total > maxPoints) throw tooMany(Math.ceil(total / 3));
    const out = new Float64Array(total * width);
    const scale = raw => accessor.normalized ? Math.max(raw / max, -1) : raw;
    if (accessor.bufferView !== undefined) {
      const { start, stride } = locate(accessor.bufferView, accessor.byteOffset, total, size, width);
      const get = GETTERS[accessor.componentType];
      for (let i = 0; i < total; i++) {
        for (let k = 0; k < width; k++) out[i * width + k] = scale(data[get](start + i * stride + k * size, true));
      }
    }
    // A sparse accessor lists only the entries that differ from its base (or from zero),
    // which is how blend shapes that move a few points are usually stored.
    if (accessor.sparse) {
      const sparse = accessor.sparse;
      const changed = count(sparse.count, 'number of changed points');
      if (changed > total) throw new Error('This GLB file changes more points than it has.');
      if (!INDEX_TYPES.has(sparse.indices?.componentType)) throw new Error('GLB triangle lists must be whole numbers');
      const indexSize = COMPONENTS[sparse.indices.componentType][1];
      const at = locate(sparse.indices.bufferView, sparse.indices.byteOffset, changed, indexSize, 1);
      const values = locate(sparse.values?.bufferView, sparse.values?.byteOffset, changed, size, width);
      const getIndex = GETTERS[sparse.indices.componentType], get = GETTERS[accessor.componentType];
      for (let i = 0; i < changed; i++) {
        const target = data[getIndex](at.start + i * indexSize, true);
        if (target >= total) throw new Error('GLB file refers to a vertex that does not exist');
        for (let k = 0; k < width; k++) out[target * width + k] = scale(data[get](values.start + i * size * width + k * size, true));
      }
    }
    return { values: out, width, type: accessor.componentType };
  };
  // The same data is often used several times (one mesh on several nodes); read it once.
  const cache = new Map();
  const readOnce = index => { if (!cache.has(index)) cache.set(index, read(index)); return cache.get(index); };

  // The animation clips, for a pose to be chosen from: their names, how long each runs,
  // and the moments where something in it was set by hand (its keyframes).
  const clips = (json.animations || []).map((animation, index) => {
    const times = new Set();
    let duration = 0;
    for (const channel of animation?.channels || []) {
      const sampler = animation.samplers?.[channel?.sampler];
      if (!sampler || channel.target?.node === undefined) continue;
      let input;
      try { input = readOnce(sampler.input).values; } catch { continue; }
      for (const time of input) if (Number.isFinite(time) && time >= 0) { times.add(time); if (time > duration) duration = time; }
    }
    const keys = [...times].sort((a, b) => a - b);
    return { index, name: typeof animation?.name === 'string' && animation.name.trim() ? animation.name.trim().slice(0, 80) : `Clip ${index + 1}`, duration, keys: keys.length > 2000 ? keys.filter((_, i) => i % Math.ceil(keys.length / 2000) === 0) : keys };
  });
  // Exported clips are often named for their skeleton too ("CharacterArmature|Wave"); the
  // short name ("Wave") is shown wherever it is still unique within the file.
  const short = clip => clip.name.split('|').pop().trim() || clip.name;
  for (const clip of clips) clip.label = clips.filter(other => short(other) === short(clip)).length === 1 ? short(clip) : clip.name;

  const bake = (pose = null) => {
    const soup = [];
    const needsDraco = [];
    let emitted = 0;
    // In a pose, the nodes the clip moves get its translation, rotation, scale and blend
    // shape weights at that moment; every other node keeps its own.
    const moved = pose ? sampleClip(json, readOnce, pose) : null;
    const local = (index, node) => {
      const change = moved?.get(index);
      if (!change || (!change.translation && !change.rotation && !change.scale)) return localMatrix(node);
      const [translation, rotation, scale] = ['translation', 'rotation', 'scale'].map(key => change[key] || node[key]);
      return localMatrix({ translation, rotation, scale });
    };
    // Where each node is in the scene, for a skeleton's bones, which can sit anywhere in it.
    const parents = new Map();
    (json.nodes || []).forEach((node, index) => { for (const child of Array.isArray(node?.children) ? node.children : []) if (!parents.has(child)) parents.set(child, index); });
    const placed = new Map();
    const place = (index, depth = 0) => {
      if (placed.has(index)) return placed.get(index);
      const node = json.nodes?.[index];
      if (!node || depth > 64) throw new Error('This GLB file has a skeleton that loops back on itself or is nested too deeply to read.');
      const matrix = parents.has(index) ? multiply(place(parents.get(index), depth + 1), local(index, node)) : local(index, node);
      placed.set(index, matrix);
      return matrix;
    };

    const emit = (meshIndex, matrix, nodeIndex) => {
      const node = json.nodes?.[nodeIndex];
      const skin = pose && node?.skin !== undefined ? json.skins?.[node.skin] : null;
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
            needsDraco.push({ key, bytes: bin.subarray(start, start + length), attribute: packed.attributes.POSITION, extra: packedExtras(packed) });
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
        // In a pose, blend shapes and then the skeleton move each point; the result is
        // already in the scene's space, so the node's own placement is not applied again.
        let m = matrix, mirrored = determinant(matrix) < 0;
        if (pose) {
          const shaped = shapePoints(json, readOnce, { primitive, meshIndex, node, nodeIndex, skin, positions: p, points, moved, place, extras: packed ? draco.get(`${meshIndex}:${primitiveIndex}`)?.extras : null });
          if (shaped) { p = shaped.positions; if (shaped.skinned) { m = IDENTITY; mirrored = shaped.mirrored; } }
        }
        const corner = i => {
          const v = order[i];
          if (!(v >= 0 && v < points)) throw new Error('GLB file refers to a vertex that does not exist');
          const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
          soup.push(m[0] * x + m[4] * y + m[8] * z + m[12],
                    m[1] * x + m[5] * y + m[9] * z + m[13],
                    m[2] * x + m[6] * y + m[10] * z + m[14]);
        };
        // A mirrored node turns its triangles inside out, so reverse them.
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
      const matrix = multiply(parent, local(index, node));
      if (node.mesh !== undefined) emit(node.mesh, matrix, index);
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
  };

  return { clips, bake };
}

/** The ids Draco gave a compressed primitive's bone links and weights, if it has any. */
function packedExtras(packed) {
  const extra = {};
  for (const name of ['JOINTS_0', 'WEIGHTS_0', 'JOINTS_1', 'WEIGHTS_1']) if (Number.isSafeInteger(packed.attributes?.[name])) extra[name] = packed.attributes[name];
  return extra;
}

/**
 * What each node of the scene looks like at one moment of one clip: a map from node to
 * its `translation`, `rotation`, `scale` and blend shape `weights` then. A time before
 * the clip starts or after it ends holds its first or last value.
 */
export function sampleClip(json, readOnce, { clip, time }) {
  const animation = json.animations?.[clip];
  if (!animation) throw new Error('This GLB file has no such animation.');
  const moved = new Map();
  for (const channel of animation.channels || []) {
    const node = channel?.target?.node, path = channel?.target?.path;
    const sampler = animation.samplers?.[channel?.sampler];
    if (node === undefined || !sampler || !['translation', 'rotation', 'scale', 'weights'].includes(path)) continue;
    const input = readOnce(sampler.input).values;
    const { values: output } = readOnce(sampler.output);
    const keys = input.length;
    if (!keys) continue;
    const cubic = sampler.interpolation === 'CUBICSPLINE';
    // How many numbers make one value: 3 for a position, 4 for a rotation, one per blend shape.
    const width = Math.floor(output.length / keys / (cubic ? 3 : 1));
    if (!width || (path !== 'weights' && width !== (path === 'rotation' ? 4 : 3))) continue;
    const value = k => { const at = (cubic ? k * 3 + 1 : k) * width; return Array.from(output.subarray(at, at + width)); };
    let result;
    if (!(time > input[0])) result = value(0);
    else if (time >= input[keys - 1]) result = value(keys - 1);
    else {
      let k = 0;
      while (k + 1 < keys && input[k + 1] <= time) k++;
      const t0 = input[k], t1 = input[k + 1], span = t1 - t0;
      const s = span > 0 ? (time - t0) / span : 0;
      if (sampler.interpolation === 'STEP') result = value(k);
      else if (cubic) {
        // Hermite curve through the two keyframes, with the tangents stored beside them.
        const a = value(k), b = value(k + 1);
        const out = Array.from(output.subarray(k * 3 * width + 2 * width, k * 3 * width + 3 * width));
        const into = Array.from(output.subarray((k + 1) * 3 * width, (k + 1) * 3 * width + width));
        const s2 = s * s, s3 = s2 * s;
        result = a.map((_, i) => (2 * s3 - 3 * s2 + 1) * a[i] + (s3 - 2 * s2 + s) * span * out[i] + (-2 * s3 + 3 * s2) * b[i] + (s3 - s2) * span * into[i]);
      } else if (path === 'rotation') result = slerp(value(k), value(k + 1), s);
      else { const a = value(k), b = value(k + 1); result = a.map((_, i) => a[i] + (b[i] - a[i]) * s); }
    }
    if (path === 'rotation') { const length = Math.hypot(...result) || 1; result = result.map(c => c / length); }
    if (!moved.has(node)) moved.set(node, {});
    moved.get(node)[path] = result;
  }
  return moved;
}

/**
 * One primitive's points in a pose: its blend shapes at their weights, then its skeleton.
 * Returns the moved points and the placement still to apply to them, or null when
 * nothing about the pose changes this primitive.
 */
function shapePoints(json, readOnce, { primitive, meshIndex, node, nodeIndex, skin, positions, points, moved, place, extras }) {
  let p = positions;
  // Blend shapes: the clip's weights for this node, or else the node's or the mesh's own.
  const targets = Array.isArray(primitive.targets) ? primitive.targets : [];
  const weights = moved?.get(nodeIndex)?.weights || node?.weights || json.meshes?.[meshIndex]?.weights || [];
  if (targets.some((target, i) => weights[i] && target?.POSITION !== undefined)) {
    p = Float64Array.from(positions);
    targets.forEach((target, i) => {
      const weight = weights[i];
      if (!weight || target?.POSITION === undefined) return;
      const { values: delta, width } = readOnce(target.POSITION);
      if (width !== 3 || delta.length !== p.length) throw new Error('A blend shape in this GLB file does not match its mesh.');
      for (let j = 0; j < p.length; j++) p[j] += weight * delta[j];
    });
  }
  const attribute = name => extras?.[name] || (primitive.attributes?.[name] !== undefined ? readOnce(primitive.attributes[name]).values : null);
  const joints0 = skin ? attribute('JOINTS_0') : null, weights0 = skin ? attribute('WEIGHTS_0') : null;
  if (!skin || !joints0 || !weights0) return p === positions ? null : { positions: p, skinned: false };
  // Skinning: each point follows the bones it is tied to, in proportion to its weights.
  const bones = Array.isArray(skin.joints) ? skin.joints : [];
  const inverse = skin.inverseBindMatrices !== undefined ? readOnce(skin.inverseBindMatrices).values : null;
  if (inverse && inverse.length < bones.length * 16) throw new Error('This GLB file has a skeleton with missing bind data.');
  const boneMatrices = bones.map((bone, i) => multiply(place(bone), inverse ? Array.from(inverse.subarray(i * 16, i * 16 + 16)) : IDENTITY));
  const sets = [[joints0, weights0], [attribute('JOINTS_1'), attribute('WEIGHTS_1')]].filter(([j, w]) => j && w);
  for (const [j, w] of sets) if (j.length < points * 4 || w.length < points * 4) throw new Error('This GLB file has a skeleton that does not cover every point.');
  const out = new Float64Array(points * 3);
  let flipped = 0;
  for (let v = 0; v < points; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    let sum = 0, ox = 0, oy = 0, oz = 0, det = 0;
    for (const [j, w] of sets) for (let k = 0; k < 4; k++) {
      const weight = w[v * 4 + k];
      if (!(weight > 0)) continue;
      const m = boneMatrices[j[v * 4 + k]];
      if (!m) throw new Error('This GLB file ties a point to a bone it does not have.');
      sum += weight;
      ox += weight * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += weight * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += weight * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      det += weight * Math.sign(determinant(m));
    }
    if (sum > 0) { out[v * 3] = ox / sum; out[v * 3 + 1] = oy / sum; out[v * 3 + 2] = oz / sum; }
    else { const m = place(nodeIndex); out[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]; }
    if (det < 0) flipped++;
  }
  // A skeleton that mirrors most of the model turns its triangles inside out, as a mirrored node does.
  return { positions: out, skinned: true, mirrored: flipped > points / 2 };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function slerp(a, b, s) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) { b = b.map(c => -c); dot = -dot; }
  if (dot > 0.9995) return a.map((c, i) => c + (b[i] - c) * s);
  const angle = Math.acos(dot), sin = Math.sin(angle);
  const wa = Math.sin((1 - s) * angle) / sin, wb = Math.sin(s * angle) / sin;
  return a.map((c, i) => wa * c + wb * b[i]);
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
