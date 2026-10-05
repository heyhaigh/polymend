// Polymend promises that a visitor's file never leaves their device and that the page
// contacts nobody. These tests fail if a change would break that promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const shipped = ['index.html', '404.html', 'privacy.html', 'terms.html', ...walk('app'), ...walk('src')].filter(file => /\.(html|js|css)$/.test(file));

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
  for (const file of ['privacy.html', 'terms.html']) {
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
      const outside = /^(https?:)?\/\//.test(url);
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

test('the one piece of server code only answers the ownership-check address', () => {
  const worker = read('site-worker.js');
  assert.ok(!/\bfetch\s*\(\s*["'`]https?:/.test(worker), 'site-worker.js must not call out to other sites');
  assert.match(worker, /return env\.ASSETS\.fetch\(request\);/);
  assert.match(read('wrangler.toml'), /run_worker_first = \["\/google[0-9a-f]+\.html"\]/);
});
