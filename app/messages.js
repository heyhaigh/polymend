// The words shown when something goes wrong. Kept in one place so the page and the
// component library's "Error states" page always say the same thing.

// The largest file the page will read, checked before the file is opened. A test keeps
// this equal to the engine's own limit.
export const MAX_BYTES = 200 * 1024 * 1024;

export const FAILURES = {
  unreadable: { title: 'Could not read this file' },
  tooLarge: { title: 'File too large', detail: 'This file is larger than 200 MB, which is more than this page can handle.' },
  timedOut: { title: 'Stopped after 1 minute', detail: 'This took longer than a minute, so it was stopped. A model that takes this long is usually very large, or has damage of a kind this page was not built for. A general repair tool or a 3D editor such as Blender is the next thing to try.' },
  crashed: { title: 'Stopped', detail: 'Something went wrong inside the repair, so it was stopped. If this keeps happening, try a current version of Chrome, Firefox, Safari or Edge.' },
};
