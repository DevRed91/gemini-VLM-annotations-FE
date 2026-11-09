# Task 2.1C — Browser-Based Coordinate-Frame Validation Panel

Development-only coordinate-frame and reprojection validation for the Gaussian
Splat annotation pipeline. Builds on the Task 1 diagnostic instrumentation
(`docs/annotation-diagnostics-task1.md`); no production code path changed.
The required final report (files changed, verification evidence, reproduction
steps) is in
[`docs/annotation-diagnostics-task2-1c-final-report.md`](./annotation-diagnostics-task2-1c-final-report.md).

## Motivation

The Checkered Rug experiment showed a diagnostic 3D click-hit marker roughly
470 px away from the original click crosshair (click `(0.464, 0.601)` → hit
`(-1.35, -0.98, -0.42)` at ~2.05 m). The cause was unknown: camera movement,
projection mismatch, coordinate-space mismatch, marker rendering, or DOM
projection. Task 2.1C makes each of those hypotheses *observable* without
changing any pipeline behaviour.

## What was built

| Feature | Where |
|---|---|
| A — click-time vs validation-time camera state (position, quaternion, world/inverse-world/projection matrices, fov, aspect, near/far, camera type, canvas rect, buffer size, DPR) with diffs | `coordinateValidation.ts` (`captureCameraState`, `captureViewport`, `diffCameraStates`), panel camera table |
| B — click-hit reprojection through the **click-time** camera | `coordinateValidation.ts` (`validateClickReprojection`) |
| C — all sampling-hit reprojection with per-cell table + aggregate stats (mean/median/max/p95, normalized + pixels; misses/behind/unavailable counted, never silently dropped) | `coordinateValidation.ts` (`validateSampleReprojections`, `aggregateStats`) |
| D — visual comparison overlay (frozen click, click-time reprojection, sample cells + error vectors, live projection at last redraw; toggleable, no render loop) | `validationPanel.ts` (`redrawOverlay`) |
| E — coordinate-space diagnostics: per-point world vs splat-local hypothesis test, Spark raycast rigid-transform analysis, documented spaces for every pipeline stage | `coordinateValidation.ts` (`testSpaceHypothesis`, `analyseSplatRaycastSpace`, `COORDINATE_SPACES`) |
| F — console API on the existing `window.__sl.diagnostics` seam | `validateReprojection(index?)`, `validateSamples(index?, detectionIndex?)`, `exportValidation(index?)`, `toggleValidationPanel()` |

UI: press **V** in the dev viewer (or `window.__sl.diagnostics.toggleValidationPanel()`).
The panel is top-right, collapsible, and never touches annotation state.
Keyboard D/O behave exactly as before.

## Coordinate spaces (verified, not assumed)

All statements below were verified by reading the production source and the
Spark 2.0.0 bundle (`node_modules/@sparkjsdev/spark/dist/spark.module.js`,
`SplatMesh.raycast` around line 12716):

- **Three.js camera** — right-handed world space; camera looks down local −Z;
  `matrixWorld` maps camera-local→world, `projectionMatrix` camera-local→clip.
- **SparkJS raycasting** — `SplatMesh.raycast` transforms the *world* ray into
  *mesh-local* space (`matrixWorld.invert()`), casts there (WASM, local ray
  parameter `t`), then reconstructs every returned point as
  `worldRay.origin + worldRay.direction * t_local`. That construction is
  world-correct **iff the splat transform is rigid** (rotation + translation,
  unit scale). Under scale, the recorded positions/distances are suspect.
- **Splat scene** — the `.sog` `SplatMesh` is a scene child with a non-identity
  transform (`loadWorld` sets `position (0, -1.5, 0)`; identity rotation, unit
  scale → currently rigid, so hits are world space).
- **Hit positions / cluster centroids / anchors** — whatever space the hits are
  in (DBSCAN and the AABB-centroid rule are pure functions of the hit points).
- **Diagnostic 3D markers** — added to a scene-root group with *no* splat
  transform, i.e. they interpret recorded positions as world space.
- **DOM annotation projection** — `anchor.clone().project(camera)` (world→NDC)
  then NDC→window pixels; the click path normalizes by the canvas rect —
  identical only while the canvas fills the window.

The panel does not assume any of this: `testSpaceHypothesis` reprojects each
recorded point under both the world and the splat-local interpretation and
reports which one is consistent (tolerance 0.005 normalized). This is a
measurement, not a correction — no transform is ever applied to pipeline data.

## Reprojection methodology

1. Recorded world hit → camera-local via the **recorded** `inverseWorldMatrix`.
2. → clip via the **recorded** `projectionMatrix` (verbatim elements, not
   recomputed from fov/aspect — it is what the renderer used).
3. Explicit homogeneous `w`: `w <= 0` ⇒ behind camera (reported, never
   mirrored). Perspective division only when `w > 0`.
4. NDC → normalized screen: `u = 0.5 + ndc.x·0.5`, `v = 0.5 − ndc.y·0.5`
   (verified against `splatRay`'s `ndcY = −(y·2−1)` and the DOM projection).
5. Error: `√((u_proj−u_orig)² + (v_proj−v_orig)²)`; pixel error uses the
   **click-time** canvas rect (`√((du·W)² + (dv·H)²)`).

Click-time state is frozen once in `recordClick` (same synchronous event turn
as the Task 1 click probe) into `click.cameraSnapshot`
(camera + viewport + splat transform) and is never mutated; validation-time
captures are stored separately. The live camera is never substituted for
click-time state — missing snapshots produce an explicit `unavailable` reason.

## Console API

```js
window.__sl.diagnostics.validateReprojection()        // click-hit result (latest request)
window.__sl.diagnostics.validateReprojection(4)       // by request index
window.__sl.diagnostics.validateSamples()             // all sampling hits
window.__sl.diagnostics.exportValidation()            // full JSON report
window.__sl.diagnostics.toggleValidationPanel()       // show/hide the panel
```

## Verification (all green, 2026-11-09)

- `npx tsc --noEmit` — clean.
- `npm test` — 135/135 pass, incl. 31 new tests in
  `tests/CoordinateValidation.test.ts` covering: known-point projection
  (hand-computed + THREE cross-check), click-hit reprojection, sampling
  reprojection + aggregates, camera movement/rotation diffs, missing camera
  state, behind-camera points, viewport differences, pixel-error math,
  space-hypothesis handling (world vs splat-local vs non-rigid splat), report
  JSON round-trip.
- `npm run validate:diagnostics` — 12/12 browser tests pass (headless Chromium,
  SwiftShader), now including:
  - click-path request freezes the full camera/viewport/splat snapshot;
  - coordinate validation replays the click and sampling hits through the
    click-time camera;
  - the panel opens, lists requests, and leaves annotations untouched.
- Production bundle (`npm run build` + grep of `dist/`): zero occurrences of
  `validateReprojection`, `CoordinateValidationPanel`, `coordinate-validation`,
  or any diagnostics module code.

### Key empirical result

Against the real viewer (`docs/annotation-diagnostics-results.json`,
`evidence.states.coordinateValidation`):

- Click-hit reprojection error: **1.1e-16 normalized (~5e-14 px)**;
  ray-consistency offset 0.
- All 121 sampling hits: max normalized error **4.3e-16**.
- Space verdict `consistent-with-world`; the splat-local hypothesis would err
  by 0.416 normalized (~200 px) — hits are *not* splat-local.
- Splat transform is rigid ⇒ Spark's raycast construction is world-safe today.

Implication for the Checkered Rug case: the click ray → hit geometry is
*self-consistent at click time*, so a 470 px marker/ crosshair offset cannot
come from a click-ray/hit coordinate mismatch. Remaining suspects the panel can
now discriminate: camera movement after the click (Feature A diff + Feature D
frozen-vs-live markers), marker placement semantics (anchor vs click hit —
DBSCAN's eps 0.3 may pull the anchor far from the click, see Task 1 notes), or
DOM projection. This task deliberately does not pick a winner.

## Reproduce in the browser

1. `npm run dev`, open the viewer, wait for the world to load.
2. Enable the annotation tool (toolbar button), click an object.
3. Press **V** (or run `window.__sl.diagnostics.toggleValidationPanel()`).
4. Pick the request in the dropdown → camera table shows click-time vs now.
5. Click *Validate Click-Hit Reprojection* and *Validate All Sampling Hits*.
6. Read errors (normalized + px), stats, per-cell table, space verdicts.
7. *Export JSON* / *Copy JSON* for the full report; toggle *Overlay* to see
   the frozen-click vs reprojected vs live markers over the 3D view.
8. Console equivalents: `window.__sl.diagnostics.validateReprojection()` etc.

## Known limitations

- Inject-seam requests (`__sl.inject`) have no click, hence no click-time
  camera snapshot: their sample validation degrades to ray-consistency checks
  and reports the limitation explicitly.
- The validation overlay's "live" markers reflect the camera at the last
  redraw (on-demand drawing, no render loop) — by design.
- `p95` is nearest-rank (`ceil(0.95·n)`), not interpolated.
- The panel samples `window.devicePixelRatio` at capture time; browser zoom
  between click and validation shows up in the DPR diff.
- Feature E space verdicts are per-point measurements; a low error proves
  geometric consistency only, never semantic object identity.
