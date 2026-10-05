// Indexed triangle mesh helpers: welding, edge tables and defect counts.
//
// Everything here works on flat typed arrays and open-addressing hash tables. Models of
// a few hundred thousand triangles are common, and building JavaScript Maps of small
// arrays or string keys for every vertex and edge was most of the tool's running time.

const nextPowerOfTwo = value => { let size = 1024; while (size < value) size *= 2; return size; };

/** Join vertices at the same position. `soup` is 9 numbers per triangle. */
export function weld(soup) {
  const count = soup.length / 3;
  // Compare positions by their exact bits. Float32 input is widened first, which is exact.
  const exact = Float64Array.from(soup);
  for (let i = 0; i < exact.length; i++) if (exact[i] === 0) exact[i] = 0; // -0 and 0 are the same place
  const bits = new Uint32Array(exact.buffer);
  const capacity = nextPowerOfTwo(count * 2);
  const mask = capacity - 1;
  const table = new Int32Array(capacity).fill(-1); // slot -> index of the first corner seen at that position
  const idOf = new Int32Array(count);              // corner -> vertex id, for the corners that founded a vertex
  const tris = new Uint32Array(count);
  const positions = new Float64Array(exact.length);
  let vertices = 0;
  for (let i = 0; i < count; i++) {
    const w = i * 6;
    let hash = Math.imul(bits[w] ^ Math.imul(bits[w + 1], 0x9e3779b1), 0x85ebca6b);
    hash = Math.imul(hash ^ bits[w + 2] ^ Math.imul(bits[w + 3], 0xc2b2ae35), 0x27d4eb2f);
    hash = Math.imul(hash ^ bits[w + 4] ^ Math.imul(bits[w + 5], 0x165667b1), 0x9e3779b1);
    let slot = (hash ^ (hash >>> 15)) & mask;
    const x = exact[i * 3], y = exact[i * 3 + 1], z = exact[i * 3 + 2];
    for (;;) {
      const owner = table[slot];
      if (owner < 0) {
        table[slot] = i;
        idOf[i] = vertices;
        positions[vertices * 3] = soup[i * 3]; positions[vertices * 3 + 1] = soup[i * 3 + 1]; positions[vertices * 3 + 2] = soup[i * 3 + 2];
        tris[i] = vertices++;
        break;
      }
      if (exact[owner * 3] === x && exact[owner * 3 + 1] === y && exact[owner * 3 + 2] === z) { tris[i] = idOf[owner]; break; }
      slot = (slot + 1) & mask;
    }
  }
  return { positions: positions.slice(0, vertices * 3), tris };
}

export const edgeKey = (a, b, n) => (a < b ? a * n + b : b * n + a);

/**
 * Every undirected edge of a mesh and the faces that use it.
 *
 * Edges live in numbered slots. `count[slot]` is how many faces use the edge, `first`
 * and `second` are the first two of them, and any more are in `more`. `order` lists
 * the slots in the order the edges were first met, which keeps results repeatable.
 */
export class EdgeTable {
  constructor(tris, dead, faceCount = tris.length / 3) {
    let live = 0;
    for (let f = 0; f < faceCount; f++) if (!dead || !dead[f]) live++;
    this.#allocate(nextPowerOfTwo(live * 3)); // at most 3 edges per face; usually half that
    for (let f = 0; f < faceCount; f++) {
      if (dead && dead[f]) continue;
      const a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2];
      this.#add(a, b, f); this.#add(b, c, f); this.#add(c, a, f);
    }
  }

  #allocate(capacity) {
    this.mask = capacity - 1;
    this.lo = new Int32Array(capacity).fill(-1);
    this.hi = new Int32Array(capacity);
    this.count = new Int32Array(capacity);
    this.first = new Int32Array(capacity);
    this.second = new Int32Array(capacity);
    this.order = new Int32Array(capacity);
    this.size = 0;
    this.more = new Map();
  }

  #slot(lo, hi) {
    const hash = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b);
    let slot = (hash ^ (hash >>> 15)) & this.mask;
    while (this.lo[slot] !== -1 && (this.lo[slot] !== lo || this.hi[slot] !== hi)) slot = (slot + 1) & this.mask;
    return slot;
  }

  #add(a, b, face) {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const slot = this.#slot(lo, hi);
    const used = this.count[slot];
    if (used === 0) { this.lo[slot] = lo; this.hi[slot] = hi; this.first[slot] = face; this.order[this.size++] = slot; }
    else if (used === 1) this.second[slot] = face;
    else { const list = this.more.get(slot); if (list) list.push(face); else this.more.set(slot, [face]); }
    this.count[slot] = used + 1;
  }

  /** The slot of the edge between two vertices, or -1 if no face uses it. */
  find(a, b) {
    const slot = a < b ? this.#slot(a, b) : this.#slot(b, a);
    return this.lo[slot] === -1 ? -1 : slot;
  }

  /** How many faces use the edge between two vertices. */
  uses(a, b) {
    const slot = this.find(a, b);
    return slot < 0 ? 0 : this.count[slot];
  }

  /** All the faces on an edge, as a new array. Meant for the rare edges with three or more. */
  faces(slot) {
    const used = this.count[slot];
    if (used === 1) return [this.first[slot]];
    if (used === 2) return [this.first[slot], this.second[slot]];
    return [this.first[slot], this.second[slot], ...this.more.get(slot)];
  }
}

/**
 * The numbers a slicer complains about, plus shell and winding checks. An edge table
 * already built for these triangles can be passed in to save building another.
 */
export function analyze(positions, tris, edges = new EdgeTable(tris)) {
  const faceCount = tris.length / 3;
  let open = 0, nonManifold = 0, flipped = 0;
  const parent = new Uint32Array(faceCount);
  for (let f = 0; f < faceCount; f++) parent[f] = f;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < edges.size; i++) {
    const slot = edges.order[i], used = edges.count[slot];
    if (used === 1) open++;
    else if (used > 2) nonManifold++;
    else {
      const f = edges.first[slot], g = edges.second[slot];
      parent[find(f)] = find(g);
      if (direction(tris, f, edges.lo[slot], edges.hi[slot]) === direction(tris, g, edges.lo[slot], edges.hi[slot])) flipped++;
    }
  }
  let shells = 0;
  for (let f = 0; f < faceCount; f++) if (find(f) === f) shells++;
  let degenerate = 0, slivers = 0;
  for (let f = 0; f < faceCount; f++) {
    const a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2];
    if (a === b || b === c || c === a) degenerate++;
    else if (isSliver(positions, a, b, c)) slivers++;
  }
  return { vertices: positions.length / 3, triangles: faceCount, openEdges: open, nonManifoldEdges: nonManifold,
           inconsistentEdges: flipped, degenerate, slivers, shells, volume: volume(positions, tris) };
}

/**
 * How many points the surface pinches down to: places where two sheets of surface meet
 * at a single vertex, like the middle of an hourglass or the tip where two cones touch.
 * Every edge there can still have exactly two faces, so an edge check sees nothing.
 * Counted on a mesh whose edges are otherwise sound; rims and over-shared edges are skipped.
 */
export function pinchedPoints(positions, tris, edges = new EdgeTable(tris)) {
  const corners = tris.length;
  const parent = new Uint32Array(corners);
  for (let i = 0; i < corners; i++) parent[i] = i;
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const cornerOf = (f, v) => (tris[f * 3] === v ? f * 3 : tris[f * 3 + 1] === v ? f * 3 + 1 : f * 3 + 2);
  const skip = new Uint8Array(positions.length / 3); // vertices on a rim or an over-shared edge
  for (let i = 0; i < edges.size; i++) {
    const slot = edges.order[i], a = edges.lo[slot], b = edges.hi[slot];
    if (edges.count[slot] !== 2) { skip[a] = 1; skip[b] = 1; continue; }
    const f = edges.first[slot], g = edges.second[slot];
    parent[find(cornerOf(f, a))] = find(cornerOf(g, a));
    parent[find(cornerOf(f, b))] = find(cornerOf(g, b));
  }
  // Around an ordinary vertex all the faces join into one fan. More than one fan is a pinch.
  const fans = new Uint8Array(positions.length / 3);
  let pinched = 0;
  for (let i = 0; i < corners; i++) {
    if (find(i) !== i) continue;
    const v = tris[i];
    if (skip[v]) continue;
    if (fans[v] === 1) pinched++;
    if (fans[v] < 2) fans[v]++;
  }
  return pinched;
}

/**
 * Is this triangle squashed flat: three different corners that lie along one line, so it
 * has length but no area? "Flat" means thinner than a ten-millionth of its own length,
 * which is the limit of what an STL file's numbers can express.
 */
export function isSliver(positions, a, b, c) {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
  const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
  const wx = vx - ux, wy = vy - uy, wz = vz - uz;
  const longest = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  // (twice the area) squared, against (longest side) to the fourth: the square of height / length
  return nx * nx + ny * ny + nz * nz <= 1e-14 * longest * longest;
}

/** +1 when face f runs a→b, -1 when it runs b→a. */
export function direction(tris, f, a, b) {
  for (let k = 0; k < 3; k++) {
    if (tris[f * 3 + k] === a && tris[f * 3 + (k + 1) % 3] === b) return 1;
  }
  return -1;
}

export function volume(positions, tris) {
  let sum = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    sum += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
         - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
         + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return sum / 6;
}
