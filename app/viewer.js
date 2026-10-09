// A small WebGL2 model viewer: orbit, zoom, pan, and coloured overlays for what the
// repair changed. No libraries, so the page loads nothing from anyone else.

const VERTEX = `#version 300 es
uniform mat4 uMatrix;
uniform float uPointSize;
uniform vec3 uEye;
uniform float uLift; // markers are nudged toward the viewer so a marker on the near surface is not hidden by it
in vec3 aPosition;
out vec3 vWorld;
void main() {
  vWorld = aPosition;
  vec3 position = aPosition + normalize(uEye - aPosition) * uLift;
  gl_Position = uMatrix * vec4(position, 1.0);
  gl_PointSize = uPointSize;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform vec3 uEye;
uniform int uMode; // 0 lit surface, 1 flat overlay, 2 pinpoint marker, 3 ring around the change being viewed, 4 see-through overlay
uniform float uAlpha;
in vec3 vWorld;
out vec4 outColor;
void main() {
  if (uMode >= 2) {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0 || (uMode == 3 && d < 0.84)) discard;
    // Duotone: the dot's own colour, with a rim in a darker shade of the same colour.
    float rim = uMode == 2 && d > 0.70 ? 0.62 : 1.0;
    outColor = vec4(uColor * rim * uAlpha, uAlpha);
    return;
  }
  if (uMode == 4) { outColor = vec4(uColor * uAlpha, uAlpha); return; }
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float facing = abs(dot(normal, normalize(uEye - vWorld)));
  float light = uMode == 1 ? 0.7 + 0.3 * facing : 0.28 + 0.72 * facing;
  outColor = vec4(uColor * light, 1.0);
}`;

// The vinyl colours of the toys on heyhaigh.ai: hot pink, green and blue.
export const COLORS = {
  removed: [0.941, 0.024, 0.514],
  added: [0.071, 0.741, 0.239],
  flipped: [0.0, 0.545, 0.918],
};

export function createViewer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true });
  if (!gl) return null;
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const uniform = name => gl.getUniformLocation(program, name);
  const U = { matrix: uniform('uMatrix'), color: uniform('uColor'), eye: uniform('uEye'), mode: uniform('uMode'), point: uniform('uPointSize'), lift: uniform('uLift'), alpha: uniform('uAlpha') };
  const attribute = gl.getAttribLocation(program, 'aPosition');

  /** One drawable: positions, optionally indexed. */
  function makeBuffer(positions, indices) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 0, 0);
    let ibo = null;
    if (indices) {
      ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, count: indices ? indices.length : positions.length / 3, indexed: !!indices };
  }
  const free = buffer => { if (!buffer) return; gl.deleteVertexArray(buffer.vao); gl.deleteBuffer(buffer.vbo); if (buffer.ibo) gl.deleteBuffer(buffer.ibo); };

  const scene = { before: null, after: null, removed: null, added: null, flipped: null, markers: {}, target: null, mesh: null };
  const view = { which: 'after', target: [0, 0, 0], yaw: -0.9, pitch: 0.35, distance: 3, radius: 1, centre: [0, 0, 0], surface: [0.72, 0.73, 0.75], showMarkers: true };
  let frame = 0;
  const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

  /**
   * `keepCamera` leaves the view where the visitor put it, for a new pose of the model in
   * view; otherwise the camera goes back to the whole model.
   */
  function setModel(data, { keepCamera = false } = {}) {
    clearPreview();
    for (const key of ['before', 'after', 'removed', 'added', 'flipped']) { free(scene[key]); scene[key] = null; }
    for (const key of Object.keys(scene.markers)) free(scene.markers[key]);
    scene.markers = {};
    scene.before = makeBuffer(data.before.positions, data.before.tris);
    scene.mesh = data.before; // kept for line-of-sight checks when flying to a change
    free(scene.target); scene.target = null; view.focused = null;
    scene.after = makeBuffer(data.after.positions, data.after.tris);
    for (const key of ['removed', 'added', 'flipped']) if (data[key] && data[key].length) scene[key] = makeBuffer(data[key]);
    for (const kind of ['removed', 'added', 'flipped']) {
      const ofKind = data.spots.filter(spot => spot.kind === kind);
      ofKind.forEach((spot, slot) => { spot.slot = slot; });
      const points = ofKind.flatMap(spot => spot.centre);
      if (points.length) scene.markers[kind] = makeBuffer(new Float32Array(points));
    }
    if (fit(data.before.positions, keepCamera)) redraw();
  }

  /**
   * Fit the view to a model. With `keep`, the camera stays where it is as long as the model
   * is about the same size and in about the same place: a new pose is often not, since a
   * rigged file's stored shape and its animated one can differ in scale a hundredfold.
   * Returns true when the camera was kept (the caller only needs to redraw).
   */
  function fit(p, keep = false) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) { const c = i % 3; if (p[i] < lo[c]) lo[c] = p[i]; if (p[i] > hi[c]) hi[c] = p[i]; }
    const centre = [0, 1, 2].map(c => (lo[c] + hi[c]) / 2);
    const radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
    const similar = radius / view.radius < 1.6 && view.radius / radius < 1.6 && Math.hypot(...centre.map((v, c) => v - view.centre[c])) < radius * 0.6;
    view.centre = centre;
    view.radius = radius;
    if (keep && similar) return true;
    home();
    return false;
  }

  // While a pose is being chosen, both sides show that bare pose, unrepaired, without the
  // change markers; the camera stays put. The next `setModel` puts the repair back.
  let held = null;
  function preview(positions) {
    if (!held) held = { before: scene.before, after: scene.after, removed: scene.removed, added: scene.added, flipped: scene.flipped, markers: scene.markers };
    else free(scene.before);
    const shape = makeBuffer(positions);
    Object.assign(scene, { before: shape, after: shape, removed: null, added: null, flipped: null, markers: {} });
    leaveFocus();
    if (fit(positions, true)) redraw();
  }
  function clearPreview() {
    if (!held) return;
    free(scene.before);
    Object.assign(scene, held);
    held = null;
  }

  function home() {
    leaveFocus();
    view.target = [...view.centre];
    view.distance = view.radius * (view.which === 'both' ? 3.2 : 2.6);
    redraw();
  }

  /** How far from `origin` along `direction` the model first gets in the way (Infinity if never). */
  function firstHit(origin, direction) {
    const { positions, tris } = scene.mesh;
    let nearest = Infinity;
    const [ox, oy, oz] = origin, [dx, dy, dz] = direction;
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
      const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
      const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-14 && det < 1e-14) continue;
      const tx = ox - positions[a], ty = oy - positions[a + 1], tz = oz - positions[a + 2];
      const u = (tx * px + ty * py + tz * pz) / det;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const w = (dx * qx + dy * qy + dz * qz) / det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) / det;
      if (t > 0 && t < nearest) nearest = t;
    }
    return nearest;
  }

  /**
   * Fly to a change and look at it from a direction with a clear line of sight. The
   * surface's own facing direction is tried first, then the direction out from the
   * model's middle, then tilts of each; the clearest one wins.
   */
  function focus(spot) {
    const distance = Math.max(spot.radius * 16, view.radius * 0.045);
    const unit = d => { const l = Math.hypot(...d) || 1; return d.map(x => x / l); };
    const outward = unit([0, 1, 2].map(c => spot.centre[c] - view.centre[c]));
    const base = [spot.normal, outward].filter(Boolean);
    const candidates = [];
    for (const d of base) {
      candidates.push(d);
      // Four tilts of about 40 degrees around it.
      const side = unit(Math.abs(d[2]) < 0.9 ? [d[1], -d[0], 0] : [1, 0, 0]);
      const up = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
      for (const [s, t] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) candidates.push(unit(d.map((x, c) => x + 0.85 * (s * side[c] + t * up[c]))));
    }
    candidates.push([0, 0, 1]);
    let best = candidates[0], clearest = -1;
    const start = view.radius * 0.004; // step off the surface before looking back along the line
    for (const d of candidates) {
      const clear = firstHit(spot.centre.map((x, c) => x + d[c] * start), d);
      if (clear > clearest) { clearest = clear; best = d; }
      if (clear >= distance * 1.2) break; // nothing between the camera and the change
    }
    view.target = [...spot.centre];
    view.distance = distance;
    view.yaw = Math.atan2(best[1], best[0]);
    view.pitch = Math.max(-1.45, Math.min(1.45, Math.asin(Math.max(-1, Math.min(1, best[2])))));
    free(scene.target);
    scene.target = makeBuffer(new Float32Array(spot.centre));
    view.focused = spot.kind;
    view.focusedSlot = spot.slot;
    redraw();
  }

  function leaveFocus() { free(scene.target); scene.target = null; view.focused = null; }

  function eye() {
    const c = Math.cos(view.pitch);
    return [view.target[0] + view.distance * c * Math.cos(view.yaw), view.target[1] + view.distance * c * Math.sin(view.yaw), view.target[2] + view.distance * Math.sin(view.pitch)];
  }

  function draw() {
    frame = 0;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio)), height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!scene.before) return;
    if (view.which === 'both') {
      // Before on the left, after on the right, seen from the same place.
      const half = Math.floor(width / 2);
      drawPart('before', 0, half, height, ratio);
      drawPart('after', width - half, half, height, ratio);
    } else {
      drawPart(view.which, 0, width, height, ratio);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  function drawPart(which, x, width, height, ratio) {
    const base = scene[which];
    gl.viewport(x, 0, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, 0, width, height);
    const from = eye();
    const matrix = multiply(perspective(0.6, width / height, view.distance * 0.02, view.distance + view.radius * 4), lookAt(from, view.target));
    gl.uniformMatrix4fv(U.matrix, false, matrix);
    gl.uniform3fv(U.eye, from);
    gl.uniform1f(U.lift, 0);
    gl.uniform1f(U.alpha, 1);
    gl.enable(gl.DEPTH_TEST);

    gl.uniform1i(U.mode, 0);
    gl.uniform3fv(U.color, view.surface);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.bindVertexArray(base.vao);
    if (base.indexed) gl.drawElements(gl.TRIANGLES, base.count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, base.count); // a pose being chosen: bare triangles
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.uniform1i(U.mode, 1);
    for (const key of which === 'before' ? ['removed'] : ['flipped', 'added']) {
      if (!scene[key]) continue;
      gl.uniform3fv(U.color, COLORS[key]);
      gl.bindVertexArray(scene[key].vao);
      gl.drawArrays(gl.TRIANGLES, 0, scene[key].count);
    }
    // Removed and added triangles often sit just under the surface. Whatever the surface
    // hides is drawn again, faintly, so the change can be seen through it.
    gl.uniform1i(U.mode, 4);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.GREATER);
    gl.uniform1f(U.alpha, 0.4);
    for (const key of which === 'before' ? ['removed'] : ['added']) {
      if (!scene[key]) continue;
      gl.uniform3fv(U.color, COLORS[key]);
      gl.bindVertexArray(scene[key].vao);
      gl.drawArrays(gl.TRIANGLES, 0, scene[key].count);
    }
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(U.alpha, 1);
    if (view.showMarkers) {
      // Pinpoints. Each is drawn twice: where the model is in front of it, it is faint,
      // because that change is on the far side; where nothing hides it, it is solid.
      // Turning the model brings a faint one round and it becomes solid.
      const close = view.distance < view.radius * 0.4;
      gl.uniform1i(U.mode, 2);
      gl.uniform1f(U.point, (close ? 9 : 11) * ratio);
      gl.uniform1f(U.lift, Math.min(view.radius * 0.02, view.distance * 0.06));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      const kinds = which === 'before' ? ['removed'] : ['flipped', 'added'];
      for (const [test, alpha] of [[gl.GREATER, 0.25], [gl.LEQUAL, 1]]) {
        gl.depthFunc(test);
        gl.uniform1f(U.alpha, alpha);
        for (const kind of kinds) {
          const buffer = scene.markers[kind];
          if (!buffer) continue;
          gl.uniform3fv(U.color, COLORS[kind]);
          gl.bindVertexArray(buffer.vao);
          const skip = scene.target && view.focused === kind ? view.focusedSlot : -1;
          if (skip < 0) gl.drawArrays(gl.POINTS, 0, buffer.count);
          else { gl.drawArrays(gl.POINTS, 0, skip); gl.drawArrays(gl.POINTS, skip + 1, buffer.count - skip - 1); }
        }
      }
      // The change being viewed gets a ring around it, on both halves, so the spot is
      // unmistakable even where the change itself is only a sliver.
      if (scene.target) {
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1i(U.mode, 3);
        gl.uniform1f(U.point, 44 * ratio);
        gl.uniform1f(U.alpha, 0.95);
        gl.uniform3fv(U.color, COLORS[view.focused] || COLORS.removed);
        gl.bindVertexArray(scene.target.vao);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.enable(gl.DEPTH_TEST);
      }
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1f(U.lift, 0);
      gl.uniform1f(U.alpha, 1);
    }
  }

  // --- pointer, wheel and keyboard control
  const pointers = new Map();
  let pinch = 0;
  const pan = (dx, dy) => {
    const scale = view.distance / canvas.clientHeight * 1.2;
    const right = [-Math.sin(view.yaw), Math.cos(view.yaw), 0];
    const up = [-Math.sin(view.pitch) * Math.cos(view.yaw), -Math.sin(view.pitch) * Math.sin(view.yaw), Math.cos(view.pitch)];
    for (let c = 0; c < 3; c++) view.target[c] += (-dx * right[c] + dy * up[c]) * scale;
  };
  const rotate = (dx, dy) => {
    view.yaw -= dx * 0.008;
    view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + dy * 0.008));
  };
  const zoom = factor => { view.distance = Math.max(view.radius * 0.002, Math.min(view.radius * 20, view.distance * factor)); };
  canvas.addEventListener('pointerdown', event => { canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, [event.clientX, event.clientY]); pinch = 0; });
  canvas.addEventListener('pointermove', event => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const dx = event.clientX - last[0], dy = event.clientY - last[1];
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1) {
      if (event.shiftKey || event.buttons === 2 || event.buttons === 4) pan(dx, dy); else rotate(dx, dy);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const spread = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoom(pinch / spread);
      pinch = spread;
      pan(dx / 2, dy / 2);
    }
    redraw();
  });
  const release = event => { pointers.delete(event.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => { event.preventDefault(); zoom(Math.exp(event.deltaY * 0.0015)); redraw(); }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const step = 0.12;
    const actions = { ArrowLeft: () => rotate(step / 0.008, 0), ArrowRight: () => rotate(-step / 0.008, 0), ArrowUp: () => rotate(0, step / 0.008), ArrowDown: () => rotate(0, -step / 0.008), '+': () => zoom(0.8), '=': () => zoom(0.8), '-': () => zoom(1.25), '0': home };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
    redraw();
  });
  const observer = new ResizeObserver(redraw);
  observer.observe(canvas);

  return {
    getCamera: () => ({ target: [...view.target], distance: view.distance, yaw: view.yaw, pitch: view.pitch }),
    setCamera(camera) { leaveFocus(); Object.assign(view, { target: [...camera.target], distance: camera.distance, yaw: camera.yaw, pitch: camera.pitch }); redraw(); },
    setModel,
    preview,
    endPreview() { clearPreview(); redraw(); },
    show(which) { view.which = which; redraw(); },
    focus,
    home,
    setSurface(color) { view.surface = color; redraw(); },
    setMarkers(on) { view.showMarkers = on; redraw(); },
    redraw,
  };
}

// --- column-major 4x4 matrices
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

function lookAt(eye, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = unit(sub(eye, target));
  const x = unit(cross([0, 0, 1], z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1] + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
  }
  return out;
}
