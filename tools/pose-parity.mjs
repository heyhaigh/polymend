// Posed shapes, checked point for point against three.js, whose glTF loader follows the
// standard closely: for each file in a list, the rest pose and a few moments of a few clips.
// Each of Polymend's points must lie on one of three.js's (the two weld differently).
// Usage: node tools/pose-parity.mjs <list of .glb paths, one a line> [--clips 4]
// three.js is borrowed from the same folder as Playwright (see tools/local.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { load } from '../src/pipeline.js';
import { threeModule } from './local.mjs';

const threePath = threeModule();
const THREE = await import(threePath);
const { GLTFLoader } = await import(threePath.replace(/build\/three\.(module\.)?c?js$/, 'examples/jsm/loaders/GLTFLoader.js'));
globalThis.self ||= globalThis;
const quiet = console.error; console.error = (...a) => { if (!/Couldn't load texture/.test(String(a[0]))) quiet(...a); };
console.warn = () => {}; // three.js warns about textures it cannot decode in Node; shape is all that matters

const args = process.argv.slice(2);
const list = args[0];
const perFile = Number(args[args.indexOf('--clips') + 1]) || 4;
const files = fs.readFileSync(list, 'utf8').split('\n').map(line => line.trim()).filter(line => line && fs.existsSync(line) && fs.statSync(line).isFile());
let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const TOLERANCE = 0.001; // a thousandth of the model's size
let matched = 0, differed = 0, skipped = 0;

for (const [n, file] of files.entries()) {
  const label = `[${n + 1}/${files.length}] ${path.basename(file)}`;
  const bytes = fs.readFileSync(file);
  let gltf, mesh;
  try { mesh = load(new Uint8Array(bytes), file); } catch (error) { skipped++; console.log(`skip  ${label}: Polymend: ${error.message}`); continue; }
  try { gltf = await new Promise((ok, no) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', ok, no)); }
  catch (error) { skipped++; console.log(`skip  ${label}: three.js: ${String(error.message || error).slice(0, 80)}`); continue; }
  // Every object's own placement and blend shape weights, put back before each pose.
  const saved = [];
  gltf.scene.traverse(o => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone(), o.morphTargetInfluences ? [...o.morphTargetInfluences] : null]));
  const reset = () => { for (const [o, p, q, s, w] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); if (w) w.forEach((v, i) => { o.morphTargetInfluences[i] = v; }); } };
  const clips = mesh.clips.length <= perFile ? mesh.clips : Array.from({ length: perFile }, () => mesh.clips[Math.floor(random() * mesh.clips.length)]);
  const poses = [null, ...clips.flatMap(clip => [{ clip: clip.index, time: clip.duration * random() }, { clip: clip.index, time: clip.duration }])];
  let worst = { error: 0, pose: 'rest' };
  for (const pose of poses) {
    reset();
    const mixer = new THREE.AnimationMixer(gltf.scene);
    if (pose) { const action = mixer.clipAction(gltf.animations[pose.clip]); action.setLoop(THREE.LoopOnce); action.clampWhenFinished = true; action.play(); mixer.setTime(pose.time); }
    gltf.scene.updateMatrixWorld(true);
    const ref = [], v = new THREE.Vector3();
    gltf.scene.traverse(o => {
      if (!o.isMesh || !o.visible) return;
      const position = o.geometry.attributes.position, morphs = o.geometry.morphAttributes.position, weights = o.morphTargetInfluences;
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i);
        // Blend shapes, as three.js applies them on the graphics card (relative to the base shape).
        if (pose && morphs && weights) morphs.forEach((target, t) => { if (weights[t]) { v.x += weights[t] * target.getX(i); v.y += weights[t] * target.getY(i); v.z += weights[t] * target.getZ(i); } });
        if (pose && o.isSkinnedMesh) o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld);
        ref.push(v.x, -v.z, v.y); // Z-up, as Polymend reads it
      }
    });
    mixer.stopAllAction();
    const ours = mesh.posed(pose);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < ref.length; i++) { const c = i % 3; lo[c] = Math.min(lo[c], ref[i]); hi[c] = Math.max(hi[c], ref[i]); }
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1, cell = size / 100, at = x => Math.floor(x / cell), grid = new Map();
    for (let i = 0; i < ref.length; i += 3) { const k = `${at(ref[i])},${at(ref[i + 1])},${at(ref[i + 2])}`; (grid.get(k) || grid.set(k, []).get(k)).push(i); }
    let error = 0;
    const step = 3 * Math.max(1, Math.floor(ours.length / 3 / 50_000)); // up to 50,000 points a pose
    for (let i = 0; i < ours.length; i += step) {
      let best = cell * 2; const cx = at(ours[i]), cy = at(ours[i + 1]), cz = at(ours[i + 2]);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) for (const q of grid.get(`${cx + a},${cy + b},${cz + c}`) || []) best = Math.min(best, Math.hypot(ref[q] - ours[i], ref[q + 1] - ours[i + 1], ref[q + 2] - ours[i + 2]));
      error = Math.max(error, best / size);
    }
    if (error > worst.error) worst = { error, pose: pose ? `"${mesh.clips[pose.clip].label}" at ${pose.time.toFixed(3)} s` : 'rest' };
  }
  const ok = worst.error <= TOLERANCE;
  if (ok) matched++; else differed++;
  console.log(`${ok ? 'ok  ' : 'DIFF'}  ${label}: ${poses.length} poses, worst ${(worst.error * 100).toFixed(4)}% of its size (${worst.pose})${mesh.notes.length ? ` [${mesh.notes.join(', ')}]` : ''}`);
}
console.log(`\n${files.length} files: ${matched} match, ${differed} differ, ${skipped} skipped`);
process.exit(differed ? 1 : 0);
