// Page behaviour: take a file, hand it to the worker, show what it found and did.

import { createViewer } from './viewer.js';
import { VERSION, zipEntry, zipParts, safeFileName } from '../src/output.js';
import * as sound from './sound.js';
import { FAILURES, MAX_BYTES } from './messages.js';

const $ = id => document.getElementById(id);
const number = value => value.toLocaleString('en-US');
const plural = (count, one, many = one + 's') => `${number(count)} ${count === 1 ? one : many}`;

const state = { name: '', format: '', unit: null, notes: [], report: null, extent: [0, 0, 0], spots: [], spot: -1, busy: false, which: 'after', turns: 0, gen: 0 };
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

/**
 * Send work to the worker and start the clock. Every request carries the generation of the
 * model in view, and the worker answers with it; a new model means a new generation, so
 * an answer for an earlier one is dropped before it can touch the page or the clock.
 */
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
  worker.postMessage({ ...message, gen: state.gen }, transfer);
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
    state.gen++;
    state.file.arrayBuffer().then(buffer => { setBusy(true); ask({ type: 'load', buffer, name: state.shown, options: state.goodOptions, turns: state.turns }, [buffer]); }).catch(() => {});
    return;
  }
  state.reloading = false;
  state.report = null;
  $('results').hidden = true;
  $('outcome').hidden = true;
  $('results').before($('top-stick')); // back above, where the upload card belongs
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
  // While a batch model loads quietly, other files can still be chosen. A model whose file
  // could not be read again can be looked at, but not changed or downloaded on its own.
  $('choose').disabled = busy && !state.batchLoading;
  const locked = busy || !!state.unsynced;
  $('rotate').disabled = locked;
  for (const control of document.querySelectorAll('[data-option], [data-download], .split-caret')) control.disabled = locked;
  if (busy) closeMenus();
  if (batch.rows.length && $('model-switch')) renderModelSwitch();
}

/**
 * Something went wrong: say so in its own pink outcome card. If an earlier model is
 * still on the page it stays there, and the card says which one it is.
 */
function fail(message, title = FAILURES.unreadable.title) {
  setBusy(false);
  // The file that failed is forgotten. Without this, the next change to the model still
  // on the page would be taken for that file arriving, and the model would get its name.
  if (!state.batchLoading) {
    state.fresh = false;
    state.pendingFile = null;
    if (state.report) state.name = state.shown;
  }
  const kept = state.report ? ` The model below is still ${state.shown}.` : '';
  $('failure-title').textContent = title;
  $('failure-detail').textContent = message + kept;
  $('failure').classList.remove('stale');
  $('failure').hidden = false;
  document.body.classList.remove('outcome-clean');
  placeTop();
  if (document.body.classList.contains('has-results')) $('failure').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  else toTop();
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
async function openFile(file) {
  if (!file || (state.busy && !state.batchLoading)) return;
  if (file.size > MAX_BYTES) return fail(FAILURES.tooLarge.detail, FAILURES.tooLarge.title);
  clearBatch();
  const gen = ++state.gen;
  state.name = file.name;
  state.pendingFile = file;
  state.fresh = true;
  state.fromBatch = false;
  setBusy(true);
  // With no model on the page, an earlier failure stays, dimmed, until the new outcome
  // replaces it. Hiding it would bring the title back for a moment and shift the page twice.
  if ($('outcome').hidden) $('failure').classList.add('stale'); else $('failure').hidden = true;
  placeTop();
  setBadge('working', 'Working on this device');
  setStatus(`Reading ${file.name}`, 'busy');
  let buffer;
  try { buffer = await file.arrayBuffer(); } catch { if (gen === state.gen) fail('This file could not be read.'); return; }
  if (gen === state.gen) ask({ type: 'load', buffer, name: file.name, options: options() }, [buffer]);
}

function onMessage(event) {
  const message = event.data;
  if (message.gen !== state.gen) return; // for a model no longer in view
  if (message.type === 'progress') return setStatus(message.label, 'busy');
  // The self-crossing count arrives a moment after the result, as an extra.
  if (message.type === 'crossings') {
    if (state.report) { Object.assign(state.report, { crossingsBefore: message.crossingsBefore, crossingsAfter: message.crossingsAfter, crossingsSkipped: message.crossingsSkipped }); renderCrossings(); }
    return;
  }
  clearTimeout(limit);
  if (message.type === 'ready') {
    state.batchLoading = false;
    setBusy(false);
    if (state.report) setStatus(`${state.shown} · ${number(state.report.before.triangles)} triangles`);
    return;
  }
  // A batch model that failed to load here is still on screen from its kept view, but the
  // worker holds another model, so it must not be downloaded on its own.
  if (message.type === 'error' && state.batchLoading) { Object.assign(state, { batchLoading: false, unsynced: true }); }
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
  if (message.type === 'result') state.batchLoading = false; // an answer from the worker, not a kept view
  if (quiet) keepRow(message, !fresh && state.pendingEdit);
  state.pendingEdit = false;
  state.goodOptions = options();
  $('failure').hidden = true;
  setBusy(false);
  setStatus(`${state.shown} · ${number(message.report.before.triangles)} triangles`);
  $('drop').classList.add('compact');
  $('choose-label').textContent = quiet ? 'Choose other files' : 'Choose another file';
  $('results').hidden = false;
  // In a batch the batch card speaks for every model, so the single-model card stays away.
  $('outcome').hidden = quiet;
  document.body.classList.add('has-results');
  // The comparison matters most, so it comes first; the cards and the file strip follow it.
  document.querySelector('.view').after($('top-stick'));
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
    // In a batch, "all" would sound like every model; this button is for the one in view.
    const one = state.quietShown;
    split.querySelector('.download-label').textContent = one ? (anyway ? 'Download this one anyway' : 'Download this one') : (anyway ? 'Download all anyway' : 'Download all');
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
// A batch is worked through one job at a time by a worker of its own: first each model is
// repaired and packed into its two print files, then any model whose files are out of date
// (a new height, or an option or turn changed while it was in view) is packed again. Every
// job carries a token, and an answer whose token is not the current job's is dropped, so a
// late answer from a replaced batch, a stopped job or an old worker can never land on a row.
// The page keeps each model's packed files (as Blobs, which the browser may keep outside
// its own memory) and, within a budget, each model's view, so switching between them is
// instant and "Download all" only has to put the parts together. The embed takes one file.
const BATCH_FILES = 20;
const BATCH_BYTES = 1024 ** 3;
// Kept views make switching instant. Measured: a batch of twenty 300,000-triangle models
// peaks about 1.1 GB above the page's baseline in desktop Chrome, about 220 MB of it views.
// A phone tab is closed at far less, so a phone or a small computer keeps fewer.
const SMALL_DEVICE = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 4);
const VIEW_BUDGET = (SMALL_DEVICE ? 120 : 400) * 1024 ** 2;
const MODEL_NAME = /\.(glb|stl)$/i;
const DONE = ['repaired', 'sound', 'partial'];
const STATUS_WORDS = { waiting: 'Waiting', working: 'Repairing', repaired: 'Repaired', sound: 'Nothing to fix', partial: 'Partly repaired', failed: 'Not repaired' };
const PHONE = matchMedia('(max-width: 640px)');
PHONE.addEventListener?.('change', () => { if (batch.rows.length) renderBatch(); });
const batch = { id: 0, rows: [], skipped: [], at: -1, running: false, worker: null, timer: 0, job: null, jobs: 0, viewBytes: 0 };

/** File names go into text the visitor reads and saves: no control or direction characters. */
const clean = text => String(text).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ');
const viewBytes = view => [view.before.positions, view.before.tris, view.after.positions, view.after.tris, view.removed, view.added, view.flipped].reduce((sum, array) => sum + (array?.byteLength || 0), 0);
const current = row => row.built === row.rev && row.entries;

/** Files chosen or dropped: one goes to the view as before; several become a batch. */
function takeFiles(files) {
  if (!files.length) return;
  if (EMBED || files.length === 1) return openFile(files[0]);
  if (state.busy && !state.batchLoading) return; // a download or repair of the model in view is under way
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
  clearBatch();
  forgetModel();
  $('failure').hidden = true;
  // One height for the whole batch, set under Size. GLB files rarely carry a real size, so
  // a height is on when any of them is a GLB.
  $('set-height').checked = files.some(file => /\.glb$/i.test(file.name));
  state.which = innerWidth >= 560 ? 'both' : 'after';
  // Each model's files get a name that is safe in a ZIP and on any computer, and unique
  // even where a computer ignores capitals: later ones get a number.
  const taken = new Set();
  const batchOptions = options(); // every model is repaired the same way unless changed in view
  batch.rows = files.map((file, id) => {
    const title = clean(file.name.replace(MODEL_NAME, '')).trim() || 'model';
    const base = safeFileName(title);
    let fileName = base;
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${base}-${n}`;
    taken.add(fileName.toLowerCase());
    return { id, file, title, fileName, status: 'waiting', options: { ...batchOptions }, turns: 0, rev: 0, built: -1, entries: null, view: null, viewBytes: 0 };
  });
  batch.skipped = skipped.map(clean);
  batch.running = true;
  $('batch').hidden = false;
  $('choose-label').textContent = 'Choose other files';
  $('drop').classList.add('compact');
  setBadge('working', 'Working on this device');
  placeTop();
  renderBatch();
  toTop();
  pump();
}

/** Stop and forget the batch: its worker, its clock, its rows, and any download being built. */
function clearBatch() {
  retire(batch.worker);
  clearTimeout(batch.timer);
  clearTimeout(state.syncTimer);
  Object.assign(batch, { id: batch.id + 1, rows: [], skipped: [], at: -1, running: false, worker: null, job: null, viewBytes: 0 });
  // A model of this batch may be loading into the view's worker. Its answer will be dropped,
  // so its clock is stopped and the page let go here, or it would wait for nothing.
  if (state.batchLoading) { clearTimeout(limit); state.batchLoading = false; setBusy(false); }
  Object.assign(state, { unsynced: false, quietShown: false });
  if ($('batch')) $('batch').hidden = true;
  if ($('model-switch')) $('model-switch').hidden = true;
  placeTop();
}

/**
 * Let go of a batch worker. One in the middle of a job is not stopped there: WebKit can
 * crash the whole page when a worker is stopped while it compresses. Its answer is already
 * unwanted (the job token no longer matches), so it is shut as soon as it gives one, or
 * after the time a job may take.
 */
function retire(old) {
  if (!old) return;
  if (!batch.job) return old.terminate();
  const shut = () => { clearTimeout(backstop); old.terminate(); };
  const backstop = setTimeout(shut, LIMIT_MS);
  old.onmessage = event => { if (event.data.type !== 'progress') shut(); };
  old.onerror = shut;
}

/** Clear the view before a batch: the batch card takes its place until a model is opened. */
function forgetModel() {
  state.gen++; // an answer still coming for the model that was in view is not wanted now
  state.report = null;
  $('results').before($('top-stick')); // the batch card shows progress at the top until a model opens
  $('results').hidden = true;
  $('outcome').hidden = true;
  document.body.classList.remove('has-results', 'outcome-clean');
}

function batchWorker() {
  if (batch.worker) return batch.worker;
  const made = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  made.onmessage = onBatchMessage;
  made.onerror = () => { if (batch.worker === made && batch.job) jobFailed(batch.job, FAILURES.crashed.detail, true); };
  batch.worker = made;
  return made;
}

/** Start the next job: a model not yet repaired, or else one whose files are out of date. */
function pump() {
  if (batch.job) return;
  const waiting = batch.rows.find(item => item.status === 'waiting');
  if (!waiting && batch.running) finishBatch(); // every model repaired: the review can begin
  const row = waiting || batch.rows.find(item => DONE.includes(item.status) && item.built !== item.rev && !item.buildError);
  if (row) return runJob(row);
  batch.worker?.terminate(); // nothing left to do; a fresh one is made if more is asked
  batch.worker = null;
  renderBatch();
}

async function runJob(row) {
  // First every model is repaired, so the review can start; then each is packed into its
  // print files, in the background, from the repaired model the page already holds.
  const job = { token: ++batch.jobs, rowId: row.id, rev: row.rev, first: row.status === 'waiting' };
  batch.job = job;
  if (job.first) row.status = 'working';
  renderBatch();
  if (row.file.size > MAX_BYTES) return jobFailed(job, FAILURES.tooLarge.detail);
  const common = { job: job.token, name: row.file.name, options: row.options, turns: row.turns };
  let request, transfer = [];
  if (!job.first && row.view) {
    const after = row.view.after; // copied to the worker, so the view keeps its own
    request = { ...common, type: 'batch-pack', positions: after.positions, tris: after.tris, unit: row.view.unit };
  } else {
    let buffer;
    try { buffer = await row.file.arrayBuffer(); } catch { return jobFailed(job, 'This file could not be read.'); }
    if (batch.job !== job) return; // the batch was replaced or stopped while the file was read
    request = { ...common, type: job.first ? 'batch-repair' : 'batch-pack', buffer };
    transfer = [buffer];
  }
  Object.assign(request, { heightMm: heightMm(), fileName: row.fileName, title: row.title });
  batch.timer = setTimeout(() => jobFailed(job, FAILURES.timedOut.detail, true), LIMIT_MS);
  try { batchWorker().postMessage(request, transfer); } catch (error) { jobFailed(job, error.message, true); }
}

/** A job ended without a result. Only the current job can fail, and only once. */
function jobFailed(job, reason, stopWorker = false) {
  if (batch.job !== job) return;
  clearTimeout(batch.timer);
  batch.job = null;
  if (stopWorker) { batch.worker?.terminate(); batch.worker = null; }
  const row = batch.rows[job.rowId];
  if (job.first) Object.assign(row, { status: 'failed', error: clean(reason) });
  else row.buildError = clean(reason);
  pump();
}

function onBatchMessage(event) {
  const message = event.data, job = batch.job;
  if (!job || message.job !== job.token || message.type === 'progress') return;
  if (message.type === 'error') return jobFailed(job, message.message);
  if (message.type !== (job.first ? 'batch-repaired' : 'batch-packed')) return;
  clearTimeout(batch.timer);
  batch.job = null;
  const row = batch.rows[job.rowId];
  if (job.first) {
    Object.assign(row, { status: message.report.status, report: message.report, format: message.format, unit: message.unit });
    keepView(row, message);
  } else if (job.rev === row.rev) {
    // A model changed while its files were being made is packed again on a later turn.
    Object.assign(row, { entries: message.entries, built: row.rev, buildError: null });
  }
  pump();
}

/** Keep a model's view for instant switching, giving up the oldest others past the budget. */
function keepView(row, view) {
  batch.viewBytes -= row.viewBytes;
  row.view = view;
  row.viewBytes = viewBytes(view);
  batch.viewBytes += row.viewBytes;
  for (const other of batch.rows) {
    if (batch.viewBytes <= VIEW_BUDGET) break;
    if (other === row || other.id === batch.at || !other.view) continue;
    batch.viewBytes -= other.viewBytes;
    other.view = null;
    other.viewBytes = 0;
  }
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
  setBatchBadge();
  sound.play(batchVerdict());
  renderBatch();
  // With nothing open yet, open the first model that needs a look, or else the first one.
  if (batch.at >= 0) return;
  const pick = batch.rows.findIndex(row => row.status === 'partial');
  const first = pick >= 0 ? pick : batch.rows.findIndex(row => DONE.includes(row.status));
  if (first >= 0) viewRow(first);
  $('batch-title').focus({ preventScroll: true });
}

function applyOptions(chosen) {
  for (const input of document.querySelectorAll('[data-option]')) input.checked = !!chosen[input.dataset.option];
}

/**
 * Show a batch model. One whose view is kept appears at once; the view's worker then loads
 * it quietly once the visitor stops on it, and downloads and options wait the second that
 * takes. Switching again in that time is fine: answers for an earlier model are dropped.
 */
function viewRow(index) {
  const row = batch.rows[index];
  if (!row || !DONE.includes(row.status) || (state.busy && !state.batchLoading)) return;
  batch.at = index;
  applyOptions(row.options);
  const gen = ++state.gen;
  clearTimeout(state.syncTimer);
  Object.assign(state, { name: row.file.name, pendingFile: row.file, fresh: true, fromBatch: true, unsynced: false });
  const load = quiet => row.file.arrayBuffer()
    .then(buffer => { if (gen === state.gen) ask({ type: 'load', buffer, name: row.file.name, options: row.options, turns: row.turns, quiet }, [buffer]); })
    .catch(() => { if (gen === state.gen) notLoaded(row); });
  if (row.view) {
    showResult(row.view);
    state.batchLoading = true;
    setBusy(true);
    state.syncTimer = setTimeout(() => load(true), 250);
  } else {
    state.batchLoading = true;
    setBusy(true);
    setStatus(`Opening ${row.file.name}`, 'busy');
    load(false);
  }
  renderBatch();
}

/** The file could not be read again: the model can be looked at but not downloaded alone. */
function notLoaded(row) {
  Object.assign(state, { batchLoading: false, unsynced: true });
  setBusy(false);
  setStatus(`${row.file.name} could not be read again, so it cannot be downloaded on its own here. It is still in Download all.`);
}

/**
 * The model in view was repaired again in the view's worker. Its result is the row's now;
 * if the visitor changed an option or turned it, its print files are made again too.
 */
function keepRow(message, edited) {
  const row = batch.rows[batch.at];
  if (!row) return;
  Object.assign(row, { status: message.report.status, report: message.report });
  if (row.view !== message) keepView(row, message);
  if (edited) {
    row.options = options();
    row.turns = state.turns;
    row.rev++;
    pump();
  }
  renderBatch();
  setBatchBadge();
}

/** A new height changes every model's print files, so all are made again, in turn. */
let heightTimer = 0;
function heightChanged() {
  renderBatchNote();
  if (!batch.rows.length) return;
  clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    for (const row of batch.rows) if (DONE.includes(row.status) || row.status === 'working') { row.rev++; row.buildError = null; }
    pump();
    renderBatch();
  }, 400);
}

function renderBatch() {
  if (!$('batch')) return;
  const rows = batch.rows;
  const count = status => rows.filter(row => row.status === status).length;
  $('batch').className = 'outcome batch ' + (batch.running ? 'sound' : batchVerdict());
  if (batch.running) {
    const done = rows.filter(row => !['waiting', 'working'].includes(row.status)).length;
    $('batch-title').textContent = `Repairing ${number(Math.min(done + 1, rows.length))} of ${plural(rows.length, 'model')}`;
    $('batch-detail').textContent = 'Each model is repaired on this device, one at a time. Finished ones can be opened below while the rest carry on.';
  } else {
    // Each row has its own outcome, so the card says only what the rows cannot.
    $('batch-title').textContent = plural(rows.length, 'model');
    $('batch-detail').textContent = count('partial') ? 'A partly repaired model will probably still bring a warning from your slicer.' : '';
  }
  if (batch.skipped.length) $('batch-detail').textContent = `${$('batch-detail').textContent} Left out, as not .glb or .stl: ${list(batch.skipped)}.`.trim();
  $('batch-detail').hidden = !$('batch-detail').textContent;
  // The list is drawn afresh as jobs finish; whoever was on a row with the keyboard stays on it.
  const focused = document.activeElement?.closest?.('#batch-list .batch-row')?.dataset.id;
  $('batch-list').replaceChildren(...rows.map((row, i) => {
    const item = document.createElement('li');
    item.dataset.id = String(row.id);
    item.className = 'batch-row ' + row.status + (i === batch.at ? ' current' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'batch-open';
    open.disabled = !DONE.includes(row.status);
    open.setAttribute('aria-current', String(i === batch.at));
    open.append(Object.assign(document.createElement('span'), { className: 'batch-name', textContent: clean(row.file.name) }),
      Object.assign(document.createElement('span'), { className: 'batch-size', textContent: row.report ? `${number(row.report.before.triangles)} triangles` : '' }));
    open.addEventListener('click', () => viewRow(i));
    const badge = Object.assign(document.createElement('span'), { className: 'badge ' + ({ repaired: 'good', sound: 'info', partial: 'warn', failed: 'bad', working: 'working' }[row.status] || 'idle'), textContent: STATUS_WORDS[row.status] });
    item.append(open, badge);
    const note = row.error || row.buildError || (row.status === 'partial' && row.report ? remaining(row.report) : '');
    if (note) item.append(Object.assign(document.createElement('p'), { className: 'batch-error', textContent: row.buildError ? `Not in Download all: ${row.buildError}` : note }));
    return item;
  }));
  if (focused !== undefined) $('batch-list').querySelector(`[data-id="${focused}"] .batch-open`)?.focus({ preventScroll: true });
  renderModelSwitch();
  // On a phone the list is folded away unless asked for, so the comparison stays in view.
  // A desktop has the room, and always shows it.
  const open = !PHONE.matches || !!batch.expanded;
  $('batch-more').hidden = !open;
  $('batch').classList.toggle('open', open);
  $('batch-toggle').hidden = !PHONE.matches;
  $('batch-toggle').setAttribute('aria-expanded', String(open));
  $('batch-toggle-label').textContent = batch.expanded ? 'Hide list' : 'Show list';
  // The ZIP is put together from each model's packed files, made in the background.
  const done = rows.filter(row => DONE.includes(row.status) && !row.buildError);
  const ready = done.filter(current).length;
  const building = batch.running || ready < done.length;
  const button = $('batch-download');
  button.disabled = building || !ready;
  button.classList.toggle('building', building);
  button.setAttribute('aria-busy', String(building));
  $('batch-download-label').textContent = building ? `Building ZIP… ${ready} of ${batch.running ? rows.length : done.length}` : `Download all ${ready} (ZIP)`;
  renderBatchNote();
}

/** The switch above the view: which model is in it, and the way to the others. */
function renderModelSwitch() {
  const viewable = batch.rows.filter(row => DONE.includes(row.status));
  const show = batch.at >= 0 && viewable.length > 0;
  $('model-switch').hidden = !show;
  if (!show) return closeModelMenu();
  const row = batch.rows[batch.at];
  $('model-count').textContent = `${viewable.findIndex(item => item.id === batch.at) + 1} of ${viewable.length}`; // before the name is fitted around it
  fitName($('model-current'), clean(row.file.name), viewable.filter(item => item !== row).map(item => clean(item.file.name)));
  $('model-trigger').setAttribute('aria-label', `Model in view: ${clean(row.file.name)}, ${STATUS_WORDS[row.status]}. Choose another.`);
  $('model-dot').className = 'model-dot ' + row.status;
  const locked = (state.busy && !state.batchLoading) || viewable.length < 2;
  for (const id of ['model-prev', 'model-next', 'model-trigger']) $(id).disabled = locked;
  if (locked) closeModelMenu();
  // The list keeps whichever item has the keyboard when it is drawn again.
  const focused = document.activeElement?.closest?.('#model-menu [data-row]')?.dataset.row;
  $('model-menu').replaceChildren(...viewable.map(item => {
    const option = Object.assign(document.createElement('button'), { type: 'button', tabIndex: -1 });
    option.setAttribute('role', 'menuitemradio');
    option.setAttribute('aria-checked', String(item.id === batch.at));
    option.dataset.row = String(item.id);
    option.append(
      Object.assign(document.createElement('span'), { className: 'model-dot ' + item.status }),
      Object.assign(document.createElement('span'), { className: 'model-item-name', textContent: clean(item.file.name) }),
      Object.assign(document.createElement('span'), { className: 'model-item-status', textContent: STATUS_WORDS[item.status] }),
      checkmark());
    return option;
  }));
  if (focused !== undefined) $('model-menu').querySelector(`[data-row="${focused}"]`)?.focus({ preventScroll: true });
}

/** The tick beside the chosen model, built as elements: the page never turns text into markup. */
function checkmark() {
  const svg = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(svg, 'svg');
  for (const [name, value] of [['viewBox', '0 -960 960 960'], ['width', '18'], ['height', '18'], ['fill', 'currentColor'], ['aria-hidden', 'true'], ['focusable', 'false']]) icon.setAttribute(name, value);
  const path = document.createElementNS(svg, 'path');
  path.setAttribute('d', 'M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z');
  icon.append(path);
  const holder = Object.assign(document.createElement('span'), { className: 'model-item-check' });
  holder.append(icon);
  return holder;
}

// The model menu opens under its button, like the playback menu on heyhaigh.ai, and closes
// with a short fade once a model is chosen.
let menuFade = null;
function openModelMenu() {
  if ($('model-trigger').disabled) return;
  menuFade?.cancel();
  menuFade = null;
  const menu = $('model-menu');
  menu.hidden = false;
  $('model-trigger').setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus({ preventScroll: true });
}
function closeModelMenu(restoreFocus = false, fade = false) {
  const menu = $('model-menu');
  if (!menu || menu.hidden) return;
  $('model-trigger').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('model-trigger').focus({ preventScroll: true });
  if (fade && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const animation = menu.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
    menuFade = animation;
    animation.finished.then(() => { if (menuFade !== animation) return; menu.hidden = true; animation.cancel(); menuFade = null; }, () => {});
  } else menu.hidden = true;
}

/**
 * Put a file name in a narrow space. Names in a batch often share a long start and differ
 * after it (figure-front-final.glb, figure-back-final.glb), so a long name first loses the
 * start it shares with the others, up to a word break, and shows what tells it apart. A
 * name that is still too long is shortened in the middle, keeping its extension. The full
 * name shows on hover, and screen readers hear it in the button's label.
 */
let measure = null;
function fitName(holder, name, others = []) {
  holder.textContent = name;
  const button = holder.closest('button');
  button.removeAttribute('data-tooltip');
  const room = holder.clientWidth;
  if (!room || holder.scrollWidth <= room) return;
  measure ??= document.createElement('canvas').getContext('2d');
  const style = getComputedStyle(holder);
  measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const ext = (name.match(/\.[^.]{1,5}$/) || [''])[0];
  let stem = name.slice(0, name.length - ext.length);
  // The start this name shares with the most similar other name, cut back to a word break:
  // that is the name it could be mistaken for.
  let shared = 0;
  if (others.length) {
    shared = Math.max(...others.map(other => { let i = 0; while (i < stem.length && stem[i] === other[i]) i++; return i; }));
    while (shared > 0 && !/[-_ .]/.test(stem[shared - 1])) shared--;
  }
  const lead = shared > 3 ? '…' : '';
  if (lead) stem = stem.slice(shared);
  let text = lead + '…' + ext;
  for (let keep = stem.length; keep >= 2; keep--) {
    const back = lead ? 0 : Math.min(6, Math.floor(keep / 2)); // after a dropped start, the start of the rest matters most
    const candidate = lead + stem.slice(0, keep - back) + (keep < stem.length ? '…' : '') + (back ? stem.slice(-back) : '') + ext;
    if (measure.measureText(candidate).width <= room) { text = candidate; break; }
  }
  holder.textContent = text;
  button.dataset.tooltip = name;
}
window.addEventListener('resize', () => { if (batch.rows.length && batch.at >= 0) renderModelSwitch(); });
document.fonts?.ready.then(() => { if (batch.rows.length && batch.at >= 0) renderModelSwitch(); });

/** Step to the previous or next model that can be opened, round the list. */
function stepModel(direction) {
  const viewable = batch.rows.filter(row => DONE.includes(row.status)).map(row => row.id);
  if (viewable.length < 2) return;
  const place = viewable.indexOf(batch.at);
  viewRow(viewable[(place + direction + viewable.length) % viewable.length]);
}

/** One line for a partly repaired row: what is left, and where to look. */
function remaining(report) {
  const after = report.after;
  const left = [after.openEdges && plural(after.openEdges, 'open edge'), after.nonManifoldEdges && plural(after.nonManifoldEdges, 'non-manifold edge'), after.inconsistentEdges && plural(after.inconsistentEdges, 'wrongly facing join')].filter(Boolean);
  const total = after.openEdges + after.nonManifoldEdges + after.inconsistentEdges;
  return (left.length ? `${list(left)} remain${total === 1 ? 's' : ''}.` : 'The edge checks pass, but it is not a printable solid.') + ' Open it in the view to see where, and try the Repair options below it.';
}

/** Says what the ZIP will hold, at what size. The height is the one under Size below. */
function renderBatchNote() {
  if (!$('batch-note') || !batch.rows.length) return;
  const height = heightMm();
  $('batch-note').textContent = `An STL and a 3MF of every repaired model, ${height ? `each ${height} mm tall` : 'each at its file\'s own size'}, with a summary.`;
}

/** Put the packed files together. Nothing is made here but the summary and the ZIP's index. */
async function downloadBatch() {
  const rows = batch.rows.filter(row => DONE.includes(row.status) && current(row));
  if (!rows.length || batch.running) return;
  const height = heightMm();
  const summary = [`Polymend ${VERSION}: ${plural(batch.rows.length, 'model')}, ${height ? `each ${height} mm tall` : 'each at its own size'}.`, '',
    ...batch.rows.map(row => `${STATUS_WORDS[row.status].padEnd(16)} ${clean(row.file.name)}${row.report ? ` (${number(row.report.before.triangles)} triangles)` : ''}${row.error ? `: ${row.error}` : ''}${row.buildError ? `: not included, ${row.buildError}` : ''}`)].join('\n') + '\n';
  let archive;
  try {
    const entries = rows.flatMap(row => row.entries);
    entries.push(await zipEntry('polymend-summary.txt', new TextEncoder().encode(summary)));
    archive = new Blob(zipParts(entries), { type: 'application/zip' });
  } catch (error) {
    return fail(error.message, 'The ZIP could not be made');
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(archive);
  link.download = 'polymend-batch.zip';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10 * 60_000); // long enough for a slow save dialog
}

// --- wiring
$('choose').addEventListener('click', () => $('file').click());
$('batch-download')?.addEventListener('click', downloadBatch);
$('batch-toggle')?.addEventListener('click', () => { batch.expanded = !batch.expanded; renderBatch(); });
// On a phone the whole folded line opens and closes the list, not only the chevron.
document.querySelector('.batch-head')?.addEventListener('click', event => {
  if (!PHONE.matches || event.target.closest('button')) return;
  batch.expanded = !batch.expanded;
  renderBatch();
});
$('model-prev')?.addEventListener('click', () => stepModel(-1));
$('model-next')?.addEventListener('click', () => stepModel(1));
$('model-trigger')?.addEventListener('click', () => ($('model-menu').hidden ? openModelMenu() : closeModelMenu()));
$('model-trigger')?.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openModelMenu(); } });
$('model-menu')?.addEventListener('click', event => {
  const item = event.target.closest('[data-row]');
  if (!item) return;
  closeModelMenu(true, true);
  viewRow(Number(item.dataset.row));
});
$('model-menu')?.addEventListener('keydown', event => {
  const items = [...$('model-menu').querySelectorAll('[data-row]')];
  const at = items.indexOf(document.activeElement);
  const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (next !== undefined) { event.preventDefault(); items[(next + items.length) % items.length]?.focus({ preventScroll: true }); }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModelMenu(true); }
  else if (event.key === 'Tab') closeModelMenu();
});
document.addEventListener('click', event => { if (!event.target.closest('.model-pick')) closeModelMenu(); });
$('set-height').addEventListener('change', heightChanged);
$('height').addEventListener('input', heightChanged);
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
  state.pendingEdit = true;
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
    state.pendingEdit = true;
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
