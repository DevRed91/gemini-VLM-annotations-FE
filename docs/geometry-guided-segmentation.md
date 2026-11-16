# Geometry-guided segmentation experiment (SAM 3)

Status: experimental, DEV-only (`?demo=1&present=1&seg=1`). The FE/BE plumbing is validated end-to-end against a **mock** provider. **A FAL SAM 3 adapter exists but has not yet been validated against real inference**, so nothing here says whether geometry-guided prompting beats text/box prompting.

## 1. Assessment (Part 1)

### Selection-to-world flow
- Click handler: `src/script.ts` ~316 → `captureBoundSnapshot()` → `assertPoseUnchanged` → `snapshotSplatRay(binding, liveWorldState(), x, y)` (~324).
- The click world position is a **snapshot-bound `SplatMesh.raycast` hit**. It is not a depth readback (deliberately avoided, see comment at `samplePointsFromBox` ~1010) and not a provisional value.
- Box path: `samplePointsFromBox` (~1011) casts a grid of rays through the box; `annotateFromDetection` (~1044) runs DBSCAN + OBB fit. Anchor fallback: click hit, then box-centre ray (~1186).
- Cost: ~35 ms/ray on office_space.sog; Spark raycast needs ~3 s settle after `splatLoaded`.

### Projection and snapshot conventions
- `src/viewer/ViewSnapshot.ts`: `captureViewSnapshot`, `projectSnapshotPoint`, `generateSnapshotRay`. Stores camera world/inverse/projection matrices, viewport, `splat.matrixWorld`.
- Image coordinates: CSS pixels, origin top-left, y down.
- `src/viewer/SnapshotBinding.ts`: `bindSnapshot` throws `StaleSnapshotError` (`no-splat | world-generation | splat-instance | splat-transform`).
- Presentation slots (`src/demo/presentationCaptures.ts`): **front, side, top** (Shift+1/2/3). The third slot was originally "rear"; it was renamed to Top. Slots are labels the presenter assigns by hand, so the Top slot holds whatever view was captured into it: place the camera above the object looking down before pressing Shift+3.

### Failure cases for a projected anchor
1. Behind camera / outside frame (`projectAnchorToImage` status).
2. **Occluded**: anchor in-frame but another surface is nearer along that ray (`visibility: occluded`). The point then lands on the wrong object. This is the main pillow-on-sofa risk.
3. Unstable anchor: 9-ray refinement hit count / spread (`stable`).
4. Known production bug: annotation OBB helper `LineSegments` children hijack `Raycaster.intersectObject(splat)`. The experiment uses `createSplatCaster` (direct `splat.raycast`) which is immune (validated).
5. Mask returned for the wrong object; handled by cross-view agreement / centroid probes and recorded, not assumed correct.

## 2. Architecture (implemented)

FE `src/segmentation/`: `contract.ts` (provider-neutral request/response, image px, RLE masks), `geometry.ts` (projection, visibility, anchor refinement, direct caster), `maskAnalysis.ts`, `experiment.ts` (pure orchestrator; variants text / point / point+text / box; `occlusionPolicy: send|skip`), `client.ts`, `SegmentationController.ts`, `SegmentationPanel.ts`, `bootstrap.ts` (`window.__seg`). Mounted from `src/script.ts` only under `import.meta.env.DEV` + `?seg=1`; verified absent from the production bundle.

BE (`gemini-VLM-annotations-BE`): `segmentation.ts` + `POST /api/segment` in `server.ts`. `SEGMENTATION_PROVIDER=mock` is refused in production and every mock result is flagged `mock: true`. 200 ok / 501 no provider / 400 bad request / 502 provider failure.

## 3. Validation
- `npm test`: 297/297. `tsc --noEmit` clean. `npm run build` ok.
- BE `segmentation.ts`: 6/6 node tests.
- `node scripts/geometry-segmentation-validate.mjs` (Metal): 15/15 against the mock backend. Covers pick-click consumption, stable anchor, three captures, projection round-trip (<1e-14 px-ray miss), helper-pollution immunity, full run. Needs the BE running with `SEGMENTATION_PROVIDER=mock CORS_ALLOWED_ORIGINS=http://127.0.0.1:5213 PORT=3917`.
- The validator used office_space.sog; the pillow-on-sofa scene was **not** found in the repo, so the target case is untested.

## 4. Real SAM 3 provider (FAL): adapter built, real inference pending
The backend now has a `fal` provider (`SEGMENTATION_PROVIDER=fal`, `FAL_KEY` backend-only) that calls `fal-ai/sam-3/image`, downloads/decodes the PNG masks and returns the same RLE contract; see `docs/fal-sam3-provider.md`. Mocked-HTTP tests pass; **a real FAL inference has not yet succeeded** (account balance exhausted), and FAL does not document input coordinate units, so pixel units remain an assumption until `fal-validate.ts` passes. Self-hosted SAM 3 remains the alternative (no torch/GPU locally).

## 5. Semantic-to-geometric handoff (Gemini selection -> verified anchor)

Code: `src/segmentation/semanticAnchor.ts` (pure), `SegmentationController.adoptSelectedObject()`, panel button "Use selected Gemini object". DEV-only like the rest of `src/segmentation/`.

**Semantic identification (Gemini) is not geometric verification.** Gemini sees three unrelated JPEGs: no camera, no depth. Its boxes say *which object* and *where in each image*; the centre of a box is not a point on the object (a ring, a chair, or a sofa with a pillow on it all break that assumption), and agreement between its per-view boxes is a claim, not a measured correspondence.

### Contract
`associateSemanticTarget(selected: SelectedMultiViewObject, peers: MultiViewObjectDetection[], { live, cast }) -> AssociationOutcome`
- `verified`: `SemanticGeometricHandoff { semantic (the selection, untouched), anchor: GeometricAnchor, views: ViewInput[] (the retained snapshots Gemini saw) }`. `GeometricAnchor` has the world point, its `AnchorRefinement`, `derivation` (source view/capture/snapshot ids and the box rays were cast through), `worldGeneration`, and `verification` (per-view `ViewCheck`s, corroborating views, rejected alternates).
- `rejected`: `{ reason, message, candidates[], fallback: "user-click" }`. No point is returned.
- `ExperimentConfig.anchor` stays a plain `SnapshotVector3`; `runExperiment`, `CandidatePoint`, DBSCAN and OBB are untouched. The controller runs a semantic anchor on `handoff.views`, not on whatever the slots hold at run time. Click anchors are unchanged (`AnchorPick.source = "user-click"`).

### Procedure (per view with a visible Gemini box = one candidate)
1. 9 rays through a small patch at the box centre (`probeFraction` 0.1) -> real splat hits. The point is the medoid of the hits, never the box centre. Stable only if the median spread is within 2x the patch's world size (scaled to the box, not a fixed distance) and >= 75% of rays are inliers; otherwise `unstable-depth` (object plus background) or `no-surface-hit`.
2. Check the point against every capture: stale (`bindSnapshot`: world generation, splat instance, splat transform), projection (`projectAnchorToImage`), visibility (`classifyVisibility`), and Gemini's box for that view with a 3% margin.
3. Verdicts: inside box + visible = corroborated; outside box, anchor out of frame/behind camera where Gemini says visible, or Gemini says not visible while the anchor is plainly visible = contradicted; occluded / no observation / no capture / stale = neutral (never counted as support).
4. A smaller peer box containing the visible anchor means the point sits on something more specific than the target (pillow on sofa): `ambiguous-object`.
5. Verified = no contradiction, no more-specific object, >= `minCorroboratingViews` (default 1) corroborating views. The best verified candidate wins (most support, then tightest hit cluster).

### Limitations
- Verified means "a real, stable surface point, current for this world, not contradicted by and supported by an independent Gemini box". It does not prove the point lies on the object Gemini meant: loose boxes can corroborate a neighbour, and a larger neighbour's box also contains the anchor (only *smaller* peers are flagged).
- An object visible in one view only is rejected (`uncorroborated`) unless `minCorroboratingViews: 0` is passed explicitly.
- Anchors on the far side of an object are occluded in other views, so they yield neutral rather than corroborated.
- Thresholds (patch size, factor 2, 75% inliers, 3% margin) are unvalidated guesses from synthetic scenes. Not yet run on a real scene or against real Gemini boxes. Perspective cameras only. Cost ~9 rays x up to 3 views + 1 line-of-sight ray per check, ~35 ms each.
- Peers are used only for the specific-object check; no cross-object reasoning, no multi-view fusion.
- Tests (`tests/SemanticAnchor.test.ts`, 22) use analytic spheres/plane; no SAM 3 or Gemini calls.
