# Polymend

Free STL and GLB mesh repair for 3D printing. Make problematic 3D models printable: fix the small mesh faults a slicer objects to, entirely in the browser. Nothing is uploaded.

- **GLB in:** converted to STL (Z-up) and repaired.
- **STL in:** repaired.

Live at **https://polymend.xyz**. MIT licensed.

```sh
node tools/serve.mjs          # local copy at http://127.0.0.1:8650/
node tools/build-site.mjs     # copy only the public files into dist/
npx wrangler deploy           # publish dist/ to Cloudflare (polymend.xyz)
```

The site is a Cloudflare Worker with static assets (`wrangler.toml`). `_headers` sets its security policy. Only `/embed`, the tool on its own, may be placed in a frame by other sites; `embed.html` is made from `index.html` by `node tools/make-embed.mjs` and is never edited by hand. After a deploy, `node tools/check-live.mjs` checks the live site's headers and pages. Changes are listed in `CHANGELOG.md`.

## Privacy

Polymend has no analytics, no cookies and no server that sees a visitor's file. The page's Content-Security-Policy sets `connect-src 'none'`, so the browser blocks the page from opening any connection. A policy like that covers requests, sockets, beacons and forms, not every conceivable trick, so the code is also kept small and public, and the tests below fail on anything that could send data or open another address. This is a deliberate decision, not an omission: do not add analytics, outside scripts, fonts or embeds. `test/privacy.test.js` fails if a change would break the promise.

## The page

The look follows heyhaigh.ai: Geist Mono, its paper and navy themes, glass pills, the orange action card with halftone dots that follow the pointer, and its bordered tables. `?theme=dark` or `?theme=light` in the address sets the theme, so a page that embeds the tool can match its own.

On a 300,000-triangle model a repair takes about a second. After 1 minute the work is stopped and the page says why. Files up to 200 MB or 1 million triangles are accepted; that ceiling was measured (about 1.1 GB of memory and four seconds on a laptop), not guessed. `?limit-ms=60` shortens the limit for testing, on localhost only.

## What it fixes

Some models look fine but make a slicer report open edges, non-manifold edges and reversed faces. In the twelve figures this was built against, the faults were always the same three kinds:

1. **Stray pieces.** A triangle, flap or tiny pocket stuck to the surface along an edge that already has its two proper faces. Deleted whole, if it is small.
2. **Small holes.** Patched with a shape that cuts through nothing. Where the surface already runs through itself a patch may graze a few nearby triangles; that is reported. A hole with no acceptable patch stays open.
3. **Wrongly facing triangles.** Turned, changing as few as possible. A shell inside another keeps its sense, since it may be a cavity.
4. **Split seams.** Rim points a hair apart (a hundred-thousandth of the model's size) are joined.

### It fails safe

Every rule errs toward leaving the model alone and saying so:

- A model with no faults is returned untouched, tiny separate parts included.
- Wide openings (over a tenth of the model's size) are left open, since they may be meant, like the top of a vase. A switch closes them.
- A thin sheet of real size attached along an edge is left for its author, not deleted as a scrap.
- Surfaces that touch along an edge are left alone unless separation is switched on, because cutting them can part things meant to touch.
- A closed piece that encloses no volume is not called repaired.
- Places where the surface passes through itself, or pinches to a single point, are counted and reported, not repaired.

No vertex is moved except the seam points that are joined, and a sound mesh comes out with the same vertices and triangles in the same order.

It is not a general STL repair tool. The outcome is always one of `repaired`, `sound` or `partial`, and `partial` lists what was left and why.

### Files are not trusted

Every size in a file is the file's own claim. The readers check each claim against the file's real length and against the triangle limit before setting memory aside, refuse GLB scenes that loop or repeat a mesh without end, and read text STL a piece at a time. The self-crossing count is bounded and skipped with a note when it would take too long.

## Layout

| Path | Role |
| --- | --- |
| `index.html`, `app/` | The page: `app.js` (behaviour), `worker.js` (runs the engine off the main thread), `viewer.js` (WebGL view, including side by side), `theme.js` (light and dark), `style.css`, `fonts/` (Geist Mono, under the SIL Open Font License) |
| `src/pipeline.js` | Read, weld, measure, repair, measure again. Shared by the page and the tools |
| `src/repair.js` | The repair |
| `src/intersect.js` | Finds places where the surface passes through itself |
| `src/mesh.js` | Vertex welding, edge tables, defect counts |
| `src/stl.js`, `src/glb.js` | Read STL and GLB; write binary STL |
| `src/output.js` | Print sizing and the 3MF writer |
| `test/` | Unit tests on small hand-built meshes (`npm test`). `unlike.test.js` covers models unlike the figures the repair was first tuned on, and files built to waste memory |
| `tools/` | Scripts that run the engine and the page on real models kept outside the repo |
| `library/` | Local component library: a sidebar shell (`index.html`) and its pages. First page: the sound lab the chimes were chosen from. Open http://127.0.0.1:8650/library/ |

No dependencies. Plain ES modules that run in Node and in a browser.

## Checking against real models

The real models are not in this repository.

```sh
npm test                           # unit tests
node tools/run-corpus.mjs          # repair every model into out/, one report line each
python tools/verify.py ...         # independent check with trimesh, and comparison with another tool's repairs
node tools/glb-parity.mjs          # GLB input gives the same geometry as a Blender STL export
node tools/intersections.mjs       # self-crossings before and after, and whether patches add any
node tools/snapshot.mjs            # the engine's exact output still matches a saved fingerprint (--save to record one)
node tools/profile.mjs             # where the time goes, stage by stage
node tools/browser-check.mjs webkit glb mobile   # drive the real page (needs the server running)
node tools/browser-states.mjs      # the page's partly-repaired, error and time-limit states
node tools/browser-embed.mjs       # the embedded copy inside a made-up third-party page
node tools/check-live.mjs          # the live site: headers, pages, no injected scripts
node tools/browser-shots.mjs       # screenshots in both themes, desktop and phone, into out/shots/
```

The real-model tools look for `.stl` and `.glb` files in `./corpus` (ignored by git), or wherever `POLYMEND_CORPUS` points. The browser tools need Playwright: run `npm i -D playwright`, or point `POLYMEND_PLAYWRIGHT` at a folder that already has it. `tools/local.mjs` explains both settings.

Results on 2026-10-05: all twelve models go from 16–114 open edges and 6–54 non-manifold edges to zero of each, as one closed surface, confirmed by trimesh. Volume changes by less than 0.004%. A 312,000-triangle model is repaired in under half a second in Node, and goes from file chosen to result on screen in about 0.7 seconds in Chromium.

Confirmed in the slicer on 2026-10-05: the author imported all twelve repaired files into Bambu Studio and none showed a warning. The unrepaired originals all did. Other slicers are untested.
