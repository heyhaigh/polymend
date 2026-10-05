// The words shown when something goes wrong. Kept in one place so the page and the
// component library's "Error states" page always say the same thing.

export const FAILURES = {
  unreadable: { title: 'Could not read this file' },
  tooLarge: { title: 'File too large', detail: 'This file is larger than 400 MB, which is more than this page can handle.' },
  timedOut: { title: 'Stopped after 1 minute', detail: 'This took longer than a minute, so it was stopped. A model that takes this long is usually very large or far from a closed surface, and is better fixed by hand in a 3D editor such as Blender.' },
  crashed: { title: 'Stopped', detail: 'Something went wrong inside the repair, so it was stopped. If this keeps happening, try a current version of Chrome, Firefox, Safari or Edge.' },
};
