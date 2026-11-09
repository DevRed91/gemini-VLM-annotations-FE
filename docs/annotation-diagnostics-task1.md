# Task 1 — Diagnostic Instrumentation for the 2D→3D Annotation Pipeline

**Status: complete — awaiting review. No algorithm changes were made and none are proposed here. Task 2 is blocked on this review.**

This document describes the development-only diagnostic instrumentation added between Gemini's 2D detection and the final 3D annotation placement, how to use it to reproduce the **Checkered Rug incorrect-tag-placement** case, what is already *verified* versus what remains *hypothesis*, and the validation performed.

---

## 1. Design

Three coordinated surfaces, all driven from one data contract:

1. **Structured records** (`src/diagnostics/types.ts`) — one `AnnotationRequestDiagnostics` per annotation request (one click → one Gemini call → N detections), plus one `DetectionDiagnostics` per detection. Records are plain JSON (no THREE.js objects, no cycles) so they can be pasted straight into a bug report: `JSON.stringify(window.__sl.diagnostics.last(), null, 2)`.
2. **3D scene markers** (`src/diagnostics/markers.ts`) — in-scene points, ray stems, cluster centroids, boxes, and spheres for every stage.
3. **2D overlay** (`src/diagnostics/overlay.ts`) — a frozen snapshot of the frame sent to Gemini, drawn over with the raw and sanitized boxes, the sample grid with per-cell hit/miss colouring, and a legend panel with every number.

Records are the single source of truth: after each pipeline stage the 3D group and overlay are rebuilt from the record, so a failure mid-pipeline still shows every stage that ran before it. Diagnostics are strictly write-only observers of the pipeline — nothing feeds back into the annotation path.

**Dev-only gate.** `AnnotationDiagnostics` is constructed only inside `if (import.meta.env.DEV)` (`src/script.ts:193`); everywhere else the field is `null` and all calls go through `?.` / conditional argument spreads. Vite/rollup dead-code-eliminates the whole module: the production bundle contains **zero** occurrences of any diagnostics symbol (verified by `validate:diagnostics`, phase B).

---

## 2. Stage map

| Stage | Production code | What the diagnostics expose |
|---|---|---|
| Click | `src/script.ts:288` (`splatRay` + `recordClick`) | Frozen click record: normalized (nx, ny), client (cx, cy), camera position/quaternion, ray origin+direction, hit position+distance (or null) |
| Gemini request/response | `src/script.ts:1209–1245` | `source`, `worldGeneration`, snapshot data URL (latest request only), raw parsed response body |
| Detection | `annotateFromDetection` `src/script.ts:1005` | Per-detection record with `label` and the raw box exactly as received |
| Box sanitize | `sanitizeDetectionBox` `src/script.ts:962` (clamp to [0,1], reject < 0.02) | `rawBox` (clamped for display) vs `sanitizedBox`, plus rejection reason (`invalid` / `too-small`) |
| Sample grid | `samplePointsFromBox` `src/script.ts:974`, grid size formula `src/script.ts:75` | Grid size, box area, per-cell normalized (x, y), ray origin+direction, hit distance + position, hit ordinal (index into the DBSCAN input), hit/miss counts |
| DBSCAN | `GeometricContextManager.ts:44–60` (eps 0.3, minPts 10 non-LOD / 4 LOD — unchanged) | **Every** cluster with index, size, mean centroid, AABB bounds, extent, point indices, colour, selection flag; true noise set and the raw library noise list; `selectedClusterIndex` |
| Cluster selection | `GeometricContextManager.ts:63–65` (largest, earliest wins ties — unchanged) | `isSelected` flag + `selectionRule: "largest"` |
| Measurement | `GeometricContextManager.ts:67–72` (AABB centre) | Measured centroid (= **AABB centre**, not mean), dimensions, bounds |
| OBB | `fitOBB` (`src/utils/obbFit.ts`) | OBB position/quaternion/size, method (pca / aabb-fallback), eigenvalues |
| Lift | `src/script.ts:1080–1106` | Selection counts (selected / numSplats / candidates / opacityRejected / scanDurationMs), or a note explaining why no lift ran (highlighter disabled) |
| Anchor | `src/script.ts:1108–1147` | Anchor position + source: `cluster-centroid` (success) or `click-hit` / `box-centre-raycast` (fallback), plus the attached annotation id |
| Failures | every bail-out in `runDetectionPipeline` | `failures: [{stage, reason}, …]` — all of them, in order (a fallback can follow a failure) |

---

## 3. Controls and data access

- **`D`** — toggle all diagnostics (3D markers + overlay) on/off.
- **`O`** — toggle only the 2D overlay.
- **`V`** — open/close the Coordinate Validation Panel (Task 2.1C).
- Both keys are ignored while typing in an input/textarea/contenteditable and when modifier keys are held.

**UI cleanup note:** every diagnostic surface starts **hidden** — no diagnostic UI is visible when the viewer loads or while annotating. Records still accumulate regardless (they are the data source for the panel and console API); press `D` to show the 3D markers + overlay on demand.

Console (dev only): every completed detection logs a multi-line summary prefixed `[annotation-diagnostics]` — anchor source, failures, box, grid hit/miss counts, all cluster sizes + centroids + extents + which is selected, noise, measured centroid, OBB, lift, anchor.

`window.__sl.diagnostics` (DEV only; `null` in production):

```js
__sl.diagnostics.list()            // all retained request records (max 20)
__sl.diagnostics.last()            // most recent request record (with snapshot)
__sl.diagnostics.toggle()          // 3D + overlay on/off; returns new state
__sl.diagnostics.toggleOverlay()   // overlay only; returns new state
__sl.diagnostics.clusterColors(n) // the first n cluster colours
__sl.diagnostics.liveGroupCount    // number of live 3D groups (max 12, FIFO eviction)
__sl.diagnostics.visualObjectCount // total diagnostic objects in the scene
__sl.diagnostics.overlayHasContent // overlay painted?
```

### Visual language (3D)

| Colour | Meaning |
|---|---|
| Gold | original click hit |
| Pale blue | sample ray hits (before/without cluster membership) |
| Red | miss rays (12 m long) |
| Grey | noise points |
| Distinct hues (golden-angle palette) | each DBSCAN cluster's points + labelled centroid octahedron: `C#i · N pts [SELECTED]` |
| Orange wireframe | measured AABB of the selected cluster |
| Magenta sphere | measured centroid (the anchor candidate) |
| Cyan wireframe | OBB, with centre octahedron |
| Red sphere | final annotation anchor |

The click ray, hit sphere and distance label are drawn from the frozen click record, so they stay valid even after the camera moves.

### Visual language (2D overlay)

Frozen dimmed snapshot + click crosshair; raw box (dashed magenta) vs sanitized box (solid cyan); per-cell green (hit) / red (miss) fills; a legend panel repeating every number above with colour swatches per cluster, including a note when the library noise list disagrees with the true noise set.

---

## 4. Cleanup

- Removing one annotation removes its diagnostic visuals: `removeAnnotationVisual` → `detachAnnotation(annotation.apartmentId)` (`src/script.ts:478`). Data records are kept (they're the evidence); only the 3D group is disposed.
- Clearing the world drops everything — visuals, records, overlay: `clearWorldResources` → `diagnostics.clear()` (`src/script.ts:500`).
- Every marker's geometries/materials/textures are disposed (`disposeObjectTree` in `markers.ts`).
- Bounded memory: 20 request records, one retained snapshot (the latest), 12 live 3D groups (FIFO eviction).

---

## 5. Reproducing the Checkered Rug issue

1. **Frontend (dev):**
   ```bash
   npm install
   npm run dev
   ```
2. **Backend with Gemini access** (sibling repo):
   ```bash
   cd ~/Semantic_Uplifiting/gemini-VLM-annotations-BE
   # ensure GEMINI_API_KEY is set per that repo's README
   npm run dev   # or the repo's usual start command
   ```
3. In the viewer, load the Checkered Rug world (the scene where the rug tag lands in the wrong place).
4. Activate the annotation tool (the toolbar button), then **click on the checkered rug**.
5. Read the evidence:
   - **Overlay (`O` to toggle):** does the *raw* Gemini box hug the rug, or does it spill onto the surrounding floor? Which grid cells hit, and do the hit distances look like one surface or two (rug top vs floor beneath)?
   - **3D (`D` to toggle):** orbit around the markers. Are there one or several coloured clusters inside the box? Is the orange AABB sitting on the rug or bridging rug + floor? Does the red anchor sphere sit on the rug?
   - **Console:** the `[annotation-diagnostics]` block gives exact numbers — `clusters [0:N 1:M …]`, per-cluster centroid/extent, measured centroid, and `anchor=…`.
   - **Data:** `copy(__sl.diagnostics.last())` gives the full machine-readable record for the bug report.
6. Repeat from a couple of different camera angles / click points on the rug; the click record freezes the camera pose so you can compare runs.

---

## 6. Observed evidence (verified) vs unresolved hypotheses

### Verified facts (code + tests)

- **The anchor is the AABB centre of the largest DBSCAN cluster, not the cluster mean and not the OBB centre.** `GeometricContextManager.ts:63–72` selects the largest cluster and returns `box.getCenter(...)`; `script.ts:1108–1121` places the annotation at `measured.centroid`. The OBB is used for the Gaussian lift/highlight only — so a tag can visually disagree with the highlight box even when both are "correct" by their own definitions.
- **Sample rays that miss are silently dropped** (`script.ts:998–999`): misses never enter DBSCAN and nothing logged them before; they are now recorded per cell.
- **DBSCAN parameters and the largest-cluster rule are unchanged** (eps 0.3, minPts 10 non-LOD / 4 LOD at `script.ts:1044`; reduce at `GeometricContextManager.ts:63`). eps = 0.3 is *large* relative to a rug's thickness (centimetres): any two sample hits within 0.3 world units chain together, so rug + nearby floor hits merge into a single cluster and the AABB centre lands between them.
- **Boxes smaller than 0.02 in either axis are discarded** (`script.ts:969`) and raw values outside [0,1] are clamped (`script.ts:966–968`) — a box that spills off-image gets clamped, changing its effective area before sampling.
- **The DBSCAN library's `noise` list is not the true noise set**: border points first marked noise can later be adopted by a cluster expansion yet remain in `DBSCAN#noise`. The diagnostics report both (`noise` = complement of cluster membership, `libraryNoise` = raw list) and flag the difference. Demonstrated deterministically in `tests/AnnotationDiagnostics.test.ts` ("library noise can include points a cluster later adopted").
- **Pre-existing Spark quirk (not caused by this work):** splat raycasting returns nothing immediately after `splat.initialized` resolves — the renderer needs a moment to settle before raycasts hit. Production users always click long after load, so this only matters for automation/tests. Documented because a diagnostic session started the instant a world loads would otherwise look like "every ray missed".

### Unresolved hypotheses for the rug case (what the diagnostics should now disambiguate)

These are hypotheses about the dominant mechanism — deliberately **not** fixed in this task:

- **H1 — Box bleed:** Gemini's box for the rug includes surrounding floor; eps = 0.3 merges rug + floor hits into one cluster whose AABB centre is pulled off the rug. *Prediction: one big cluster, orange AABB visibly bridging rug and floor, extent ≫ rug thickness, miss-free grid.*
- **H2 — Ray punch-through:** semi-transparent rug splats let rays hit the floor beneath, mixing floor points into the rug's own cluster even with a tight box. *Prediction: hit distances bimodal within cells that all fall on the rug.*
- **H3 — Wrong cluster wins:** multiple clusters exist and a non-rug cluster (floor patch, furniture leg) is the largest. *Prediction: ≥ 2 clusters, selected one visibly off-rug in the 3D view.*
- **H4 — Centroid vs OBB display mismatch:** the placement is "correct" per the centroid rule but reads as wrong because the highlight follows the OBB. *Prediction: anchor sits at the orange AABB centre, tag offset from the cyan OBB centre.*
- **H5 — Miss-starved sampling:** many grid rays miss (thin rug at grazing angles), so the surviving hits are a biased subset. *Prediction: large red miss count in the overlay, hits clustered to one edge of the box.*

Running the reproduction steps above on the rug scene will select between these directly from the overlay and console block, with the machine-readable record as the artifact.

---

## 7. Files

**Added**
- `src/diagnostics/types.ts` — data contract (records).
- `src/diagnostics/records.ts` — pure record builders + console summary (no rendering, unit-testable).
- `src/diagnostics/clusterPalette.ts` — distinct, deterministic cluster colours.
- `src/diagnostics/markers.ts` — 3D marker builders + `disposeObjectTree`.
- `src/diagnostics/overlay.ts` — 2D snapshot overlay.
- `src/diagnostics/AnnotationDiagnostics.ts` — orchestrator, keyboard, cleanup, `__sl` seam surface.
- `tests/AnnotationDiagnostics.test.ts` — 15 unit tests.
- `scripts/annotation-diagnostics-validate.mjs` — `npm run validate:diagnostics`.
- `docs/annotation-diagnostics-results.json` — machine-readable validation evidence.

**Modified**
- `src/GeometricContextManager/GeometricContextManager.ts` — opt-in `onClusters` collector (pure observer; fires before the unchanged selection code); `DBSCANClusterReport` type.
- `src/script.ts` — recorder calls at every stage (all dev-guarded, all `?.`), `splatRay` extraction, DEV-only construction, cleanup wiring, `__sl.diagnostics` getter.
- `package.json` — `validate:diagnostics` script.

**New dependencies: none.** DBSCAN parameters, cluster-selection logic, grid formula, and sanitize thresholds are byte-identical to before (asserted by the validation script's source checks).

---

## 8. Validation performed

`npx tsc --noEmit` — clean. `npm test` — all green, including the 15 new tests covering: collector parity (clustering/selection/measurement identical with and without the collector), all-clusters + true-noise reporting, the library-noise adopted-border-point case, collector never firing below minPts, palette distinctness/determinism, sanitize thresholds, raw-box clamping, sampling ordinals/counts, clustering selection/noise/failure paths, the largest-cluster tie rule, the full happy-path record with JSON round-trip, and failure summary formatting.

`npm run validate:diagnostics` (`docs/annotation-diagnostics-results.json`):
- **Phase A — 9 source checks**: DBSCAN params unchanged, sanitize clamp + 0.02 minimum, sample-grid formula unchanged, diagnostics constructed only in DEV, per-annotation cleanup wired, world-clear cleanup wired, largest-cluster logic unchanged, collector opt-in and inert by default.
- **Phase B — bundle exclusion**: `vite build` output contains zero occurrences of `DiagnosticOverlay`, `buildDetectionGroup`, `clusterColor(`, `AnnotationDiagnostics(`, `detachAnnotation`.
- **Phase C — 10 Playwright browser tests** (headless Chromium + SwiftShader): seam availability; deterministic inject recording every stage; distinct cluster colours; 3D groups + painted overlay after inject; `D`/`O` toggles (including the input-field guard); annotation-removal cleanup; clear-all cleanup; **click-path request with a mocked Gemini response recording the click and response stages end-to-end**; world-reload clearing records/visuals/overlay; production annotation behaviour preserved (absolute counts, registry membership).
- All runs finished with **0 console errors and 0 page errors**.

**Run constraint:** the browser suite renders with SwiftShader (software rasterization), and the click-path test is the only test that exercises `captureSnapshot` — a synchronous `render()` + `getContext().finish()` GPU sync + `toDataURL` readback (`src/script.ts:1156–1166`). Under concurrent CPU load (e.g. running `npm test` alongside), that sync can stall past the test's 60 s timeout and make the click-path test — and, through the stalled page, the two tests after it — fail spuriously. Confirmed by repeated runs: 2/2 green when the suite runs alone, 2/2 red under concurrent load. Run `npm run validate:diagnostics` without other heavy commands sharing the machine. This is a test-environment artifact, not a pipeline defect.

---

## 9. Next

**Stop here for review.** Task 2 (algorithm changes, e.g. tightening eps, choosing the cluster nearest the click rather than the largest, or anchoring on the OBB centre) must wait until the diagnostics above have been run against the Checkered Rug scene and the dominant hypothesis is identified. Whichever fix is chosen should be driven by the recorded evidence, not by assumption.
