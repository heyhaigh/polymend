// Short chimes that say a repair has finished, made in the browser so nothing is
// downloaded. Each lasts about a second or less, so no mute control is needed.
//
// Browsers only let a page make sound once the visitor has done something on it.
// Choosing or dropping a file counts, so `prime` is called from those moments; if the
// browser still refuses, the chime is simply skipped.

let context = null;

// Each chime is a list of notes. A note has a pitch `f` in Hz, a start `t` and a length
// `d` in seconds, and optional `partials`: quieter overtones, each [pitch ratio, loudness,
// share of the note's length], which is what makes a tone sound struck, like a mallet or bell.
const MALLET = [[4, 0.25, 0.3]];
const CHIMES = {
  repaired: [{ f: 392, d: 0.3, partials: MALLET }, { f: 523.25, t: 0.13, d: 0.5, partials: MALLET }],   // marimba, low then high
  sound: [{ f: 523.25, d: 0.5, partials: MALLET }],                                                   // one marimba note
  partial: [{ f: 330, d: 0.5, partials: [[4, 0.2, 0.3]] }],                                           // one dull, low mallet
  failed: [{ f: 196, d: 1.1, gain: 1.1, partials: [[2.76, 0.4, 0.5], [5.4, 0.15, 0.25]] }],           // one low bell
};
const VOLUME = 0.16;

function ensure() {
  try { context ??= new (window.AudioContext || window.webkitAudioContext)(); } catch { context = null; }
  return context;
}

/** Call from a click, key press or file drop, so the browser will allow sound later. */
export function prime() {
  const audio = ensure();
  if (audio && audio.state !== 'running') audio.resume().catch(() => {});
}

function schedule(kind) {
  const now = context.currentTime + 0.02;
  const out = context.createGain();
  out.gain.value = VOLUME;
  out.connect(context.destination);
  for (const { f, t = 0, d, gain = 1, partials = [] } of CHIMES[kind]) {
    for (const [ratio, level, life] of [[1, 1, 1], ...partials]) {
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.frequency.value = f * ratio;
      envelope.gain.setValueAtTime(0.0001, now + t);
      envelope.gain.exponentialRampToValueAtTime(gain * level, now + t + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + t + Math.max(0.04, d * life));
      oscillator.connect(envelope).connect(out);
      oscillator.start(now + t);
      oscillator.stop(now + t + d + 0.05);
    }
  }
  document.documentElement.dataset.lastSound = kind; // lets tests see that a chime was sent
}

// A page that embeds the tool can end its address with ?sound=off to keep it quiet.
const SILENT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sound') === 'off';

export function play(kind) {
  if (SILENT || !CHIMES[kind] || !ensure()) return;
  if (context.state === 'running') { schedule(kind); return; }
  // Not unlocked yet: ask once more, and play only if the browser agrees.
  context.resume().then(() => { if (context.state === 'running') schedule(kind); }).catch(() => {});
}
