// Polymend promises that a visitor's file never leaves their device and that the page
// contacts nobody. These tests fail if a change would break that promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { embedPage } from '../tools/make-embed.mjs';
import { siteFiles } from '../tools/site-files.mjs';
import { changelogPage } from '../tools/make-changelog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// Exactly the files the build publishes: a file cannot ship without being checked here.
const shipped = siteFiles().filter(file => /\.(html|js|css)$/.test(file));
const pages = shipped.filter(file => file.endsWith('.html'));
const scripts = shipped.filter(file => file.endsWith('.js'));

const policyOf = text => Object.fromEntries(text.split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([name, ...values]) => [name, values]));

test('the page policy forbids every network connection and all outside code', () => {
  const meta = read('index.html').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, 'index.html must carry a Content-Security-Policy');
  const header = read('_headers').match(/Content-Security-Policy: (.+)/);
  assert.ok(header, '_headers must send a Content-Security-Policy');
  for (const [where, text] of [['index.html', meta[1]], ['_headers', header[1]]]) {
    const policy = policyOf(text);
    assert.deepEqual(policy['default-src'], ["'none'"], `${where}: default-src`);
    assert.deepEqual(policy['connect-src'], ["'none'"], `${where}: connect-src`);
    for (const name of ['script-src', 'worker-src', 'style-src', 'font-src']) assert.deepEqual(policy[name], ["'self'"], `${where}: ${name}`);
    assert.ok(policy['img-src'].every(value => value === "'self'" || value === 'data:'), `${where}: img-src`);
    assert.deepEqual(policy['form-action'], ["'none'"], `${where}: form-action`);
  }
});

test('the privacy and terms pages carry the same no-connection policy', () => {
  for (const file of ['privacy.html', 'terms.html', 'embed.html', 'changelog.html']) {
    const meta = read(file).match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.ok(meta, `${file} must carry a Content-Security-Policy`);
    const policy = policyOf(meta[1]);
    assert.deepEqual(policy['default-src'], ["'none'"], file);
    assert.deepEqual(policy['connect-src'], ["'none'"], file);
    assert.deepEqual(policy['script-src'], ["'self'"], file);
  }
});

test('Cloudflare is told not to alter the page, so it cannot add its analytics script', () => {
  assert.match(read('_headers'), /Cache-Control: no-cache, no-transform/);
});

test('nothing the site ships loads code, styles, fonts or images from another site', () => {
  for (const file of shipped) {
    const text = read(file);
    for (const match of text.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
      const [, tag, url] = match;
      const outside = /^(https?:)?\/\//.test(url) && !url.startsWith('https://polymend.xyz/'); // the site's own address is not outside
      // Plain links and the tags that describe the page to search engines are not loads.
      const harmless = tag === 'link' && /rel="(canonical|author)"/.test(match[0]);
      assert.ok(!outside || harmless, `${file} loads ${url}`);
    }
    assert.ok(!/@import\s+(url\()?["']?https?:/.test(text), `${file} imports an outside stylesheet`);
    assert.ok(!/url\(["']?https?:/.test(text), `${file} loads an outside file from CSS`);
  }
});

test('no shipped code can send data: no fetch, beacons, sockets, forms or analytics', () => {
  const banned = [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /\bWebSocket\b/, /EventSource/, /RTCPeerConnection/, /importScripts\s*\(/,
    /googletagmanager|google-analytics|gtag\s*\(|cloudflareinsights|plausible|segment\.com|hotjar|mixpanel/i, /document\.cookie/, /<form\b/i];
  for (const file of shipped) {
    const text = read(file);
    for (const pattern of banned) assert.ok(!pattern.test(text), `${file} contains ${pattern}`);
  }
});

test('no page carries code of its own: no inline scripts, handlers, styles or frames', () => {
  for (const file of pages) {
    const text = read(file);
    for (const tag of text.matchAll(/<script\b[^>]*>/g)) {
      assert.ok(/\bsrc="[^"]+"/.test(tag[0]) || /type="application\/ld\+json"/.test(tag[0]), `${file} has an inline script: ${tag[0]}`);
    }
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(text), `${file} has an inline event handler`);
    assert.ok(!/javascript:/i.test(text), `${file} has a javascript: address`);
    assert.ok(!/<style\b|\sstyle\s*=\s*"/i.test(text), `${file} has inline styles`);
    assert.ok(!/<(iframe|object|embed|base|frame|applet)\b/i.test(text), `${file} embeds something`);
    assert.ok(!/http-equiv="refresh"/i.test(text) && !/\sping\s*=/i.test(text), `${file} redirects or pings`);
  }
});

test('no shipped code can leave the page or reach outside it by a side door', () => {
  // The security policy blocks connections. These are the routes it does not block, so
  // the code is checked for them instead: sending the visitor to another address with
  // data in it, building markup or script from text, and talking to a surrounding page.
  const banned = [
    [/\blocation\s*\.\s*(href|assign|replace|reload)\b|\blocation\s*=[^=]/, 'changes the address'],
    [/window\s*\.\s*open|\bopener\b/, 'opens or reaches another window'],
    [/\beval\s*\(|new\s+Function\b|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]/, 'runs text as code'],
    [/document\s*\.\s*write|innerHTML|outerHTML|insertAdjacentHTML|DOMParser|srcdoc/, 'builds markup from text'],
    [/\bimport\s*\(/, 'loads code on the fly'],
    [/new\s+Image\b|\.src\s*=|setAttribute\(\s*["'](src|href|action|formaction)["']/, 'points an element at an address'],
    [/createElement\(\s*["'](script|iframe|img|link|form|object|embed|video|audio|source|base)["']/, 'creates an element that loads something'],
    [/window\s*\.\s*(parent|top)\b|\b(parent|top)\s*\.\s*postMessage|BroadcastChannel|SharedWorker|serviceWorker/, 'talks to another page'],
    [/\.submit\s*\(|navigator\s*\.\s*(sendBeacon|share|clipboard\s*\.\s*read)/, 'sends or reads beyond the page'],
    [/indexedDB|sessionStorage|caches\s*\.|document\s*\.\s*cookie/, 'stores more than the theme'],
  ];
  for (const file of scripts) {
    const text = read(file);
    for (const [pattern, what] of banned) assert.ok(!pattern.test(text), `${file} ${what}: ${pattern}`);
    // A link's address is set in one place only: the download of the visitor's own repaired file.
    for (const line of text.split('\n')) if (/\.href\s*=/.test(line)) assert.match(line, /URL\.createObjectURL\(/, `${file}: ${line.trim()}`);
  }
  // Messages pass only between the page and its own worker.
  for (const file of scripts) if (/postMessage/.test(read(file))) assert.ok(['app/app.js', 'app/worker.js'].includes(file), `${file} posts messages`);
  // The theme is the only thing saved, and only on Polymend's own site.
  for (const file of scripts) if (/localStorage/.test(read(file))) assert.equal(file, 'app/theme.js', `${file} uses localStorage`);
});

test('the one piece of server code only answers the ownership-check address', () => {
  const worker = read('site-worker.js');
  assert.ok(!/\bfetch\s*\(\s*["'`]https?:/.test(worker), 'site-worker.js must not call out to other sites');
  assert.match(worker, /return env\.ASSETS\.fetch\(request\);/);
  assert.match(worker, /'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"/, 'its one response is as closed as the rest of the site');
  assert.match(read('wrangler.toml'), /run_worker_first = \["\/google[0-9a-f]+\.html"\]/);
});

test('the embedded copy is the home page with parts removed, and is up to date', () => {
  const embed = read('embed.html');
  assert.equal(embed, embedPage(read('index.html')), 'embed.html is out of date. Run: node tools/make-embed.mjs');
  assert.match(embed, /<meta name="robots" content="noindex">/);
  assert.ok(!/id="theme-toggle"|class="faq"|class="site-links"|<dialog/.test(embed), 'the embedded copy should be the tool alone');
  // Every link in a frame must open a new tab; the rest of the site refuses to be framed.
  for (const link of embed.matchAll(/<a\b[^>]*>/g)) assert.match(link[0], /target="_blank"/, `embed.html link stays inside the frame: ${link[0]}`);
});

test('only the embedded copy may be placed in a frame by other sites, and it is just as closed', () => {
  const blocks = Object.fromEntries(read('_headers').split(/\n(?=\/)/).map(block => [block.split('\n')[0].trim(), block]));
  const policy = block => policyOf(block.match(/^\s+Content-Security-Policy: (.+)$/m)[1]);
  const site = policy(blocks['/*']), embed = policy(blocks['/embed']);
  assert.deepEqual(site['frame-ancestors'], ["'self'", 'https://heyhaigh.ai', 'https://www.heyhaigh.ai']);
  assert.deepEqual(embed['frame-ancestors'], ['*']);
  assert.match(blocks['/embed'], /^\s+! Content-Security-Policy$/m, 'the site-wide policy must be dropped for /embed, or both would apply');
  // Apart from who may frame it, the two policies are identical.
  assert.deepEqual({ ...embed, 'frame-ancestors': null }, { ...site, 'frame-ancestors': null });
});

test('the embed code on the home page points at the embedded copy and nothing else', () => {
  const code = read('index.html').match(/<code id="embed-snippet">([^<]+)<\/code>/)[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"');
  assert.match(code, /^<iframe src="https:\/\/polymend\.xyz\/embed" [^>]*height="340"[^>]*><\/iframe>$/);
  assert.ok(!/<script|allow=|sandbox=/.test(code), 'the embed code should be a plain frame: no script, no extra permissions');
});

test('the changelog page is made from CHANGELOG.md and is up to date', () => {
  assert.equal(read('changelog.html'), changelogPage(read('CHANGELOG.md')), 'changelog.html is out of date. Run: node tools/make-changelog.mjs');
  const version = read('src/output.js').match(/VERSION = '([^']+)'/)[1];
  assert.ok(read('CHANGELOG.md').split('\n').some(line => line.startsWith(`## ${version} `)), `CHANGELOG.md has no entry for version ${version}`);
  for (const file of ['index.html', 'privacy.html', 'terms.html', 'changelog.html']) {
    assert.match(read(file), /<a href="\/changelog">Changelog<\/a>/, `${file} links to the change log`);
    assert.match(read(file), /<a href="mailto:feedback@polymend\.xyz\?subject=[^"]+">Send feedback<\/a>/, `${file} has the feedback link`);
  }
});

test('nothing public uses a word the owner has ruled out', () => {
  // The words are listed in tools/local.json, which is not part of the repository.
  const local = path.join(root, 'tools/local.json');
  if (!fs.existsSync(local)) return;
  const words = (JSON.parse(fs.readFileSync(local, 'utf8')).forbiddenWords || []).map(word => word.toLowerCase());
  if (!words.length) return;
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const file of tracked) {
    if (/\.(png|jpg|webp|woff2|ico)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    for (const word of words) assert.ok(!text.includes(word), `${file} contains a word that must not appear in anything public`);
  }
  // Every commit's message and every line ever added, since the history is public too.
  const history = execFileSync('git', ['log', '-p', '--format=%B'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).toLowerCase();
  for (const word of words) assert.ok(!history.includes(word), 'the public history contains a word that must not appear in anything public');
});
