// Find places where the surface passes through itself.
//
// Two triangles are counted when an edge of one pierces the inside of the other.
// Triangles that share a corner are skipped (neighbours always touch), and contact
// exactly along an edge or at a corner is not counted, so the count is conservative.

export function selfIntersections(positions, tris) {
  const faceCount = tris.length / 3;
  const flagged = new Uint8Array(faceCount);
  if (faceCount < 2) return { pairs: 0, flagged };
  const lo = new Float64Array(faceCount * 3), hi = new Float64Array(faceCount * 3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let sizeSum = 0;
  for (let f = 0; f < faceCount; f++) {
    for (let c = 0; c < 3; c++) {
      const a = positions[tris[f * 3] * 3 + c], b = positions[tris[f * 3 + 1] * 3 + c], d = positions[tris[f * 3 + 2] * 3 + c];
      const low = Math.min(a, b, d), high = Math.max(a, b, d);
      lo[f * 3 + c] = low; hi[f * 3 + c] = high;
      if (low < min[c]) min[c] = low;
      if (high > max[c]) max[c] = high;
      sizeSum += high - low;
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const cell = Math.max((sizeSum / (faceCount * 3)) * 2, diagonal / 1024);
  const dims = [0, 1, 2].map(c => Math.max(1, Math.ceil((max[c] - min[c]) / cell) + 1));
  const cellOf = (value, c) => Math.min(dims[c] - 1, Math.max(0, Math.floor((value - min[c]) / cell)));
  const grid = new Map();
  for (let f = 0; f < faceCount; f++) {
    const x0 = cellOf(lo[f * 3], 0), x1 = cellOf(hi[f * 3], 0);
    const y0 = cellOf(lo[f * 3 + 1], 1), y1 = cellOf(hi[f * 3 + 1], 1);
    const z0 = cellOf(lo[f * 3 + 2], 2), z1 = cellOf(hi[f * 3 + 2], 2);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const key = (x * dims[1] + y) * dims[2] + z;
      const list = grid.get(key);
      if (list) list.push(f); else grid.set(key, [f]);
    }
  }
  const point = v => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
  let pairs = 0;
  for (const [key, list] of grid) {
    if (list.length < 2) continue;
    const z = key % dims[2], y = Math.floor(key / dims[2]) % dims[1], x = Math.floor(key / (dims[1] * dims[2]));
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const fa = tris[f * 3], fb = tris[f * 3 + 1], fc = tris[f * 3 + 2];
      for (let j = i + 1; j < list.length; j++) {
        const g = list[j];
        const ga = tris[g * 3], gb = tris[g * 3 + 1], gc = tris[g * 3 + 2];
        if (fa === ga || fa === gb || fa === gc || fb === ga || fb === gb || fb === gc || fc === ga || fc === gb || fc === gc) continue;
        // Boxes must overlap, and each pair is examined only in the cell holding the overlap's low corner.
        const ox = Math.max(lo[f * 3], lo[g * 3]), oy = Math.max(lo[f * 3 + 1], lo[g * 3 + 1]), oz = Math.max(lo[f * 3 + 2], lo[g * 3 + 2]);
        if (ox > Math.min(hi[f * 3], hi[g * 3]) || oy > Math.min(hi[f * 3 + 1], hi[g * 3 + 1]) || oz > Math.min(hi[f * 3 + 2], hi[g * 3 + 2])) continue;
        if (cellOf(ox, 0) !== x || cellOf(oy, 1) !== y || cellOf(oz, 2) !== z) continue;
        const A = [point(fa), point(fb), point(fc)], B = [point(ga), point(gb), point(gc)];
        if (trianglesCross(A, B)) { pairs++; flagged[f] = 1; flagged[g] = 1; }
      }
    }
  }
  return { pairs, flagged };
}

const EPSILON = 1e-9;

/** Does the segment p→q pass through the inside of triangle abc? */
function pierces(p, q, a, b, c) {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const px = d[1] * e2[2] - d[2] * e2[1], py = d[2] * e2[0] - d[0] * e2[2], pz = d[0] * e2[1] - d[1] * e2[0];
  const det = e1[0] * px + e1[1] * py + e1[2] * pz;
  if (Math.abs(det) < 1e-30) return false;
  const tx = p[0] - a[0], ty = p[1] - a[1], tz = p[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) / det;
  if (u <= EPSILON || u >= 1 - EPSILON) return false;
  const qx = ty * e1[2] - tz * e1[1], qy = tz * e1[0] - tx * e1[2], qz = tx * e1[1] - ty * e1[0];
  const w = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
  if (w <= EPSILON || u + w >= 1 - EPSILON) return false;
  const t = (e2[0] * qx + e2[1] * qy + e2[2] * qz) / det;
  return t > EPSILON && t < 1 - EPSILON;
}

/** Do two triangles, each given as three points, pass through each other? */
export function trianglesCross(A, B) {
  for (let k = 0; k < 3; k++) {
    if (pierces(A[k], A[(k + 1) % 3], B[0], B[1], B[2]) || pierces(B[k], B[(k + 1) % 3], A[0], A[1], A[2])) return true;
  }
  return false;
}
