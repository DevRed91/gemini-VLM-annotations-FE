# Snapshot-bound annotation (Milestone 1)

One click → one `SnapshotBinding` (`src/viewer/SnapshotBinding.ts`) = frozen `ViewSnapshot`
(id, world generation, camera world/inverse/projection matrices, splat `matrixWorld`, JPEG) + the
splat instance drawn in it. The same binding feeds: click hit → Gemini image
(`snapshot.image.dataUrl`) → `annotateFromDetection` → `runDetectionPipeline` →
`samplePointsFromBox` / `getAnnotationPosition` (box-centre fallback). No live-camera ray is cast
downstream of the click. `splatRay` (live camera) is retained only as a comparison reference.

## Math
Box `[ymin,xmin,ymax,xmax]` (fractions of the image, origin top-left, y down; backend rescales
Gemini's 0–1000 values). Cell centre `(u,v)` → `ndc = (2u-1, 1-2v)` →
`near = W · P⁻¹ · (ndc,-1,1)`, origin = camera position (perspective), `dir = normalize(near-origin)`,
with `W`, `P` the frozen camera world/projection matrices. Identical to `Raycaster.setFromCamera`.

## Spark raycast (read from `spark.module.js` `SplatMesh.raycast`)
Verified by source reading and the browser check (snapshot hits == legacy hits, max Δ 1.4e-14):
- Uses `raycaster.ray` and `raycaster.near/far` only; never the camera. Default near/far (0, ∞) match legacy.
- Transforms the ray by the **live** `this.matrixWorld⁻¹` → the binding rejects if it differs from the frozen splat matrix.

Spark state that stays **live** and cannot be frozen by the snapshot:
- `minRaycastOpacity` (instance property, default 0.2), `raycastable`.
- Splat data (`packedSplats`/`extSplats`/paged buffers) and, for LOD splats, `lodIndices` / `raycastIndices` (which depend on the camera at sort time). Non-LOD splats are static.
- Not verified: behaviour for LOD/paged splats whose index set changes between capture and sampling.
