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

The site is a Cloudflare Worker with static assets (`wrangler.toml`). `_headers` sets its security policy, which only lets heyhaigh.ai embed it in a frame.

## Privacy

Polymend has no analytics, no cookies and no server that sees a visitor's file. The page's Content-Security-Policy sets `connect-src 'none'`, so the browser itself refuses any attempt to send data. This is a deliberate decision, not an omission: do not add analytics, outside scripts, fonts or embeds. `test/privacy.test.js` fails if a change would break the promise.

## The page

The look follows heyhaigh.ai: Geist Mono, its paper and navy themes, glass pills, the orange action card with halftone dots that follow the pointer, and its bordered tables. `?theme=dark` or `?theme=light` in the address sets the theme, so a page that embeds the tool can match its own.

A repair normally takes about a second. After 1 minute the work is stopped and the page says why. `?limit-ms=60` shortens the limit for testing, on localhost only.

## What it fixes

Some models look fine but make a slicer report open edges, non-manifold edges and reversed faces. In the twelve figures this was built against, the faults were always the same three kinds:

1. **Stray pieces.** A triangle, flap or tiny pocket stuck to the surface along an edge that already has its two proper faces. Deleted whole.
2. **Small holes.** Patched, with the patch shape that cuts through the least nearby surface.
3. **Wrongly facing triangles.** Turned, changing as few as possible. A shell inside another keeps its sense, since it may be a cavity.

Surfaces that touch along an edge are left alone unless separation is switched on, because cutting them can part things meant to touch. Places where the surface passes through itself are counted and reported, not repaired.

Original vertices are never moved, and a sound mesh comes out with the same vertices and triangles in the same order.

It is not a general STL repair tool. Large holes are left open and reported; badly damaged scans are out of scope. The outcome is always one of `repaired`, `sound` or `partial`.

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
| `test/` | Unit tests on small hand-built meshes (`npm test`) |
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
node tools/browser-shots.mjs       # screenshots in both themes, desktop and phone, into out/shots/
```

The real-model tools look for `.stl` and `.glb` files in `./corpus` (ignored by git), or wherever `POLYMEND_CORPUS` points. The browser tools need Playwright: run `npm i -D playwright`, or point `POLYMEND_PLAYWRIGHT` at a folder that already has it. `tools/local.mjs` explains both settings.

Results on 2026-10-05: all twelve models go from 16–114 open edges and 6–54 non-manifold edges to zero of each, as one closed surface, confirmed by trimesh. Volume changes by less than 0.004%. A 312,000-triangle model is repaired in under half a second in Node, and goes from file chosen to result on screen in about 0.7 seconds in Chromium.

Confirmed in the slicer on 2026-10-05: the author imported all twelve repaired files into Bambu Studio and none showed a warning. The unrepaired originals all did. Other slicers are untested.
