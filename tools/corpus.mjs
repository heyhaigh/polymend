// The real models the engine is checked against. They are not part of this repository;
// see tools/local.mjs for where they are looked for.
import fs from 'node:fs';
import { models } from './local.mjs';

/** Unrepaired exports: every .stl in the corpus except other tools' repaired copies. */
export const corpus = models(['.stl']).filter(file => !/_fixed\.stl$/i.test(file));

/** Another tool's repair of the same model, saved beside it as `<name>_fixed.stl`, if there is one. */
export function otherRepair(file) {
  const sibling = file.replace(/\.stl$/i, '_fixed.stl');
  return fs.existsSync(sibling) ? sibling : null;
}
