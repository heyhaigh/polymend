// Copy just the files the public site needs into dist/. Tools, tests, docs and test
// output stay out, so nothing private can be published by accident.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { embedPage } from './make-embed.mjs';
import { changelogPage } from './make-changelog.mjs';
import { root, siteFiles } from './site-files.mjs';

const dist = path.join(root, 'dist');

// embed.html is made from index.html; never publish one that has fallen behind.
if (fs.readFileSync(path.join(root, 'embed.html'), 'utf8') !== embedPage(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))) {
  throw new Error('embed.html is out of date. Run: node tools/make-embed.mjs');
}

if (fs.readFileSync(path.join(root, 'changelog.html'), 'utf8') !== changelogPage(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'))) {
  throw new Error('changelog.html is out of date. Run: node tools/make-changelog.mjs');
}

fs.rmSync(dist, { recursive: true, force: true });
const copied = siteFiles();
for (const relative of copied) {
  fs.mkdirSync(path.dirname(path.join(dist, relative)), { recursive: true });
  fs.copyFileSync(path.join(root, relative), path.join(dist, relative));
}
// Each sitemap entry gets the date its page last changed, read from git, so it cannot
// fall behind. The homepage counts the tool's own code, since that is what it shows.
const sources = { '/': ['index.html', 'app', 'src'], '/privacy': ['privacy.html'], '/terms': ['terms.html'], '/changelog': ['changelog.html', 'CHANGELOG.md'] };
const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8').replace(/<loc>https:\/\/polymend\.xyz(\/[^<]*)<\/loc>/g, (whole, page) => {
  const files = sources[page];
  if (!files) throw new Error(`sitemap.xml lists ${page}, which has no source files to date it by`);
  const date = execFileSync('git', ['log', '-1', '--format=%cs', '--', ...files], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`No git date for ${page}`);
  return `${whole}<lastmod>${date}</lastmod>`;
});
fs.writeFileSync(path.join(dist, 'sitemap.xml'), sitemap);

const bytes = copied.reduce((sum, file) => sum + fs.statSync(path.join(dist, file)).size, 0);
console.log(`${copied.length} files, ${(bytes / 1024).toFixed(0)} KB`);
for (const file of copied) console.log('  ' + file);
