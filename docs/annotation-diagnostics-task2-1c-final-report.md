# Task 2.1C — Final Report

Required final report for **Task 2.1C — Browser-Based Coordinate-Frame
Validation Panel** (delivered 2026-11-09). Design details and usage live in
[`docs/annotation-diagnostics-task2-1c.md`](./annotation-diagnostics-task2-1c.md);
this document records what was delivered, what was verified, and how to
reproduce the validation. Everything below is development-only tooling —
**no production annotation behaviour changed** (DBSCAN, sampling,
bounding-box, and annotation placement were not touched, and the validation
script's source-invariant checks assert that).

## 1. Files changed

| File | Change |
|---|---|
| `src/diagnostics/coordinateValidation.ts` | **new** — validation core: camera/viewport/splat capture, projection math, camera diffs, ray-consistency check, world-vs-splat-local space hypotheses, click/samples validation, aggregate stats, report assembly |
| `src/diagnostics/validationPanel.ts` | **new** — Coordinate Validation Panel DOM UI (Features A–C, F) + visual comparison overlay canvas (Feature D) |
| `src/diagnostics/types.ts` | additive types: `Matrix4Record`, `CameraStateRecord`, `ViewportRecord`, `SplatTransformRecord`, `ClickCameraSnapshot`; optional `RequestClickRecord.cameraSnapshot` |
| `src/diagnostics/AnnotationDiagnostics.ts` | constructor now takes `(scene, camera, canvas)`; `recordClick` freezes the full click-time snapshot; `setSplat` tracking; console validation API; `V` keyboard toggle; `dispose()`; panel refresh on `clear()` |
| `src/diagnostics/overlay.ts` | dev hint line now mentions the `V` shortcut |
| `src/script.ts` | passes camera/canvas into the diagnostics; `setSplat` wiring in `loadWorld`/`clearWorldResources`; `__sl` seam doc updated |
| `tests/CoordinateValidation.test.ts` | **new** — 31 deterministic Node tests |
| `scripts/annotation-diagnostics-validate.mjs` | source checks updated for the new wiring; 2 new browser tests; new production-bundle exclusion markers |
| `docs/annotation-diagnostics-task2-1c.md` | **new** — deliverable documentation |

## 2. Coordinate transformations implemented

```
world point
  -- recorded inverseWorldMatrix -->  camera-local
  -- recorded projectionMatrix  -->  clip (homogeneous, explicit w)
  -- w > 0 guard + perspective divide -->  NDC
  -- u = 0.5 + ndc.x·0.5,  v = 0.5 − ndc.y·0.5 -->  normalized screen
```

- The Y-axis convention was verified against the production code paths:
  normalized click v is top-down, NDC y is bottom-up (`splatRay` uses
  `ndcY = −(y·2−1)`; DOM tags use `(-pos.y·0.5 + 0.5)`).
- `w ≤ 0` ⇒ behind-camera: reported, never mirrored or divided.
- Pixel error uses the **click-time** canvas rect: `√((du·W)² + (dv·H)²)`.
- The splat transform is **never applied to pipeline data**. The recorded
  splat matrixWorld is used only inside `testSpaceHypothesis`, which
  *measures* whether a recorded point is more consistent with world space or
  splat-local space (a diagnosis, not a correction).

## 3. How SparkJS and Three.js coordinate spaces were verified

- **Three.js camera** (r0.180.0): right-handed world space, camera looks down
  local −Z; `matrixWorld` maps camera-local→world, `projectionMatrix`
  camera-local→clip.
- **SparkJS 2.0.0** — verified by reading the bundle source
  (`node_modules/@sparkjsdev/spark/dist/spark.module.js`, `SplatMesh.raycast`):
  Spark transforms the *world* ray into *mesh-local* space
  (`matrixWorld.invert()`), casts there, and reconstructs each hit as
  `worldRay.origin + worldRay.direction × localDistance`. That construction is
  world-correct **iff the splat transform is rigid** (rotation + translation,
  unit scale). `analyseSplatRaycastSpace` turns this into a live check
  reported in every validation report.
- **Empirically confirmed, not assumed:** against the real viewer, the
  click-hit reprojected to its original click with error **1.1e-16
  normalized (~5e-14 px)**, ray-consistency offset **0**, and all 121
  sampling hits reprojected with max error **4.3e-16**. The splat-local
  hypothesis errs by 0.416 normalized (~200 px) — hits are world space under
  the current rigid splat transform (`position (0, −1.5, 0)`), and the panel
  re-tests that per point on every request.

## 4. How click-time camera state is preserved

`AnnotationDiagnostics.recordClick` captures — synchronously, in the same
event turn as the Task 1 click probe — camera position, quaternion, world
matrix, inverse world matrix, projection matrix (verbatim elements, not
recomputed from fov/aspect, because those are what the renderer used), fov,
aspect, near, far, camera type, canvas bounding rect, canvas CSS and buffer
dimensions, device pixel ratio, and the splat's world transform. All of it is
frozen once into `request.click.cameraSnapshot` (an additive, optional field
— pre-2.1C records remain valid) and is **never mutated**. Validation-time
captures go to a separate `LiveCapture`. The live camera is never substituted
for click-time state: a missing snapshot produces an explicit `unavailable`
result with the reason, and inject-seam requests (no click) degrade to
ray-consistency checks only.

## 5. Reprojection methodology

1. Read the selected diagnostic request from the Task 1 records.
2. Use the recorded click-time camera snapshot (never the live camera).
3. Transform the recorded 3D hit by the recorded inverse world matrix →
   camera-local; apply the recorded projection matrix → clip.
4. Guard `w` (behind-camera flag), then perspective-divide to NDC.
5. Convert NDC to normalized screen coordinates (top-down v).
6. Error: `√((u_proj − u_orig)² + (v_proj − v_orig)²)` normalized, and the
   same error in pixels via the click-time viewport dimensions.
7. Cross-checks per point: ray consistency (`hit == origin + direction ×
   distance`?) and the world-vs-splat-local space hypothesis.

## 6. Test results — implemented vs. actually passed

Everything listed below was **run and passed on 2026-11-09** against the
final code:

- `npx tsc --noEmit` — clean (TypeScript checks pass).
- `npm test` — **135/135 pass**, including the 31 new tests in
  `tests/CoordinateValidation.test.ts`, which cover all ten required areas:
  1. known world point → known screen coordinate (hand-computed fixtures,
     plus an independent cross-check against `THREE.Vector3.project` on an
     off-axis camera),
  2. click-hit reprojection (zero error when self-consistent; exact expected
     errors when displaced),
  3. sampling-hit reprojection (per-cell rows + aggregates over projected
     hits; misses/behind-camera/unavailable counted, never silently dropped),
  4. camera movement between click and validation (diff detected; frozen
     snapshot still used),
  5. camera rotation between click and validation (π/2 rotation quantified),
  6. invalid/missing camera state (inject requests, legacy records without a
     snapshot, clicks without a hit — each reports its reason),
  7. points behind the camera (flagged; projection undefined),
  8. viewport-size differences (pixel error scales with the click-time
     viewport, not the current one),
  9. coordinate-space transformation handling (non-identity camera world
     matrix; splat-local hits identified as splat-local; non-rigid splat
     transforms flagged),
  10. pixel-error calculation (exact per-axis values; nearest-rank p95, true
      median).
- `npm run validate:diagnostics` — **12/12 browser tests pass** (headless
  Chromium, SwiftShader), including the two new ones:
  - *coordinate validation replays the click and sampling hits through the
    click-time camera* (real click-path request; normalized error < 0.005,
    pixel error < 5, space verdict `consistent-with-world`, all hits
    projected);
  - *the coordinate validation panel opens, lists requests, and leaves
    annotations untouched* (panel + overlay DOM exist, request dropdown
    populated, action buttons present, `V` shortcut works, annotation/
    record/visual state unchanged).
  The pre-existing click-path test now also asserts the full camera/viewport/
  splat snapshot is recorded. Evidence (including the measured errors quoted
  above) is stored in `docs/annotation-diagnostics-results.json` under
  `evidence.states.coordinateValidation`.
- Production-bundle check — `npm run build`, then grep of `dist/`: **zero**
  occurrences of `validateReprojection`, `CoordinateValidationPanel`,
  `coordinate-validation`, or any other diagnostics module code; app code is
  present, so the exclusion is real tree-shaking, not a broken build.

Not covered by automated tests (manual/dev-only by nature): the visual
appearance of the Feature D overlay, clipboard export, and JSON file
download. The overlay canvas and panel DOM existence are covered by the
browser suite; their rendering is inspectable in the dev viewer.

## 7. Production-bundle exclusion results

`vite build` output contains none of the new code. The runtime gate is the
existing pattern: the only construction site (`new AnnotationDiagnostics(
scene, camera, canvas)`) is inside `if (import.meta.env.DEV)`, so Vite DCE
removes the entire `src/diagnostics/` module graph — Task 1 and Task 2.1C
alike — from production bundles. `window.__sl.diagnostics` is `null` in
production and every call site uses optional chaining.

## 8. Known limitations

- Inject-seam requests (`__sl.inject`) have no click, hence no click-time
  camera snapshot: sample validation degrades to ray-consistency checks and
  reports the limitation explicitly (never a silent live-camera substitute).
- The validation overlay's "live" markers reflect the camera at the last
  redraw — drawing is on-demand (no render loop, by design).
- `p95` is nearest-rank (`ceil(0.95·n)`), not interpolated.
- Browser zoom between click and validation changes `devicePixelRatio`; the
  diff table surfaces it rather than normalizing it away.
- A low reprojection error proves **geometric** consistency only — never
  semantic object identity.

## 9. Reproducing the validation in the browser

1. `npm run dev`, open the viewer, wait for the world to finish loading.
2. Enable the annotation tool (toolbar button) and click an object.
3. Press **V** — or run `window.__sl.diagnostics.toggleValidationPanel()` in
   the console — to open the Coordinate Validation Panel.
4. Select the request in the dropdown; the camera table shows click-time vs
   current state with deltas (position, quaternion, fov/aspect/near/far,
   camera type, canvas rect, buffer/DPR, plus the raw matrices).
5. Click **Validate Click-Hit Reprojection** — original vs projected
   coordinates, normalized + pixel error, behind-camera/clip flags, ray
   consistency, and the world-vs-splat-local space verdict.
6. Click **Validate All Sampling Hits** — per-detection counts, aggregate
   stats (mean/median/max/p95, normalized + pixels), and the full per-cell
   table (misses and failures included, with status).
7. **Export JSON** / **Copy JSON** for the full report;
   **Refresh live camera** to re-capture the validation-time state;
   **Overlay: on/off** toggles the Feature D visualization over the 3D view.
8. Console equivalents: `window.__sl.diagnostics.validateReprojection()`,
   `.validateSamples()`, `.exportValidation()`, `.toggleValidationPanel()`
   (each optionally takes a request index).

## 10. Relevance to the Checkered Rug case

The measured reprojection error against the real viewer is ~1e-16 — the click
ray → hit geometry is **self-consistent at click time**, so the ~470 px
marker-vs-crosshair offset cannot come from a click-ray/hit coordinate
mismatch. The panel now exists to discriminate the remaining suspects with
data: post-click camera movement (Feature A diff table), anchor-vs-click-hit
placement (the DBSCAN anchor can legitimately sit far from the click — see
the Task 1 notes on eps 0.3), and DOM projection (Feature D frozen-vs-live
markers). This task deliberately does not pick a winner.
