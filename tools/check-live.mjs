// Check the live site against this build: the security headers on every kind of page,
// and that each file served is byte-for-byte the file that was built, so nothing has been
// added to a page on its way out (a host's analytics script, for instance).
// Run after a deploy:  node tools/build-site.mjs && node tools/check-live.mjs [https://polymend.xyz]
import fs from 'node:fs';
import path from 'node:path';
import { root, siteFiles } from './site-files.mjs';

const site = (process.argv[2] || 'https://polymend.xyz').replace(/\/$/, '');
const dist = path.join(root, 'dist');
const problems = [];
const note = (ok, text) => { if (!ok) problems.push(text); console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); };
const policyOf = text => Object.fromEntries((text || '').split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([name, ...values]) => [name, values.join(' ')]));

const pages = { '/': 'index.html', '/embed': 'embed.html', '/privacy': 'privacy.html', '/terms': 'terms.html', '/changelog': 'changelog.html' };
for (const [address, file] of Object.entries(pages)) {
  const response = await fetch(site + address, { redirect: 'manual', cache: 'no-store' });
  const body = await response.text();
  const policy = policyOf(response.headers.get('content-security-policy'));
  note(response.status === 200, `${address} answers 200 (got ${response.status})`);
  note(policy['default-src'] === "'none'" && policy['connect-src'] === "'none'" && policy['script-src'] === "'self'", `${address} forbids connections and outside code`);
  const frames = policy['frame-ancestors'];
  note(address === '/embed' ? frames === '*' : frames === "'self' https://heyhaigh.ai https://www.heyhaigh.ai", `${address} may be framed by: ${frames}`);
  note((response.headers.get('content-security-policy') || '').split(',').length === 1, `${address} carries one policy, not two`);
  note(/no-transform/.test(response.headers.get('cache-control') || ''), `${address} tells the host not to alter it`);
  note(response.headers.get('referrer-policy') === 'no-referrer' && response.headers.get('x-content-type-options') === 'nosniff', `${address} has the other security headers`);
  note(body === fs.readFileSync(path.join(dist, file), 'utf8'), `${address} is exactly the built ${file} (nothing added or changed)`);
  note(!/cloudflareinsights|beacon\.min\.js|googletagmanager|gtag\(/i.test(body), `${address} has no analytics script`);
}

// Every script, style and module the pages load, compared with the build.
let same = 0;
const code = siteFiles().filter(file => /\.(js|css)$/.test(file));
for (const file of code) {
  const response = await fetch(`${site}/${file}`, { cache: 'no-store' });
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status === 200 && body.equals(fs.readFileSync(path.join(dist, file)))) same++;
  else note(false, `/${file} differs from the build (status ${response.status})`);
}
note(same === code.length, `${same} of ${code.length} scripts and styles are exactly as built`);

const missing = await fetch(site + '/no-such-page-' + Date.now(), { cache: 'no-store' });
note(missing.status === 404 && policyOf(missing.headers.get('content-security-policy'))['connect-src'] === "'none'", 'a missing page answers 404 with the same policy');
const moved = await fetch(site + '/embed.html', { redirect: 'manual', cache: 'no-store' });
note(moved.status >= 300 && moved.status < 400, `/embed.html redirects to /embed (${moved.status})`);
const owner = fs.readFileSync(path.join(root, 'site-worker.js'), 'utf8').match(/'(\/google[0-9a-f]+\.html)'/)[1];
const check = await fetch(site + owner, { redirect: 'manual', cache: 'no-store' });
note(check.status === 200 && /^google-site-verification: /.test(await check.text()), 'the search-console ownership file answers directly');
note(policyOf(check.headers.get('content-security-policy'))['default-src'] === "'none'", 'the ownership file carries a closed policy too');

console.log(problems.length ? `\n${problems.length} problem(s). If this build has not been deployed yet, deploy it and run this again.` : '\nThe live site matches this build.');
process.exit(problems.length ? 1 : 0);
