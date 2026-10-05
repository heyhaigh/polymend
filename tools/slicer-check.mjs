// Ask a slicer what it thinks of STL files: is the mesh manifold, how many open edges, what
// did it have to fix on import. A second opinion from a real slicer, with no window.
// Usage: node tools/slicer-check.mjs file.stl [more.stl ...]
// Needs a slicer whose program prints a "name = value" report for `--info file.stl`.
// Point POLYMEND_SLICER at that program, or set "slicer" in tools/local.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root } from './local.mjs';

const saved = fs.existsSync(path.join(root, 'tools/local.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'tools/local.json'), 'utf8')) : {};
const program = [process.env.POLYMEND_SLICER, saved.slicer].find(place => place && fs.existsSync(place));
if (!program) { console.log('No slicer is set. Point POLYMEND_SLICER at a slicer program that answers `--info file.stl`.'); process.exit(2); }

let failed = 0;
for (const file of process.argv.slice(2)) {
  let text = '';
  try { text = execFileSync(program, ['--info', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { text = String(error.stdout || '') + String(error.stderr || ''); }
  const value = name => (new RegExp(`^${name} = *(.+)$`, 'm').exec(text) || [])[1];
  const manifold = value('manifold');
  const fixes = ['open_edges', 'degenerate_facets', 'edges_fixed', 'facets_removed', 'facets_reversed', 'backwards_edges'].filter(name => value(name)).map(name => `${name.replace(/_/g, ' ')} ${value(name)}`);
  if (manifold !== 'yes') failed++;
  console.log(`${manifold === 'yes' ? 'PASS' : 'FAIL'}  ${path.basename(file).slice(0, 46).padEnd(46)} manifold ${manifold || '?'}  parts ${value('number_of_parts') || '?'}  facets ${value('number_of_facets') || '?'}${fixes.length ? '  | ' + fixes.join(', ') : ''}`);
}
process.exit(failed ? 1 : 0);
