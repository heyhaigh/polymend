// Page behaviour: take a file, hand it to the worker, show what it found and did.

import { createViewer } from './viewer.js';
import { VERSION } from '../src/output.js';
import * as sound from './sound.js';
import { FAILURES } from './messages.js';

const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-US');
const plural = (count, one, many = one + 's') => `${number(count)} ${count === 1 ? one : many}`;

const state = { name: '', format: '', report: null, extent: [0, 0, 0], spots: [], spot: -1, busy: false, which: 'after' };
const viewer = createViewer($('canvas'));
if (!viewer) { $('canvas').hidden = true; $('no-webgl').hidden = false; }
$('version').textContent = `Version ${VERSION}.`;

// The model is drawn in a warm clay grey that sits on either theme's stage.
const theme = window.polymendTheme;
const surface = dark => (dark ? [0.66, 0.68, 0.71] : [0.76, 0.74, 0.70]);
viewer?.setSurface(surface(theme?.isDark()));
theme?.onChange(dark => viewer?.setSurface(surface(dark)));

// A normal model takes about a second. Anything still running after a minute is stuck
// or far outside what this page repairs, so the work is stopped and the user is told.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const askedLimit = Number(new URLSearchParams(location.search).get('limit-ms'));
const LIMIT_MS = LOCAL && askedLimit > 0 ? askedLimit : 60_000;
let worker = null;
let limit = 0;

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = () => {
    clearTimeout(limit);
    worker.terminate();
    startWorker();
    lostModel();
    fail(FAILURES.crashed.detail, FAILURES.crashed.title);
  };
  worker.onmessage = onMessage;
}

/** Send work to the worker and start the clock. */
function ask(message, transfer = []) {
  clearTimeout(limit);
  limit = setTimeout(() => {
    // The worker cannot be interrupted, so it is thrown away and replaced. The model it
    // was holding goes with it.
    worker.terminate();
    startWorker();
    lostModel();
    fail(FAILURES.timedOut.detail, FAILURES.timedOut.title);
  }, LIMIT_MS);
  worker.postMessage(message, transfer);
}

/**
 * The worker holding the model is gone. If a finished repair is on the page it stays
 * there to look at, and the same file is quietly loaded into the new worker so that
 * downloads and options work again. With nothing finished, the page starts over.
 */
function lostModel() {
  if (state.report && state.file && !state.reloading) {
    state.reloading = true; // one quiet reload only; if that also fails, start over
    for (const input of document.querySelectorAll('[data-option]')) input.checked = state.goodOptions[input.dataset.option];
    state.file.arrayBuffer().then(buffer => { setBusy(true); ask({ type: 'load', buffer, name: state.shown, options: state.goodOptions }, [buffer]); }).catch(() => {});
    return;
  }
  state.reloading = false;
  state.report = null;
  $('results').hidden = true;
  $('outcome').hidden = true;
  document.body.classList.remove('has-results', 'outcome-clean');
  $('drop').classList.remove('compact');
  $('choose-label').textContent = 'Choose a file';
  placeTop();
}
startWorker();

/**
 * The top block is sticky, but slides up until whatever sits above the status line is out
 * of view: the title and description at first, the outcome card once there is one. What
 * stays pinned is the status line and the upload card (or the file strip, once a model is
 * loaded), so choosing a file is always one click away.
 */
function placeSticky() {
  const meta = document.querySelector('.top-stick .tool-meta');
  $('top-stick').style.top = `${16 - meta.offsetTop}px`;
}

/** An outcome, good or bad, takes the place of the title and description. */
function placeTop() {
  document.body.classList.toggle('has-outcome', !$('failure').hidden || !$('outcome').hidden);
  placeSticky();
}

/** The outcome card is the first thing on the page, so a new outcome brings the page back to it. */
function toTop() {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
}
window.addEventListener('resize', placeSticky);
document.fonts?.ready.then(placeSticky); // the real font changes the heights slightly
placeSticky();

function setStatus(text, kind = '') {
  const status = $('status');
  status.textContent = text;
  status.className = 'status' + (kind ? ' ' + kind : '');
}

/** The header badge: faint while nothing is loaded, coloured while working and after. */
function setBadge(kind, text) {
  const badge = $('badge');
  badge.className = 'badge ' + kind;
  badge.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['choose', 'rotate']) $(id).disabled = busy;
  for (const control of document.querySelectorAll('[data-option], [data-download], .split-caret')) control.disabled = busy;
  if (busy) closeMenus();
}

/**
 * Something went wrong: say so in its own pink outcome card. If an earlier model is
 * still on the page it stays there, and the card says which one it is.
 */
function fail(message, title = FAILURES.unreadable.title) {
  setBusy(false);
  const kept = state.report ? ` The model below is still ${state.shown}.` : '';
  $('failure-title').textContent = title;
  $('failure-detail').textContent = message + kept;
  $('failure').classList.remove('stale');
  $('failure').hidden = false;
  document.body.classList.remove('outcome-clean');
  placeTop();
  toTop();
  setBadge('bad', 'Not repaired');
  sound.play('failed');
  setStatus(state.report ? `${state.shown} · ${number(state.report.before.triangles)} triangles` : '');
}

function showOutcomeBadge() {
  const status = state.report.status;
  if (status === 'partial') setBadge('warn', 'Partly repaired on this device');
  else if (status === 'sound') setBadge('info', 'Checked on this device');
  else setBadge('good', 'Repaired on this device');
}

function options() {
  const out = {};
  for (const input of document.querySelectorAll('[data-option]')) out[input.dataset.option] = input.checked;
  return out;
}

async function openFile(file) {
  if (!file || state.busy) return;
  if (file.size > 400 * 1024 * 1024) return fail(FAILURES.tooLarge.detail, FAILURES.tooLarge.title);
  state.name = file.name;
  state.pendingFile = file;
  state.fresh = true;
  setBusy(true);
  // With no model on the page, an earlier failure stays, dimmed, until the new outcome
  // replaces it. Hiding it would bring the title back for a moment and shift the page twice.
  if ($('outcome').hidden) $('failure').classList.add('stale'); else $('failure').hidden = true;
  placeTop();
  setBadge('working', 'Working on this device');
  setStatus(`Reading ${file.name}`, 'busy');
  let buffer;
  try { buffer = await file.arrayBuffer(); } catch { return fail('This file could not be read.'); }
  ask({ type: 'load', buffer, name: file.name, options: options() }, [buffer]);
}

function onMessage(event) {
  const message = event.data;
  if (message.type === 'progress') return setStatus(message.label, 'busy');
  // The self-crossing count arrives a moment after the result, as an extra.
  if (message.type === 'crossings') { if (state.report) { Object.assign(state.report, message); renderCrossings(); } return; }
  clearTimeout(limit);
  if (message.type === 'error') fail(message.message);
  else if (message.type === 'result') showResult(message);
  else if (message.type === 'file') save(message);
}

function showResult(message) {
  const fresh = state.fresh;
  state.fresh = false;
  Object.assign(state, { format: message.format, report: message.report, extent: message.extent, spots: message.spots, spot: -1, reloading: false });
  if (fresh) { state.shown = state.name; state.file = state.pendingFile; }
  state.goodOptions = options();
  $('failure').hidden = true;
  setBusy(false);
  setStatus(`${state.name} · ${number(message.report.before.triangles)} triangles`);
  $('drop').classList.add('compact');
  $('choose-label').textContent = 'Choose another file';
  $('results').hidden = false;
  $('outcome').hidden = false;
  document.body.classList.add('has-results');
  if (fresh) {
    // A GLB is nominally in meters, but many arrive at an arbitrary size, so a height is needed.
    // An STL may already be the right size, so it is left alone unless asked.
    $('set-height').checked = message.format === 'glb';
    // Side by side needs room; on a narrow screen start with the repaired model.
    state.which = $('canvas').clientWidth >= 520 ? 'both' : 'after';
  }
  // After a clean result the explanation and questions step aside; they come back if
  // something needs explaining.
  document.body.classList.toggle('outcome-clean', message.report.status !== 'partial');
  showOutcomeBadge();
  renderOutcome();
  placeTop(); // after the card has its words, because its height sets where the top block pins
  renderCounts();
  renderChanges();
  renderSize();
  viewer?.setModel(message);
  show(state.which);
  leaveCloseUp(false);
  if (fresh) { viewer?.home(); $('outcome-title').focus({ preventScroll: true }); toTop(); sound.play(message.report.status); }
}

function renderOutcome() {
  const r = state.report, after = r.after;
  $('outcome').className = 'outcome ' + r.status;
  const reasons = [];
  if (r.status === 'repaired') {
    $('outcome-title').textContent = 'Repaired';
    $('outcome-detail').textContent = 'No open or non-manifold edges remain, and neighboring faces agree on which way is out. Models repaired this way have imported into Bambu Studio without a mesh warning.';
  } else if (r.status === 'sound') {
    $('outcome-title').textContent = 'Nothing to fix';
    $('outcome-detail').textContent = 'This model has no open or non-manifold edges, and its faces already agree on which way is out.';
  } else {
    $('outcome-title').textContent = 'Partly repaired';
    const left = [after.openEdges && plural(after.openEdges, 'open edge'), after.nonManifoldEdges && plural(after.nonManifoldEdges, 'non-manifold edge'), after.inconsistentEdges && plural(after.inconsistentEdges, 'wrongly facing join')].filter(Boolean);
    const total = after.openEdges + after.nonManifoldEdges + after.inconsistentEdges;
    $('outcome-detail').textContent = `${left.join(' and ')} remain${total === 1 ? 's' : ''}. Your slicer will probably still warn about this file.`;
    const large = r.holesLeftOpen.filter(item => typeof item === 'number');
    if (large.length) reasons.push(`${plural(large.length, 'hole')} too large to patch safely (${large.map(size => size + ' edges').join(', ')}) ${large.length === 1 ? 'was' : 'were'} left open.`);
    if (r.pinchedEdgesLeft && !options().separatePinches) reasons.push(`Surfaces touch along ${plural(r.pinchedEdgesLeft, 'edge')} and were left as they are. To cut them apart, turn on "Separate surfaces that touch along an edge" under Repair options.`);
    const off = Object.entries(options()).filter(([key, on]) => !on && key !== 'separatePinches').length;
    if (off) reasons.push('Some repair steps are turned off under Repair options.');
    if (!reasons.length) reasons.push('This model has a kind of damage this page does not repair. A general repair tool may do better.');
  }
  $('outcome-reasons').replaceChildren(...reasons.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  const anyway = r.status === 'partial';
  // The orange button is a promise that the file is ready, so it steps down when it is not.
  for (const split of document.querySelectorAll('[data-split]')) {
    split.classList.toggle('anyway', anyway);
    split.querySelector('.download-label').textContent = anyway ? 'Download all anyway' : 'Download all';
  }
}

function renderCounts() {
  const { before, after } = state.report;
  const rows = [
    ['Open edges', before.openEdges, after.openEdges, true],
    ['Non-manifold edges', before.nonManifoldEdges, after.nonManifoldEdges, true],
    ['Wrongly facing joins', before.inconsistentEdges, after.inconsistentEdges, true],
    ['Separate pieces', before.shells, after.shells, false],
    ['Triangles', before.triangles, after.triangles, false],
  ];
  $('counts').replaceChildren(...rows.map(([label, was, now, fault]) => {
    const row = document.createElement('tr');
    row.append(Object.assign(document.createElement('th'), { scope: 'row', textContent: label }),
      Object.assign(document.createElement('td'), { textContent: number(was) }),
      Object.assign(document.createElement('td'), { textContent: number(now), className: fault ? (now === 0 ? 'zero' : 'left') : '' }));
    return row;
  }));
}

function renderChanges() {
  const r = state.report;
  const lines = [];
  if (r.strayFacesRemoved) lines.push(`Removed ${plural(r.strayFacesRemoved, 'stray triangle')} stuck to the surface.`);
  if (r.specksRemoved) lines.push(`Removed ${plural(r.specksRemoved, 'tiny loose speck')}.`);
  if (r.duplicateRemoved + r.degenerateRemoved) lines.push(`Removed ${plural(r.duplicateRemoved + r.degenerateRemoved, 'duplicate or collapsed triangle')}.`);
  if (r.holesFilled.length) lines.push(`Patched ${plural(r.holesFilled.length, 'small hole')} with ${plural(r.trianglesAdded, 'new triangle')}.`);
  if (r.pinchedEdgesCut) lines.push(`Separated surfaces that touched along ${plural(r.pinchedEdgesCut, 'edge')}.`);
  if (r.facesFlipped) lines.push(`Turned ${plural(r.facesFlipped, 'triangle')} to face outward.`);
  if (!lines.length) lines.push('Nothing. The model is exactly as it was.');
  else lines.push('No existing point of the model was moved.');
  $('changes').replaceChildren(...lines.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  renderCrossings();
  const changed = r.strayFacesRemoved + r.trianglesAdded + r.specksRemoved + r.facesFlipped + r.duplicateRemoved + r.degenerateRemoved + r.pinchedEdgesCut > 0;
  $('view-hint').textContent = changed ? 'Solid dots mark changes on the side facing you; faint dots are on the far side. Most changes are too small to see from here, so use the arrows to visit each one, shown with a ring around it.' : '';
}

function renderCrossings() {
  const r = state.report, crossing = r.crossingsAfter;
  $('crossings').textContent = crossing
    ? `For information: the surface passes through itself in ${plural(crossing, 'place')}${r.crossingsBefore === crossing ? ', as it did before the repair' : ` (${number(r.crossingsBefore)} before the repair)`}. This is common in sculpted and scanned models, and slicers usually accept it.`
    : '';
}

function heightMm() {
  if (!$('set-height').checked) return 0;
  const value = Number($('height').value);
  return value > 0 && Number.isFinite(value) ? value : 0;
}

function renderSize() {
  const [x, y, z] = state.extent;
  const height = heightMm();
  $('height').disabled = !$('set-height').checked;
  const fixed = value => (value >= 100 ? value.toFixed(0) : value.toFixed(1));
  if (height && z > 0) {
    const scale = height / z;
    $('size').textContent = `Will be ${fixed(x * scale)} × ${fixed(y * scale)} × ${fixed(z * scale)} mm (width × depth × height).`;
  } else {
    $('size').textContent = `Stored size ${fixed(x)} × ${fixed(y)} × ${fixed(z)}. ${state.format === 'glb' ? 'A GLB often has no real-world size, so choose a height.' : 'An STL file does not say what unit this is; most slicers read it as millimeters.'}`;
  }
}

function renderStepper() {
  const kinds = state.which === 'before' ? ['removed'] : state.which === 'after' ? ['added', 'flipped'] : ['removed', 'added', 'flipped'];
  const list = state.spots.filter(spot => kinds.includes(spot.kind));
  state.visible = list;
  state.spot = -1;
  $('stepper').hidden = list.length === 0;
  $('step-label').textContent = list.length ? `${plural(list.length, 'change')} here` : '';
}

function step(direction) {
  const list = state.visible || [];
  if (!list.length || !viewer) return;
  // Remember where the visitor was looking before the first close-up, to return there.
  if (!state.returnTo) { state.returnTo = viewer.getCamera(); $('back').hidden = false; $('home').hidden = true; }
  state.spot = (state.spot + direction + list.length) % list.length;
  viewer.focus(list[state.spot]);
  $('step-label').textContent = `Change ${state.spot + 1} of ${list.length}`;
}

/** Leave a close-up. With `restore`, go back to the view the visitor had before it. */
function leaveCloseUp(restore = true) {
  if (restore && state.returnTo) viewer?.setCamera(state.returnTo);
  state.returnTo = null;
  $('back').hidden = true;
  $('home').hidden = false;
  if (state.report) renderStepper();
}

function show(which) {
  state.which = which;
  for (const name of ['before', 'after', 'both']) $(`show-${name}`).setAttribute('aria-pressed', String(which === name));
  document.querySelector('.stage').classList.toggle('split', which === 'both');
  viewer?.show(which);
  renderStepper();
}

function save(message) {
  setBusy(false);
  setStatus(`${state.shown} · ${number(state.report.before.triangles)} triangles`);
  const base = state.shown.replace(/\.[^.]+$/, '') || 'model';
  const blob = new Blob([message.bytes], { type: { zip: 'application/zip', '3mf': 'model/3mf', stl: 'model/stl' }[message.format] });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${base}-mended.${message.format}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10 * 60_000); // long enough for a slow save dialog
}

function download(format) {
  if (!state.report || state.busy) return;
  setBusy(true);
  ask({ type: 'export', format, heightMm: heightMm(), title: state.shown.replace(/\.[^.]+$/, '') || 'model' });
}

// --- wiring
$('choose').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', event => { sound.prime(); openFile(event.target.files[0]); event.target.value = ''; });
// Dropping anywhere works, and a missed drop never navigates away from the page.
let depth = 0;

// While a file is held over the page the browser reveals its type but not its name.
// Models usually arrive with no type at all, so only a type that is clearly something
// else (a picture, a PDF, a ZIP) is treated as wrong before the drop. Anything unclear
// is judged properly once it is dropped.
const MODEL_TYPES = ['', 'model/stl', 'model/x.stl-binary', 'model/x.stl-ascii', 'model/gltf-binary', 'application/sla', 'application/vnd.ms-pki.stl', 'application/octet-stream'];
function clearlyWrong(transfer) {
  const files = [...(transfer?.items || [])].filter(item => item.kind === 'file');
  return files.length > 0 && files.every(item => !MODEL_TYPES.includes(item.type));
}
function setDragging(on, wrong = false) {
  // Two faces of the card are stacked: the invitation with its button, and the refusal.
  // The classes cross-fade between them; nothing is swapped abruptly.
  document.body.classList.toggle('dragging', on);
  document.body.classList.toggle('drag-wrong', on && wrong);
  $('drop-refuse').setAttribute('aria-hidden', String(!(on && wrong)));
}
window.addEventListener('dragenter', event => { event.preventDefault(); depth++; setDragging(true, clearlyWrong(event.dataTransfer)); });
window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); });
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => {
  event.preventDefault();
  sound.prime(); // dropping a file is the visitor's action, so sound may follow
  depth = 0;
  setDragging(false);
  openFile(event.dataTransfer?.files?.[0]);
});
$('show-before').addEventListener('click', () => show('before'));
$('show-after').addEventListener('click', () => show('after'));
$('show-both').addEventListener('click', () => show('both'));
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('home').addEventListener('click', () => { viewer?.home(); renderStepper(); });
$('back').addEventListener('click', () => { leaveCloseUp(); $('next').focus(); });
$('set-height').addEventListener('change', renderSize);
$('height').addEventListener('input', renderSize);
$('rotate').addEventListener('click', () => { if (state.report && !state.busy) { setBusy(true); ask({ type: 'rotate' }); } });
for (const button of document.querySelectorAll('[data-download]')) button.addEventListener('click', () => { closeMenus(); download(button.dataset.download); });

// The arrow beside "Download all" opens a short menu of single formats.
function closeMenus(focusCaret = false) {
  for (const split of document.querySelectorAll('[data-split]')) {
    const menu = split.querySelector('.split-menu'), caret = split.querySelector('.split-caret');
    if (menu.hidden) continue;
    menu.hidden = true;
    caret.setAttribute('aria-expanded', 'false');
    if (focusCaret) caret.focus();
  }
}
for (const split of document.querySelectorAll('[data-split]')) {
  const menu = split.querySelector('.split-menu'), caret = split.querySelector('.split-caret');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  caret.addEventListener('click', () => {
    const open = menu.hidden;
    closeMenus();
    if (!open) return;
    menu.hidden = false;
    caret.setAttribute('aria-expanded', 'true');
    items[0].focus();
  });
  menu.addEventListener('keydown', event => {
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    } else if (event.key === 'Escape') { event.stopPropagation(); closeMenus(true); }
    else if (event.key === 'Tab') closeMenus();
  });
}
document.addEventListener('click', event => { if (!event.target.closest('[data-split]')) closeMenus(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menuOpen = [...document.querySelectorAll('.split-menu')].some(menu => !menu.hidden);
  if (menuOpen) closeMenus(true);
  else if (state.returnTo) leaveCloseUp();
});

// Sound: browsers allow it only after the visitor has done something on the page.
for (const type of ['pointerdown', 'pointerup', 'click', 'touchend', 'keydown']) window.addEventListener(type, () => sound.prime(), { passive: true });
for (const input of document.querySelectorAll('[data-option]')) {
  input.addEventListener('change', () => {
    if (!state.report || state.busy) return;
    setBusy(true);
    $('failure').hidden = true;
    placeTop();
    setBadge('working', 'Working on this device');
    setStatus('Repairing again', 'busy');
    ask({ type: 'options', options: options() });
  });
}
$('outcome-title').tabIndex = -1;

// The halftone dots that follow the pointer across the orange card, as on heyhaigh.ai.
if (matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)').matches) {
  const card = $('drop');
  const points = [[-200, -200], [-200, -200], [-200, -200]];
  let target = null, running = false;
  const tick = () => {
    if (!target) { running = false; return; }
    const ease = [0.35, 0.2, 0.12];
    let lead = target;
    points.forEach((point, i) => {
      point[0] += (lead[0] - point[0]) * ease[i];
      point[1] += (lead[1] - point[1]) * ease[i];
      card.style.setProperty(`--trail-x${i}`, `${point[0].toFixed(1)}px`);
      card.style.setProperty(`--trail-y${i}`, `${point[1].toFixed(1)}px`);
      lead = point;
    });
    requestAnimationFrame(tick);
  };
  card.addEventListener('pointermove', event => {
    const box = card.getBoundingClientRect();
    const first = !target;
    target = [event.clientX - box.left, event.clientY - box.top];
    if (first) points.forEach(point => { point[0] = target[0]; point[1] = target[1]; });
    card.classList.add('has-pointer-trail');
    if (!running) { running = true; requestAnimationFrame(tick); }
  });
  card.addEventListener('pointerleave', () => { target = null; card.classList.remove('has-pointer-trail'); });
}
