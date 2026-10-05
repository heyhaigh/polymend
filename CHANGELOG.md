# Changelog

Every change to Polymend from version 0.3.0 on is listed here and recorded in the
repository's history.

## 0.3.0 (October 2026)

Safer on models unlike the ones it was first built for, after an outside review.

**Repair**

- A model with no faults is now left completely untouched. Before, a tiny separate part
  such as a peg could be removed as debris.
- A file is no longer called "Repaired" when it cannot print: a single triangle, a flat
  sheet folded shut, or a file whose triangles are all collapsed.
- Wide openings are left open by default, because they may be meant (the top of a vase).
  "Close wide openings too" under Repair options closes them.
- A thin sheet of real size attached along an edge is left alone and reported, not deleted.
- A hole whose only patches would cut through the model is left open and reported. A
  patch that has to graze nearby surface is now reported instead of being made silently.
- L-shaped and crescent-shaped holes are closed corner by corner, where a fan of
  triangles would have folded over itself.
- Seams whose two sides differ by a hair are joined.
- Places where the surface pinches to a single point are counted and reported.

**Files**

- The size limit is now 200 MB or 1 million triangles, which is what was measured to work.
- Oversized, cut-short and dishonest STL and GLB files are refused before memory is set
  aside for them. Text STL files are read a piece at a time.
- A GLB saved without a print height is written in millimeters. Before, it came out a
  thousand times too small.
- 3MF files of models with very small coordinates keep enough decimal places.

**Page**

- The outcome card says what was removed or added, and what was left and why.
- The self-crossing check shows when it is still running or was skipped, is bounded, and
  can no longer stall the page after a repair.
- If a second file fails, the model already on the page keeps its name and stays usable.
- The outcome card now comes first, in place of the title, once there is a result.
- Polymend can be embedded in another site with one line of code (`/embed`).

**Wording**

- The page says what the tool is for and what it has been tested on, and the privacy
  page describes exactly what the security policy does and does not guarantee.

## 0.2.0 (October 2026)

First public version.
