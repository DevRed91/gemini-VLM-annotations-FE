# Phase 3 Plan — Multi-Object Index-Mask Integration

## Context

Review commit `41123a3` (`Add phase 2 index lifting experiment`) and use its findings plus the earlier phase reports to define the next implementation phase. The selected direction is integration of the Phase 1 OBB baseline with Phase 2 index masks. This document is a plan only; implementation requires a separate request.

## Latest-commit review

Commit `41123a3` adds a focused, isolated experiment across 10 files (1,899 insertions):

- `src/utils/clusterLifter.ts` converts an existing world-space OBB to sorted, deduplicated storage indices using Gaussian centres and source opacity. `src/utils/gaussianIndexSupport.ts` explicitly rejects LOD/paged sources.
- `src/utils/gaussianMaskManager.ts` owns one 4096-wide R8UI binary mask and one modifier, with changed-byte/no-op tracking and idempotent disposal. It currently maps every selected splat to the same magenta tint.
- `src/utils/hoverTint.ts` now appends modifiers rather than replacing the singular modifier slot, allowing mask/hover composition.
- `src/experiment/phase2Harness.ts` and `scripts/phase2-validate.mjs` exercise lifting, shader agreement, 4096-row boundaries, transforms, updates, disposal, LOD rejection, and one real-asset render.

The committed results contain 20 passing assertion-bearing groups plus one informational record. Synthetic reference/negative-control tests provide strong evidence for the declared non-LOD mechanism. The single `Apartment.sog` run scanned 699,086 splats, accepted 644,105, and reported 58.2 ms lifting plus 38.1 ms mask rewriting under SwiftShader; the first visible highlight was frame 2. These are one-run whole-scene measurements, not object-level latency or hardware-GPU benchmarks.

### Limits and integration findings

- Phase 2 does not implement OBB fitting, semantic ownership, Gemini integration, production interaction, multiple labels/colors, or LOD/paged support.
- The current branch is based on Phase 0 and does not contain the Phase 1 implementation on `origin/phase1/obb-baseline`. The current viewer still installs only hover tint and defaults to `Apartment-lod.rad`.
- Phase 1 must be ported selectively, not merged wholesale: the branch diff includes unrelated changes and would delete Phase 2 files. Relevant inputs are `src/utils/obbFit.ts`, `src/GeometricContextManager/GeometricContextManager.ts`, the detection-to-cluster path in `src/script.ts`, `density-clustering` dependencies, and the Phase 1 validation/dev-hook patterns.
- Two calls to the current binary `replace()` cannot represent two objects: the second replaces the first, clear is global, and overlap behavior is undefined.
- The lifter accepts finite non-unit OBB quaternions even though the OBB transform contract is rigid; Phase 3 should normalize fitted rotations and reject non-unit inputs at the lifting boundary.
- Hover does not retain/dispose its modifier. Reload currently lacks a clear owner for old hover/mask/splat resources and stale asynchronous loads.
- The validator trusts the browser report and has no expected-test manifest. Playwright is neither declared nor installed, so the committed validator cannot run in this workspace as-is.

### Review verification

- `git diff --check HEAD^ HEAD` passes; JavaScript syntax checks pass.
- `tsc --noEmit --incremental false` reports nine existing errors in files untouched by this commit and none in the new Phase 2 modules.
- `node scripts/phase2-validate.mjs` stops because Playwright is missing. No dependencies were installed and no result artifacts were overwritten during this review.

## Phase 3 objective and scope

Integrate the Phase 1 fitted-OBB result with Phase 2 `liftCluster()` and a label-aware mask so two extracted objects can remain highlighted simultaneously with distinct stable IDs/colors. Target static, non-LOD `Apartment.sog`; retain OBB tint as the fallback for unsupported sources.

In scope: add/update an object, clear one, clear all, deterministic overlap behavior, hover/effect composition, reload/disposal cleanup, real-scene browser validation, and repeated timing/resource measurements.

Out of scope: Gemini/VLM changes, semantic-association improvements, actual LOD/paged index lifting, Worker/spatial acceleration, dynamic source topology, and broad mobile/hardware performance claims.

## Implementation plan

### 1. Port the Phase 1 baseline without losing Phase 2

- Selectively port `src/utils/obbFit.ts`, `src/GeometricContextManager/GeometricContextManager.ts`, and the detection-to-cluster viewer path from `origin/phase1/obb-baseline`. Add the required `density-clustering` runtime and type dependencies.
- Preserve the current Phase 2 modules, modifier-chain fix, response error handling, assets, and unrelated viewer behavior; do not merge the branch diff wholesale.
- In `src/script.ts`, pass the fitted world-space OBB directly to `liftCluster()`. Retain `obbWorldToLocal()` only for the OBB fallback/helper, avoiding a second world/local conversion for index lifting.
- Normalize fitted OBB rotations and tighten `src/utils/clusterLifter.ts` to reject non-unit quaternions with a documented tolerance and regression test.
- Use `Apartment.sog` for the integrated path. Keep the Phase 1 OBB tint fallback for sources rejected by the shared non-LOD guard; do not claim LOD index support.

### 2. Generalize the existing mask rather than stacking mask managers

- Extend `src/utils/gaussianMaskManager.ts` into a label-aware manager while retaining a binary-compatible `replace()` wrapper for Phase 2 regression coverage.
- Keep one 4096-wide R8UI texture and one mask modifier per `SplatMesh`: `0` is unselected and labels `1..255` identify objects. Replace the hard-coded magenta uniform with a 256-entry palette texture; reserve entry zero and keep tint strength explicit.
- Add label-level replace/clear operations and per-object sorted-index state. Define overlap precedence as most recently added/updated selection wins; when that selection changes or is cleared, recompute affected texels from remaining memberships so an underlying selection is restored.
- Preserve duplicate/invalid-ID diagnostics, changed-byte accounting, no-op submission suppression, and idempotent disposal. Updating object B must not rewrite or erase object A, and clearing A must leave B intact.
- Reuse the existing `gsplat.index` bounds check and row addressing. Keep the source static for this phase; no dynamic topology or LOD mutation support.

### 3. Add one per-world selection/lifecycle owner

- Add `src/utils/gaussianObjectHighlighter.ts` to coordinate `liftCluster()` and the shared label mask. Its API should support add/update from a world OBB, clear-one, clear-all, disposal, stable in-session IDs/colors, and diagnostic snapshots. Serialize operations per world and ignore completions from stale load/selection generations.
- Update `src/utils/hoverTint.ts` so `HoverTint` retains its modifier, clears its active state, and removes only that modifier through idempotent `dispose()`. Install persistent masking before transient hover so hover previews remain visible and clearing hover restores the persistent colors. Preserve independent third-party effect modifiers.
- In `src/script.ts`, replace Phase 1’s single `clusterTint`/helper with the coordinator. Associate each annotation’s pin and OBB helper with its selection ID; removing an annotation clears only that selection, and world reload clears all annotations, helpers, selections, hover, textures, and old splat resources.
- Guard asynchronous world initialization/reload with a monotonically increasing generation so late work cannot attach to a new world. Dispose a newly created world if its load becomes stale.
- Keep the existing Gemini endpoint/request behavior unchanged. Reuse the Phase 1 DEV-only injection seam for deterministic post-response detection tests.

### 4. Make browser validation reproducible and integration-focused

- Add Playwright as a dev dependency and npm scripts for Phase 2 and Phase 3 validation; document the one-time Chromium installation. Keep `CHROME_EXE`/external-server overrides for existing workflows.
- Add `phase3.html`, `src/experiment/phase3Harness.ts`, and `scripts/phase3-validate.mjs`, following the Phase 2 server/error-collection pattern. Use fresh fixtures or `finally` cleanup per test and an explicit expected-test manifest so missing tests fail the run. Wait on world/selection readiness and independently checked visible output rather than fixed sleeps, because Phase 1 recorded stale/corrupted short-settle frames.
- Exercise the actual `index.html` viewer through its DEV-only detection hook as well as deterministic low-level fixtures. Write `docs/phase3-results.json` and a Phase 3 investigation report containing environment, selections, timings, diagnostics, and limitations; do not overwrite Phase 2’s recorded evidence.
- Update `README.md` with the supported non-LOD path, validation commands, and fallback behavior.

## Acceptance and verification

1. **Multi-object correctness:** two disjoint objects are simultaneously visible with distinct stable colors. Updating B leaves A’s membership/pixels unchanged; clearing A leaves B pixel-identical; clear-all restores the exact RGB baseline.
2. **Overlap and addressing:** overlapping selections follow the documented latest-update precedence and restore the underlying label after removal. Keep shifted-ID negative controls and IDs around 4095/4096 and 8191/8192.
3. **Transforms and fitting:** Phase 1 basic/translated/rotated checks still pass; whole-splat rigid motion preserves both index sets and moves both highlights. Changing one OBB re-lifts only that object. Non-unit quaternion input is rejected.
4. **Composition:** hover over A, B, and unselected space has the chosen order, persistent colors return after hover clears, and a representative effect modifier survives select/clear/dispose. No mask-modifier stacking occurs.
5. **Lifecycle:** repeated create/update/clear/dispose cycles and reloads leave no accumulating modifiers, textures, annotation DOM nodes, or helpers. A stale load/selection cannot modify the active world; reload restores the baseline state.
6. **Real-scene integration:** inject two fixed detections into non-LOD `Apartment.sog`; require nonempty plausible object-sized index sets, visible distinct highlights, zero-RGB-diff comparison against equivalent independent region references, and nonzero shifted-ID controls. Report any background inclusion as center/OBB membership, not semantic segmentation accuracy.
7. **Performance/resources:** over at least 20 repeated object selections, record median and p95 for lift, mask rewrite/submission, and time to first visible correct highlight. Use the roadmap’s roughly 200 ms CPU scan target for the 699,086-splat reference environment, and separately report frame visibility and idle/interactive frame-time effects. Track texture bytes, selected-ID storage, modifier counts, and submissions.
8. **Hard gates:** all expected Phase 2 and Phase 3 tests pass, with zero shader, page, console, and final GL errors. Run `npm run build` and the no-emit TypeScript check; compare type diagnostics with the documented nine-error baseline and require no new Phase 3 diagnostics. Perform a manual `npm run dev` smoke test for two selections, hover, clear-one/all, reload, and the unsupported-LOD fallback.

## Deliverables for the implementation phase

- Phase 1 OBB/extraction integration on the current branch.
- Label-aware mask, palette, multi-object coordinator, and owned lifecycle cleanup.
- Reproducible Phase 3 browser harness and validator.
- `docs/phase3-results.json` and a Phase 3 investigation report with measured evidence and limitations.
