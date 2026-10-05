// Does reading a GLB give the same geometry as the Blender STL export of that GLB?
import fs from 'node:fs';
import { parseGLB, yUpToZUp } from '../src/glb.js';
import { parseSTL } from '../src/stl.js';
import { weld, analyze } from '../src/mesh.js';
import { repair } from '../src/repair.js';
import { sample } from './local.mjs';

// A GLB and the STL that was exported from it by hand, both named after the same model.
const hint = process.argv[2] || 'crocodile';
const fromGlb = weld(Float32Array.from(yUpToZUp(parseGLB(fs.readFileSync(sample('.glb', hint))))));
const fromStl = weld(parseSTL(fs.readFileSync(sample('.stl', hint))));
const a = analyze(fromGlb.positions, fromGlb.tris), b = analyze(fromStl.positions, fromStl.tris);
console.log('GLB', JSON.stringify(a));
console.log('STL', JSON.stringify(b));
const box = p => { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); } return [...lo, ...hi].map(x => +x.toFixed(5)); };
console.log('GLB box', box(fromGlb.positions).join(' '));
console.log('STL box', box(fromStl.positions).join(' '));
const r = repair(fromGlb.positions, fromGlb.tris).report;
console.log('GLB repaired: clean', r.clean, JSON.stringify(r.after));
