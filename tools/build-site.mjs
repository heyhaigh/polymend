// Copy just the files the public site needs into dist/. Tools, tests, docs and test
// output stay out, so nothing private can be published by accident.
import fs from 'node:fs';
import path from 'node:path';
import { embedPage } from './make-embed.mjs';
import { root, siteFiles } from './site-files.mjs';

const dist = path.join(root, 'dist');

// embed.html is made from index.html; never publish one that has fallen behind.
if (fs.readFileSync(path.join(root, 'embed.html'), 'utf8') !== embedPage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))) {
  throw new Error('embed.html is out of date. Run: node tools/make-embed.mjs');
}

fs.rmSync(dist, { recursive: true, force: true });
const copied = siteFiles();
for (const relative of copied) {
  fs.mkdirSync(path.dirname(path.join(dist, relative)), { recursive: true });
  fs.copyFileSync(path.join(root, relative), path.join(dist, relative));
}
const bytes = copied.reduce((sum, file) => sum + fs.statSync(path.join(dist, file)).size, 0);
console.log(`${copied.length} files, ${(bytes / 1024).toFixed(0)} KB`);
for (const file of copied) console.log('  ' + file);
