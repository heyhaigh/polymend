// Page behaviour: take a file, hand it to the worker, show what it found and did.

import { createViewer } from './viewer.js';
import { VERSION } from '../src/output.js';
import * as sound from './sound.js';
import { FAILURES, MAX_BYTES } from './messages.js';

const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-US');
const plural = (count, one, many = one + 's') => `${number(count)} ${count === 1 ? one : many}`;

const state = { name: '', format: '', unit: null, notes: [], report: null, extent: [0, 0, 0], spots: [], spot: -1, busy: false, which: 'after', turns: 0 };
const viewer = createViewer($('canvas'));
if (!viewer) { $('canvas').hidden = true; $('no-webgl').hidden = false; }
if ($('version')) $('version').textContent = `Version ${VERSION}.`; // absent from the embedded page

// The model is drawn in a warm clay grey that sits on either theme's stage.
const theme = window.polymendTheme;
const surface = dark => (dark ? [0.66, 0.68, 0.71] : [0.76, 0.74, 0.70]);
viewer?.setSurface(surface(theme?.isDark()));
theme?.onChange(dark => viewer?.setSurface(surface(dark)));

// A normal model takes about a second. Anything still running after a minute is stuck
// or far outside what this page repairs, so the work is stopped and the user is told.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const EMBED = document.documentElement.hasAttribute('data-embed');
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
    state.file.arrayBuffer().then(buffer => { setBusy(true); ask({ type: 'load', buffer, name: state.shown, options: state.goodOptions, turns: state.turns }, [buffer]); }).catch(() => {});
    return;
  }
  state.reloading = false;
  state.report = null;
  $('results').hidden = true;
  $('outcome').hidden = true;
  if (EMBED) $('results').before($('top-stick')); // back above the view
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

/**
 * An outcome, good or bad, takes the place of the title and description. Once a model is
 * on the page the title stays away even if the card has been dismissed.
 */
function placeTop() {
  document.body.classList.toggle('has-outcome', !$('failure').hidden || !$('outcome').hidden || !!($('batch') && !$('batch').hidden) || document.body.classList.contains('has-results'));
  placeSticky();
}
// The X in a card's corner puts it away; the next result or refusal brings a card back.
for (const button of document.querySelectorAll('[data-dismiss]')) {
  button.addEventListener('click', () => { button.closest('.outcome').hidden = true; placeTop(); });
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
  // The file that failed is forgotten. Without this, the next change to the model still
  // on the page would be taken for that file arriving, and the model would get its name.
  state.fresh = false;
  state.pendingFile = null;
  if (state.report) state.name = state.shown;
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

/**
 * Load one model into the view. A file the visitor chose on its own ends any batch; a
 * batch row opened for a look (`fromBatch`) arrives quietly, with no chime and no jump.
 */
async function openFile(file, { fromBatch = false, turns = 0 } = {}) {
  if (!file || state.busy) return;
  if (file.size > MAX_BYTES) return fail(FAILURES.tooLarge.detail, FAILURES.tooLarge.title);
  if (!fromBatch) clearBatch();
  state.name = file.name;
  state.pendingFile = file;
  state.fresh = true;
  state.fromBatch = fromBatch;
  setBusy(true);
  // With no model on the page, an earlier failure stays, dimmed, until the new outcome
  // replaces it. Hiding it would bring the title back for a moment and shift the page twice.
  if ($('outcome').hidden) $('failure').classList.add('stale'); else $('failure').hidden = true;
  placeTop();
  setBadge('working', 'Working on this device');
  setStatus(`Reading ${file.name}`, 'busy');
  let buffer;
  try { buffer = await file.arrayBuffer(); } catch { return fail('This file could not be read.'); }
  ask({ type: 'load', buffer, name: file.name, options: options(), turns }, [buffer]);
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
  Object.assign(state, { format: message.format, unit: message.unit, notes: message.notes || [], report: message.report, extent: message.extent, spots: message.spots, spot: -1, reloading: false });
  const quiet = fresh ? state.fromBatch : state.quietShown;
  if (fresh) { state.shown = state.name; state.file = state.pendingFile; state.turns = batch.rows[batch.at]?.turns || 0; state.quietShown = quiet; }
  $('outcome-label').textContent = quiet ? `Outcome · ${state.shown}` : 'Outcome';
  if (quiet) keepRow(message);
  state.goodOptions = options();
  $('failure').hidden = true;
  setBusy(false);
  setStatus(`${state.shown} · ${number(message.report.before.triangles)} triangles`);
  $('drop').classList.add('compact');
  $('choose-label').textContent = quiet ? 'Choose other files' : 'Choose another file';
  $('results').hidden = false;
  $('outcome').hidden = false;
  document.body.classList.add('has-results');
  // In a short frame the comparison matters most, so there it comes first and the outcome
  // card and the file strip follow it.
  if (EMBED) document.querySelector('.view').after($('top-stick'));
  if (fresh && !quiet) {
    // A GLB is nominally in meters, but many arrive at an arbitrary size, so a height is needed.
    // An STL may already be the right size, so it is left alone unless asked.
    $('set-height').checked = message.format === 'glb';
    // Side by side needs room; on a narrow screen start with the repaired model.
    state.which = $('canvas').clientWidth >= 520 ? 'both' : 'after';
  }
  // After a clean result the explanation and questions step aside; they come back if
  // something needs explaining.
  document.body.classList.toggle('outcome-clean', message.report.status !== 'partial');
  // In a batch the pinned badge speaks for the whole batch, not the one model in view.
  if (quiet) setBatchBadge(); else showOutcomeBadge();
  renderOutcome();
  placeTop(); // after the card has its words, because its height sets where the top block pins
  renderCounts();
  renderChanges();
  renderSize();
  viewer?.setModel(message);
  show(state.which);
  leaveCloseUp(false);
  if (fresh) viewer?.home();
  if (fresh && !quiet) { $('outcome-title').focus({ preventScroll: true }); toTop(); sound.play(message.report.status); }
}

/** The outcome card: the verdict, then anything the visitor should know before trusting it. */
function renderOutcome() {
  const r = state.report, after = r.after;
  $('outcome').className = 'outcome ' + r.status;
  const notes = [];
  // What was taken away or added is said here, beside the verdict, not only further down.
  const did = [
    r.degenerateRemoved + r.duplicateRemoved && `removed ${plural(r.degenerateRemoved + r.duplicateRemoved, 'collapsed or duplicate triangle')}`,
    r.strayFacesRemoved && `removed ${plural(r.strayFacesRemoved, 'stray triangle')}`,
    r.specksRemoved && `removed ${plural(r.specksRemoved, 'small separate piece')}`,
    r.holesFilled.length && `patched ${plural(r.holesFilled.length, 'hole')}`,
    r.seamPointsJoined && `joined ${plural(r.seamPointsJoined, 'pair')} of seam points`,
    r.pinchedEdgesCut && `separated surfaces along ${plural(r.pinchedEdgesCut, 'edge')}`,
    r.facesFlipped && `turned ${plural(r.facesFlipped, 'triangle')} to face outward`,
  ].filter(Boolean);
  if (did.length) notes.push(`Polymend ${list(did)}. ${r.seamPointsJoined ? 'Apart from the joined seam points, no' : 'No'} existing point of the model was moved. The markers in the view show where.`);
  if (r.specksRemoved) notes.push(`${r.specksRemoved === 1 ? 'The small separate piece was' : 'The small separate pieces were'} closed and under 2% of the model's size, which is usually debris. If ${r.specksRemoved === 1 ? 'it was' : 'they were'} part of your design, turn off "Remove tiny loose specks" under Repair options.`);
  // A rigged or animated model has many poses; say which one this is.
  if (state.notes.length) {
    const has = [state.notes.includes('rigged') && 'a rig', state.notes.includes('animated') && 'animation', state.notes.includes('morphs') && 'blend shapes'].filter(Boolean);
    notes.push(`This GLB has ${list(has)}. It was read in its rest pose: the shape stored in the file, before ${state.notes.includes('animated') ? 'any animation plays' : 'anything moves it'}. That one pose is what was checked here and what you will download.`);
  }
  if (r.patchesCrossing) notes.push(`${plural(r.patchesCrossing, 'patch', 'patches')} had no clean way to close ${r.patchesCrossing === 1 ? 'its' : 'their'} hole and ${r.patchesCrossing === 1 ? 'grazes' : 'graze'} surface that runs close by. This is common where a sculpted model already overlaps itself, and slicers accept it. Step through the changes to look.`);

  if (r.status === 'repaired') {
    $('outcome-title').textContent = 'Repaired';
    $('outcome-detail').textContent = 'No open or non-manifold edges remain, and neighboring faces agree on which way is out. In testing, every model that reached this result passed a second slicer\'s mesh check, and the figure models also imported into Bambu Studio without a warning.';
  } else if (r.status === 'sound') {
    $('outcome-title').textContent = 'Nothing to fix';
    $('outcome-detail').textContent = 'This model has no open or non-manifold edges, and its faces already agree on which way is out. It was left exactly as it is.';
  } else {
    $('outcome-title').textContent = 'Partly repaired';
    const left = [after.openEdges && plural(after.openEdges, 'open edge'), after.nonManifoldEdges && plural(after.nonManifoldEdges, 'non-manifold edge'), after.inconsistentEdges && plural(after.inconsistentEdges, 'wrongly facing join')].filter(Boolean);
    const total = after.openEdges + after.nonManifoldEdges + after.inconsistentEdges;
    $('outcome-detail').textContent = left.length
      ? `${list(left)} remain${total === 1 ? 's' : ''}. Your slicer will probably still warn about this file.`
      : 'The edge checks pass, but this file is not a printable solid.';
    const why = [];
    const count = reason => r.holesLeftOpen.filter(item => item === reason).length;
    const large = r.holesLeftOpen.filter(item => typeof item === 'number');
    if (large.length) why.push(`${plural(large.length, 'hole')} too large to patch safely (${large.map(size => size + ' edges').join(', ')}) ${large.length === 1 ? 'was' : 'were'} left open.`);
    const wide = count('wide');
    if (wide) why.push(`${plural(wide, 'opening')} ${wide === 1 ? 'is' : 'are'} too wide to count as a small hole and ${wide === 1 ? 'was' : 'were'} left open, in case ${wide === 1 ? 'it is' : 'they are'} meant, like the top of a vase. To close ${wide === 1 ? 'it' : 'them'} anyway, turn on "Close wide openings too" under Repair options.`);
    const cutting = count('would cut through the surface');
    if (cutting) why.push(`${plural(cutting, 'hole')} ${cutting === 1 ? 'was' : 'were'} left open because every way of closing ${cutting === 1 ? 'it' : 'them'} would cut through the model.`);
    const awkward = r.holesLeftOpen.length - large.length - wide - cutting;
    if (awkward > 0) why.push(`${plural(awkward, 'hole')} ${awkward === 1 ? 'has' : 'have'} a shape this page cannot patch.`);
    if (r.sheetsLeft) why.push(`${plural(r.sheetsLeft, 'thin sheet')} with no thickness ${r.sheetsLeft === 1 ? 'is' : 'are'} attached to the model. A sheet cannot print as it is, and ${r.sheetsLeft === 1 ? 'this one is' : 'these are'} too large to be a stray scrap, so ${r.sheetsLeft === 1 ? 'it was' : 'they were'} left alone.`);
    if (r.flatPieces) why.push(`${plural(r.flatPieces, 'piece')} ${r.flatPieces === 1 ? 'is' : 'are'} flat, with no inside, and cannot be printed.`);
    if (r.pinchedEdgesLeft && !options().separatePinches) why.push(`${plural(r.pinchedEdgesLeft, 'edge')} ${r.pinchedEdgesLeft === 1 ? 'is' : 'are'} shared by more than two surfaces, as happens where two parts touch along an edge or a wall sits inside the model. ${r.pinchedEdgesLeft === 1 ? 'It was' : 'They were'} left as ${r.pinchedEdgesLeft === 1 ? 'it is' : 'they are'}. If parts are only touching, "Separate surfaces that touch along an edge" under Repair options will cut them apart.`);
    const off = Object.entries(options()).filter(([key, on]) => !on && !OFF_BY_DEFAULT.includes(key)).length;
    if (off) why.push('Some repair steps are turned off under Repair options.');
    if (!why.length) why.push('This model has a kind of damage this page does not repair. A general repair tool may do better.');
    notes.unshift(...why);
  }
  $('outcome-reasons').replaceChildren(...notes.map(text => Object.assign(document.createElement('li'), { textContent: text })));
  const anyway = r.status === 'partial';
  // The orange button is a promise that the file is ready, so it steps down when it is not.
  for (const split of document.querySelectorAll('[data-split]')) {
    split.classList.toggle('anyway', anyway);
    split.querySelector('.download-label').textContent = anyway ? 'Download all anyway' : 'Download all';
  }
}

// Switches that are off unless the visitor turns them on; being off is not "a step turned off".
const OFF_BY_DEFAULT = ['separatePinches', 'patchWide'];

/** "a", "a and b", "a, b and c". */
const list = items => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function renderCounts() {
  const r = state.report, { before, after } = r;
  const rows = [
    ['Open edges', before.openEdges, after.openEdges, true],
    ['Non-manifold edges', before.nonManifoldEdges, after.nonManifoldEdges, true],
    ['Wrongly facing joins', before.inconsistentEdges, after.inconsistentEdges, true],
    ['Holes', r.holes ? r.holes.flat + r.holes.curved : 0, r.holesLeftOpen.length, true],
    ['Duplicate triangles', r.duplicateRemoved, 0, true],
    ['Collapsed triangles', before.degenerate, after.degenerate, true],
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

/** The hint under the view, and the information lines. What changed is said on the outcome card. */
function renderChanges() {
  const r = state.report;
  renderCrossings();
  const changed = r.strayFacesRemoved + r.trianglesAdded + r.specksRemoved + r.facesFlipped + r.duplicateRemoved + r.degenerateRemoved + r.pinchedEdgesCut + r.seamPointsJoined > 0;
  $('view-hint').textContent = changed ? 'Solid dots mark changes on the side facing you; faint dots are on the far side. Most changes are too small to see from here, so use the arrows to visit each one, shown with a ring around it.' : '';
}

function renderCrossings() {
  const r = state.report, now = r.crossingsAfter, was = r.crossingsBefore;
  let text = '';
  if (r.crossingsSkipped) text = 'Not checked: whether the surface passes through itself. This model is too large or too tangled for that check to finish quickly. It does not affect the repair.';
  else if (now === undefined) text = 'Checking whether the surface passes through itself…';
  else if (now) {
    text = `The surface passes through itself in ${plural(now, 'place')}${was === now ? ', as it did before the repair' : ` (${number(was)} before the repair)`}. Polymend counts these but does not repair them.`
      + (now > was ? ' The extra ones are where a patch had to pass close to nearby surface.' : '')
      + ' In a slicer\'s preview they can show as small dark triangles or flecks on the surface; those are not holes, and they print as solid. Sculpted and scanned models often have them and most slicers cope, but they can cause flawed layers. If a print goes wrong at one, a general repair tool or a 3D editor is the next step.';
  }
  // Also for information: places where the surface pinches down to a single point.
  if (r.pointsTouching) text = `The surface pinches to a single point in ${plural(r.pointsTouching, 'place')}, where two parts just touch. Slicers generally accept this.` + (text ? ' ' + text : '');
  $('crossings').textContent = text;
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
    // A GLB's numbers are meters by definition, so with no height they become millimeters x 1000.
    const mm = state.unit === 'meter' ? 1000 : 1;
    $('size').textContent = state.unit === 'meter'
      ? `Will be ${number(Math.round(x * mm))} × ${number(Math.round(y * mm))} × ${number(Math.round(z * mm))} mm. With no height set, the file's own size is used, and a GLB is measured in meters. Many GLB files have no real-world size, so a height is usually what you want.`
      : `Stored size ${fixed(x)} × ${fixed(y)} × ${fixed(z)}. An STL file does not say what unit this is; most slicers read it as millimeters.`;
  }
}

function renderStepper() {
  const kinds = state.which === 'before' ? ['removed'] : state.which === 'after' ? ['added', 'flipped'] : ['removed', 'added', 'flipped'];
  const list = state.spots.filter(spot => kinds.includes(spot.kind));
  state.visible = list;
  state.spot = -1;
  $('stepper').hidden = list.length === 0;
  $('step-label').textContent = list.length ? number(list.length) : '';
  $('stepper').setAttribute('aria-label', list.length ? `${plural(list.length, 'change')}: step through them` : 'Changes');
}

function step(direction) {
  const list = state.visible || [];
  if (!list.length || !viewer) return;
  // Remember where the visitor was looking before the first close-up, to return there.
  if (!state.returnTo) { state.returnTo = viewer.getCamera(); $('back').hidden = false; $('home').hidden = true; }
  state.spot = (state.spot + direction + list.length) % list.length;
  viewer.focus(list[state.spot]);
  $('step-label').textContent = `${state.spot + 1} / ${list.length}`;
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

// --- several files at once
// A batch is repaired one file at a time in a worker of its own, so the view stays free to
// look at any finished model. The page keeps each repaired model; the worker keeps nothing,
// so a stuck or crashed file costs only its own row. The embedded page takes one file.
const BATCH_FILES = 20;
const BATCH_BYTES = 1024 ** 3;
const MODEL_NAME = /\.(glb|stl)$/i;
const STATUS_WORDS = { waiting: 'Waiting', working: 'Repairing', repaired: 'Repaired', sound: 'Nothing to fix', partial: 'Partly repaired', failed: 'Not repaired' };
const batch = { rows: [], skipped: [], at: -1, running: false, exporting: false, worker: null, timer: 0 };

/** Files chosen or dropped: one goes to the view as before; several become a batch. */
function takeFiles(files) {
  if (!files.length) return;
  if (EMBED || files.length === 1) return openFile(files[0]);
  if (batch.running || batch.exporting || state.busy) return;
  const models = files.filter(file => MODEL_NAME.test(file.name));
  const skipped = files.filter(file => !MODEL_NAME.test(file.name)).map(file => file.name);
  if (!models.length) return fail('None of these files is a .glb or .stl file.');
  if (models.length === 1) return openFile(models[0]);
  if (models.length > BATCH_FILES) return fail(`Polymend takes up to ${BATCH_FILES} files at a time, and these are ${models.length}. Choose ${BATCH_FILES} or fewer and try again.`, 'Too many files at once');
  const total = models.reduce((sum, file) => sum + file.size, 0);
  if (total > BATCH_BYTES) return fail(`These files come to ${(total / 1024 ** 3).toFixed(1)} GB together, and a batch can be up to 1 GB in all. Choose fewer, or smaller, files.`, 'Too much at once');
  startBatch(models, skipped);
}

function startBatch(files, skipped) {
  forgetModel();
  $('failure').hidden = true;
  // One height for the whole batch, set under Size. GLB files rarely carry a real size, so
  // a height is on when any of them is a GLB.
  $('set-height').checked = files.some(file => /\.glb$/i.test(file.name));
  // Two files with the same name would write over each other in the ZIP; later ones get a number.
  const seen = new Map();
  batch.rows = files.map(file => {
    const base = file.name.replace(MODEL_NAME, '') || 'model';
    const count = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), count);
    return { file, title: count > 1 ? `${base}-${count}` : base, status: 'waiting', turns: 0 };
  });
  batch.skipped = skipped;
  batch.at = -1;
  batch.running = true;
  $('batch').hidden = false;
  $('choose-label').textContent = 'Choose other files';
  $('drop').classList.add('compact');
  setBadge('working', 'Working on this device');
  placeTop();
  renderBatch();
  toTop();
  nextInBatch();
}

/** A file chosen on its own replaces the batch. */
function clearBatch() {
  if (!batch.rows.length && !batch.running) return;
  if (batch.running) { batch.worker?.terminate(); batch.worker = null; clearTimeout(batch.timer); }
  Object.assign(batch, { rows: [], skipped: [], at: -1, running: false });
  $('batch').hidden = true;
  $('outcome-label').textContent = 'Outcome';
  placeTop();
}

/** Clear the view before a batch: the batch card takes its place until a row is opened. */
function forgetModel() {
  state.report = null;
  state.quietShown = false;
  $('results').hidden = true;
  $('outcome').hidden = true;
  document.body.classList.remove('has-results', 'outcome-clean');
}

function batchWorker() {
  if (batch.worker) return batch.worker;
  batch.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  batch.worker.onmessage = onBatchMessage;
  batch.worker.onerror = () => batchLost(FAILURES.crashed.detail);
  return batch.worker;
}

/** The batch worker stopped or was stopped. The file it held fails; the rest carry on. */
function batchLost(reason) {
  clearTimeout(batch.timer);
  batch.worker?.terminate();
  batch.worker = null;
  if (batch.exporting) { batch.exporting = false; setStatus(''); renderBatch(); return fail(reason, FAILURES.crashed.title); }
  const row = batch.rows.find(item => item.status === 'working');
  if (row) Object.assign(row, { status: 'failed', error: reason });
  nextInBatch();
}

async function nextInBatch() {
  const row = batch.rows.find(item => item.status === 'waiting');
  if (!row) return finishBatch();
  row.status = 'working';
  renderBatch();
  if (row.file.size > MAX_BYTES) { Object.assign(row, { status: 'failed', error: FAILURES.tooLarge.detail }); return nextInBatch(); }
  let buffer;
  try { buffer = await row.file.arrayBuffer(); } catch { Object.assign(row, { status: 'failed', error: 'This file could not be read.' }); return nextInBatch(); }
  if (!batch.running) return; // the batch was replaced while the file was being read
  batch.timer = setTimeout(() => batchLost(FAILURES.timedOut.detail), LIMIT_MS);
  batchWorker().postMessage({ type: 'batch-repair', buffer, name: row.file.name, options: options() }, [buffer]);
}

function onBatchMessage(event) {
  const message = event.data;
  if (message.type === 'progress') return;
  clearTimeout(batch.timer);
  if (message.type === 'batch-file') return saveBatchFile(message);
  if (batch.exporting && message.type === 'error') { batch.exporting = false; renderBatch(); setStatus(''); return fail(message.message); }
  const row = batch.rows.find(item => item.status === 'working');
  if (!row) return;
  if (message.type === 'error') Object.assign(row, { status: 'failed', error: message.message });
  else Object.assign(row, { status: message.report.status, report: message.report, format: message.format, unit: message.unit, notes: message.notes, positions: message.positions, tris: message.tris });
  nextInBatch();
}

function setBatchBadge() {
  if (batch.running) return setBadge('working', 'Working on this device');
  const [kind, text] = { failed: ['bad', 'Some files not repaired'], partial: ['warn', 'Partly repaired on this device'], repaired: ['good', 'Repaired on this device'], sound: ['info', 'Checked on this device'] }[batchVerdict()];
  setBadge(kind, text);
}

/** The worst outcome in the batch decides its colour, badge and chime. */
function batchVerdict() {
  const has = status => batch.rows.some(row => row.status === status);
  return has('failed') ? 'failed' : has('partial') ? 'partial' : has('repaired') ? 'repaired' : 'sound';
}

function finishBatch() {
  batch.running = false;
  batch.worker?.terminate(); // a fresh one is made for the download, if one is asked for
  batch.worker = null;
  const verdict = batchVerdict();
  setBatchBadge();
  sound.play(verdict);
  renderBatch();
  // Open the first model that needs a look, or else the first one, in the view below.
  const pick = batch.rows.findIndex(row => row.status === 'partial');
  const first = pick >= 0 ? pick : batch.rows.findIndex(row => row.status !== 'failed');
  if (first >= 0) viewRow(first);
  $('batch-title').focus({ preventScroll: true });
}

function viewRow(index) {
  const row = batch.rows[index];
  if (!row || !row.positions || state.busy) return;
  batch.at = index;
  renderBatch();
  openFile(row.file, { fromBatch: true, turns: row.turns });
}

/** A repair of the model in view (another option, a quarter turn) is the row's model now. */
function keepRow(message) {
  const row = batch.rows[batch.at];
  if (!row) return;
  Object.assign(row, { status: message.report.status, report: message.report, positions: new Float32Array(message.after.positions), tris: new Uint32Array(message.after.tris) });
  renderBatch();
  setBatchBadge();
}

function renderBatch() {
  if (!$('batch')) return;
  const rows = batch.rows;
  const done = rows.filter(row => !['waiting', 'working'].includes(row.status)).length;
  const count = status => rows.filter(row => row.status === status).length;
  const verdict = batch.running ? 'working' : batchVerdict();
  $('batch').className = 'outcome batch ' + (batch.running ? 'sound' : verdict);
  if (batch.running) {
    $('batch-title').textContent = `Repairing ${number(done + 1)} of ${plural(rows.length, 'model')}`;
    $('batch-detail').textContent = 'Each model is repaired on this device, one at a time. Finished ones can be opened below while the rest carry on.';
  } else {
    $('batch-title').textContent = plural(rows.length, 'model');
    const parts = ['repaired', 'sound', 'partial', 'failed'].filter(count).map(status => `${number(count(status))} ${STATUS_WORDS[status].toLowerCase()}`);
    $('batch-detail').textContent = `${list(parts)}.` + (count('partial') ? ' A partly repaired model will probably still bring a warning from your slicer; open it to see why.' : '');
  }
  if (batch.skipped.length) $('batch-detail').textContent += ` Left out, as not .glb or .stl: ${list(batch.skipped)}.`;
  $('batch-list').replaceChildren(...rows.map((row, i) => {
    const item = document.createElement('li');
    item.className = 'batch-row ' + row.status + (i === batch.at ? ' current' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'batch-open';
    open.disabled = !row.positions;
    open.setAttribute('aria-current', String(i === batch.at));
    open.append(Object.assign(document.createElement('span'), { className: 'batch-name', textContent: row.file.name }),
      Object.assign(document.createElement('span'), { className: 'batch-size', textContent: row.report ? `${number(row.report.before.triangles)} triangles` : '' }));
    open.addEventListener('click', () => viewRow(i));
    const badge = Object.assign(document.createElement('span'), { className: 'badge ' + ({ repaired: 'good', sound: 'info', partial: 'warn', failed: 'bad', working: 'working' }[row.status] || 'idle'), textContent: STATUS_WORDS[row.status] });
    if (row.error) badge.title = row.error;
    item.append(open, badge);
    if (row.error) item.append(Object.assign(document.createElement('p'), { className: 'batch-error', textContent: row.error }));
    return item;
  }));
  const ready = rows.filter(row => row.positions).length;
  $('batch-download').disabled = batch.running || batch.exporting || !ready;
  $('batch-download-label').textContent = batch.exporting ? 'Preparing the ZIP' : `Download all ${ready} (ZIP)`;
  renderBatchNote();
}

/** Says what the ZIP will hold, at what size. The height is the one under Size below. */
function renderBatchNote() {
  if (!$('batch-note') || !batch.rows.length) return;
  const height = heightMm();
  $('batch-note').textContent = `An STL and a 3MF of every repaired model, ${height ? `each ${height} mm tall` : 'each at its file\'s own size'}, with a summary. Change the height under Size, below any model.`;
}

function downloadBatch() {
  const ready = batch.rows.filter(row => row.positions);
  if (!ready.length || batch.running || batch.exporting) return;
  batch.exporting = true;
  renderBatch();
  setStatus(`Writing ${plural(ready.length, 'model')} into one ZIP`, 'busy');
  const height = heightMm();
  const summary = [`Polymend ${VERSION}: ${plural(batch.rows.length, 'model')}, ${height ? `each ${height} mm tall` : 'each at its own size'}.`, '',
    ...batch.rows.map(row => `${STATUS_WORDS[row.status].padEnd(16)} ${row.file.name}${row.report ? ` (${number(row.report.before.triangles)} triangles)` : ''}${row.error ? `: ${row.error}` : ''}`)].join('\n') + '\n';
  // Copies go to the worker, so the page keeps its models for another download.
  const models = ready.map(row => ({ title: row.title, unit: row.unit, positions: row.positions.slice(), tris: row.tris.slice() }));
  batch.timer = setTimeout(() => batchLost(FAILURES.timedOut.detail), 5 * LIMIT_MS);
  batchWorker().postMessage({ type: 'batch-export', models, heightMm: height, summary, name: 'polymend-batch.zip' }, models.flatMap(model => [model.positions.buffer, model.tris.buffer]));
}

function saveBatchFile(message) {
  batch.exporting = false;
  renderBatch();
  setStatus(state.report ? `${state.shown} · ${number(state.report.before.triangles)} triangles` : '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([message.bytes], { type: 'application/zip' }));
  link.download = message.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10 * 60_000);
}

// --- wiring
$('choose').addEventListener('click', () => $('file').click());
$('batch-download')?.addEventListener('click', downloadBatch);
$('set-height').addEventListener('change', renderBatchNote);
$('height').addEventListener('input', renderBatchNote);
$('file').addEventListener('change', event => { sound.prime(); takeFiles([...event.target.files]); event.target.value = ''; });
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
  takeFiles([...(event.dataTransfer?.files || [])]);
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
$('rotate').addEventListener('click', () => {
  if (!state.report || state.busy) return;
  setBusy(true);
  state.turns++;
  if (state.quietShown && batch.rows[batch.at]) batch.rows[batch.at].turns = state.turns;
  ask({ type: 'rotate' });
});
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

// The embed code. Three choices rewrite it as they change, so nobody edits it by hand.
// One set of controls serves the page text and the footer's pop-up: it moves into the
// pop-up while that is open. None of this exists on the embedded page itself.
if ($('embed-maker')) {
  const dialog = $('embed-dialog');
  const maker = $('embed-maker');
  const home = document.createComment('embed maker');
  const snippet = $('embed-snippet');
  const write = () => {
    const theme = document.querySelector('[name="embed-theme"]:checked')?.value || '';
    const quiet = !$('embed-sound').checked;
    const height = Math.min(1200, Math.max(200, Math.round(Number($('embed-height').value) || 340)));
    const query = [theme && `theme=${theme}`, quiet && 'sound=off'].filter(Boolean).join('&');
    const attributes = [['src', `https://polymend.xyz/embed${query ? '?' + query : ''}`], ['title', 'Polymend: STL and GLB mesh repair'], ['width', '100%'], ['height', String(height)], ['style', 'border:0;border-radius:12px'], ['loading', 'lazy']];
    // Set as code is set: the tag, the attribute names and the quoted values each in their
    // own tone. Copying takes the text alone.
    const piece = (kind, text) => Object.assign(document.createElement('span'), { className: `code-${kind}`, textContent: text });
    snippet.replaceChildren(piece('punct', '<'), piece('tag', 'iframe'),
      ...attributes.flatMap(([name, value]) => [' ', piece('attr', name), piece('punct', '='), piece('string', `"${value}"`)]),
      piece('punct', '></'), piece('tag', 'iframe'), piece('punct', '>'));
  };
  for (const input of maker.querySelectorAll('input')) input.addEventListener('input', write);
  // The round buttons beside the height step it, as the arrows beside the viewer step through changes.
  for (const button of maker.querySelectorAll('[data-step]')) {
    button.addEventListener('click', () => {
      const field = $('embed-height');
      field.value = Math.min(1200, Math.max(200, (Number(field.value) || 340) + Number(button.dataset.step)));
      write();
    });
  }
  write();
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const source = $(button.dataset.copy);
      let copied = false;
      try { await navigator.clipboard.writeText(source.textContent); copied = true; } catch {}
      if (!copied) { // no clipboard access: select the code, so the visitor's own copy command works
        const range = document.createRange();
        range.selectNodeContents(source);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
      button.textContent = copied ? 'Copied' : 'Selected. Now copy it';
      clearTimeout(button.restore);
      button.restore = setTimeout(() => { button.textContent = 'Copy code'; }, 1800);
    });
  }
  for (const link of document.querySelectorAll('[data-embed-open]')) {
    link.addEventListener('click', event => {
      if (typeof dialog.showModal !== 'function') return; // a very old browser follows the link to the section instead
      event.preventDefault();
      maker.replaceWith(home);
      $('embed-maker-slot').append(maker);
      dialog.showModal();
    });
  }
  dialog.addEventListener('close', () => { home.replaceWith(maker); });
  // The Close button, or a click on the dimmed page around the box.
  dialog.addEventListener('click', event => { if (event.target === dialog || event.target.closest('[data-embed-close]')) dialog.close(); });
}

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
