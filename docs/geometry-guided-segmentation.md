# Geometry-guided segmentation experiment (SAM 3)

Status: experimental, DEV-only (`?demo=1&present=1&seg=1`). The FE/BE plumbing is validated end-to-end against a **mock** provider. **No real SAM 3 provider exists yet**, so nothing here says whether geometry-guided prompting beats text/box prompting.

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

## 4. Open: real SAM 3 provider
fal `fal-ai/sam-3/image` schema (from its OpenAPI): `point_prompts[]: {x:int, y:int, label:0|1, object_id}`, `box_prompts[]: {x_min,y_min,x_max,y_max,object_id}`, `prompt` text; output `masks: Image[]` (URLs), `scores`, `boxes` (normalized cxcywh). Unstated: input coordinate units (integers, presumably pixels). Needed before an adapter: an `FAL_KEY` to confirm units, and a PNG decoder in the BE to convert mask URLs to RLE. Alternative: self-hosted SAM 3 (no torch/GPU locally).
