# Changelog

What has changed in Polymend, newest first. Each version is marked with the moment it was published. From version 0.3.0 on, every change is listed here and recorded in the project's public history.

## 0.6.1 (Published October 9, 2026 at 12:42 PM EDT)

- Fixed: in 0.6.0, an STL file stayed on "Back to the rest pose" after its repair, so it could not be downloaded or changed. A GLB was also repaired a second time, needlessly, each time it was opened.

## 0.6.0 (Published October 9, 2026 at 12:32 PM EDT)

- A rigged or animated GLB can now be repaired in any pose from its animation clips, not only in its rest pose. When a file has clips, a Pose panel appears under the view: choose a clip, drag to any moment of it and let go, and that pose is repaired. While you drag, the view follows the pose. The arrows, or ← and → on your keyboard, step from keyframe to keyframe and wrap round, so you can walk through a cycle.
- Skeletons, blend shapes and every kind of keyframe curve are followed. On 171 rigged and animated files, every pose tried matched a widely used 3D library point for point.
- Downloads are named for the pose, such as `figure-Wave-0.84s-mended.zip`.
- When you repair several files at once, each keeps the pose chosen for it, and "Download all" holds those poses.
- From the command line, `--clips` lists a file's clips, and `--clip Wave --time 0.8` repairs that pose.
- A GLB that stores part of its shape as a short list of changes (a "sparse" layout) is now read instead of refused.

## 0.5.3 (Published October 9, 2026 at 10:36 AM EDT)

- On a phone, the home page fits the screen again. One long line of code in "Add it to your site" made the page wider than the screen, so it could be dragged sideways and the theme button sat past the edge. The line now wraps.

## 0.5.2 (Published October 6, 2026 at 9:37 PM EDT)

- The privacy policy now has two parts: Polymend on the web, and Polymend on your computer, for its command line and its plugin for desktop apps. Both keep the same promise: your model is repaired on your device and never sent to Polymend. The terms now cover all three.

## 0.5.1 (Published October 6, 2026 at 4:13 PM EDT)

- In "Add it to your site", the theme choice that follows each visitor's device setting is now called System, and the choices fit on the narrowest phones.
- A small button after "Chime when a repair finishes" plays the chime, so you can hear it before you choose. It can be pressed again and again.
- The sound switch is larger, matching the height buttons, with the same light outline.
- The upload card no longer flickers over the page as you scroll past it.
- On a phone, a little less space between the upload card and the explanation below it.

## 0.5.0 (Published October 6, 2026 at 3:51 PM EDT)

- Several models at once: choose or drop up to 20 GLB or STL files, up to 1 GB in all. Each is repaired in turn on your device, and a list shows how each one went.
- The review opens as soon as every model is repaired. Switch between models with the arrows or the menu above the view; switching is instant.
- "Download all" gives every model in one ZIP, an STL and a 3MF of each with a short summary, at the height set under Size. The ZIP is put together in the background while you look, and the button shows its progress until it is ready. The menu beside it gives just the model in view, in either format.
- A change made to one model in view, a repair option or a quarter turn, is carried into its files in the ZIP; a new height remakes them all.
- With a result on the page, the before-and-after view now comes first, with the result and the file list below it. On a phone, the list folds into one line until you open it.
- The view's Before, After and Side by side buttons are now icons, with their names on hover.
- From the command line, `node cli.mjs <folder or files> --height <mm>` repairs every model and writes a list of the results.

## 0.4.5 (Published October 6, 2026 at 12:04 AM EDT)

- Search engines and link previews get better details: every page now shows a preview image when shared, the sitemap says when each page last changed, and the site has a classic favicon for browsers that ask for one.

## 0.4.4 (Published October 5, 2026 at 11:14 PM EDT)

- The result and the questions now say what a self-crossing looks like in a slicer, a small dark triangle or fleck, and that it is not a hole and prints as solid.

## 0.4.3 (Published October 5, 2026 at 10:25 PM EDT)

- An embedding page with its own light and dark modes can tell the frame when they change, and it flips with the page.
- On a phone the home page's scope line is left out, to bring the upload card up.

## 0.4.2 (Published October 5, 2026 at 10:21 PM EDT)

- A command line: `node cli.mjs model.glb --height 43.2 --out ./print` writes a repaired STL, a 3MF and a report. It is what the 2D to 3D Print skill on heyhaigh.ai now runs.
- An embedding site can give the frame its own backdrop and edge colors (`?bg=` and `?edge=`).

## 0.4.1 (Published October 5, 2026 at 9:15 PM EDT)

Finishing touches on the embed and the page.

**Embed**

- In the frame, once there is a result, the before-and-after view comes first and the outcome card and file strip follow it; the view is taller.
- A lighter edge in light mode and a neutral charcoal fill in dark mode.
- The credit is a small square badge of the maker's hand, through a halftone screen, with a ring on hover.
- The view switch, the step arrows and the download button share one line; on a phone the download button keeps only its icon.

**Page**

- The upload card, while left alone, sends a slow wave of its halftone dots out from the centre every few seconds.
- The before-and-after view has an edge, matching the line between its halves.
- The step counter shows arrows and a number. The outcome title matches the section subheaders, and the outcome card can be dismissed with an X.
- The "What changed" list is gone: the outcome card already says what changed.
- The embed pop-up blurs the page behind it.

## 0.4.0 (Published October 5, 2026 at 8:42 PM EDT)

**Compressed GLB files**

- Draco-compressed GLB files, which many museums and model sites publish, are now unpacked and repaired like any other. The decoder is fetched only the first time a file needs it, and nothing about the privacy promise changes: it runs in your browser and the page still cannot make a connection.
- Meshopt-compressed GLB files are still refused, with a clearer message.

## 0.3.1 (Published October 5, 2026 at 8:31 PM EDT)

The embed, refined, and a few things around it.

**Embed**

- The frame is 340 pixels tall by default instead of 720, with the upload card set more compactly to suit. Results scroll inside the frame.
- Inside another site, the tool is a near-white panel with a fine edge, so it sits cleanly against the page around it.
- "Add it to your site" now has plain controls for the theme, the chime and the height; the code rewrites itself as you choose, so there is nothing to edit by hand. The same controls appear in the footer pop-up.
- The code is set like code, in two joined panes with the choices above it.

**Page**

- The outcome card and the refusal card can be dismissed with an X in the corner. The badge in the pinned bar keeps saying how the repair went.
- The fade under the pinned bar no longer flashes when the theme changes.
- The pop-up blurs the page behind it.
- This page is now called the changelog, and each version shows the moment it was published.

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
- Holes are counted before anything is patched and told apart as flat or curved. A flat hole is closed in its own plane with no new point.
- The faults table shows holes, duplicate triangles and collapsed triangles.

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
- Every footer has a changelog, a feedback link and a contact address.

**Wording**

- The page says what the tool is for and what it has been tested on. The privacy page describes exactly what the security policy does and does not guarantee.

## 0.2.0 (Published October 5, 2026 at 5:15 PM EDT)

First public version: repair of stray triangles, small holes and wrongly facing triangles in STL and GLB files, a before, after and side by side view with every change marked, and STL, 3MF or ZIP downloads. Everything runs in the browser.
