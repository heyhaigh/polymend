# Change log

What has changed in Polymend, newest first. Each version is marked with the moment it was published. From version 0.3.0 on, every change is listed here and recorded in the project's public history.

## 0.3.0 (Published October 5, 2026 at 7:49 PM EDT)

Safer on models unlike the ones it was first built for, and tested on far more of them.

**Tested on real models**

- Checked against CAD-exported printer parts and museum 3D scans as well as sculpted figures, and in a second slicer as well as Bambu Studio.
- That testing found one real fault, now fixed: on a part with a deliberate hollow inside, the hollow could be turned inside out and filled in.

**Repair**

- A model with no faults is now left completely untouched. Before, a tiny separate part such as a peg could be removed as debris.
- A file is no longer called "Repaired" when it cannot print: a single triangle, a flat sheet folded shut, or a file whose triangles are all collapsed.
- Wide openings are left open by default, because they may be meant, like the top of a vase. "Close wide openings too" under Repair options closes them.
- A thin sheet of real size attached along an edge is left alone and reported, not deleted.
- A patch that has to graze nearby surface is now reported. One that would cut through the model is not made, and the hole is left open.
- L-shaped and crescent-shaped holes are closed neatly, where the old patch could fold over itself.
- Seams whose two sides differ by a hair are joined.
- Places where the surface pinches to a single point are counted and reported.

**Files**

- The size limit is now 200 MB or 1 million triangles, which is what was measured to work.
- Oversized, cut-short and damaged STL and GLB files are refused quickly, with a reason.
- A GLB saved without a print height is written in millimeters. Before, it came out a thousand times too small.
- A GLB with a rig, animation or blend shapes is read in its rest pose, and the result says so.

**Page**

- The outcome now comes first, in place of the title, and says what was removed, what was added, and what was left and why.
- The check for places where the surface passes through itself shows when it is still running or was skipped, and can no longer stall the page.
- If a second file fails, the model already on the page keeps its name and stays usable.
- New questions and answers about testing, grazing patches, and rigged models.
- Polymend can be placed in another website with one line of code: see "Add it to your site" on the home page, or "Embed on your site" in the footer.
- Every footer has a change log, a feedback link and a contact address.

**Wording**

- The page says what the tool is for and what it has been tested on. The privacy page describes exactly what the security policy does and does not guarantee.

## 0.2.0 (Published October 5, 2026 at 5:15 PM EDT)

First public version: repair of stray triangles, small holes and wrongly facing triangles in STL and GLB files, a before, after and side by side view with every change marked, and STL, 3MF or ZIP downloads. Everything runs in the browser.
