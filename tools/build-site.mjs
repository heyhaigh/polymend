// Copy just the files the public site needs into dist/. Tools, tests, docs and test
// output stay out, so nothing private can be published by accident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const include = ['index.html', '404.html', 'privacy.html', 'terms.html', 'favicon.svg', 'favicon-48.png', 'apple-touch-icon.png', 'og-image.jpg', 'robots.txt', 'sitemap.xml', 'llms.txt', '_headers', 'LICENSE', 'app', 'src'];
const allowed = /\.(html|js|css|svg|txt|xml|woff2|webp|png|jpg)$|^_headers$|^LICENSE$/;

fs.rmSync(dist, { recursive: true, force: true });
const copied = [];
const copy = relative => {
  const from = path.join(root, relative);
  if (fs.statSync(from).isDirectory()) { for (const name of fs.readdirSync(from).sort()) copy(path.join(relative, name)); return; }
  if (!allowed.test(path.basename(relative))) throw new Error(`Unexpected file type, not published: ${relative}`);
  fs.mkdirSync(path.dirname(path.join(dist, relative)), { recursive: true });
  fs.copyFileSync(from, path.join(dist, relative));
  copied.push(relative);
};
for (const item of include) copy(item);
const bytes = copied.reduce((sum, file) => sum + fs.statSync(path.join(dist, file)).size, 0);
console.log(`${copied.length} files, ${(bytes / 1024).toFixed(0)} KB`);
for (const file of copied) console.log('  ' + file);
