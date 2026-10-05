// The list of files that make up the public site, and nothing else. The build copies
// exactly these into dist/, and the privacy tests check exactly these, so a file cannot
// be published without also being checked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const include = ['index.html', 'embed.html', '404.html', 'privacy.html', 'terms.html', 'favicon.svg', 'favicon-48.png', 'apple-touch-icon.png', 'og-image.jpg', 'robots.txt', 'sitemap.xml', 'llms.txt', '_headers', 'LICENSE', 'app', 'src'];
const allowed = /\.(html|js|css|svg|txt|xml|woff2|webp|png|jpg)$|^_headers$|^LICENSE$/;

/** Every published file, as a path relative to the repository root. */
export function siteFiles() {
  const out = [];
  const add = relative => {
    const from = path.join(root, relative);
    if (fs.statSync(from).isDirectory()) { for (const name of fs.readdirSync(from).sort()) add(path.join(relative, name)); return; }
    if (!allowed.test(path.basename(relative))) throw new Error(`Unexpected file type, not published: ${relative}`);
    out.push(relative);
  };
  for (const item of include) add(item);
  return out;
}
