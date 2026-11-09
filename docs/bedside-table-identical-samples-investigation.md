# Bedside Table: 100 identical 3D samples — investigation

Static source trace. No files or DBSCAN parameters were changed. The live Bedside Table run was not available, so the root cause below is a deduction with a one-step confirmation.

## Observed

Bedside Table, box `[0.571, 0.100, 0.771, 0.300]`, 10×10 grid: 100 hits, 0 misses, one DBSCAN cluster of 100 points, extent 0.00 × 0.00 × 0.00, OBB = AABB fallback with artificial size 0.04³, anchor `(1.45, -0.97, 1.39)`. Bedding in the same scene gives a normal result (two clusters, 0.67 × 0.14 × 1.21 m).

## Trace: where do distinct samples become identical?

| Stage | Source | Can it collapse samples? |
|---|---|---|
| 1. Grid → NDC | `src/script.ts:993-994`, `:671-672` | No. `x`/`y` differ per cell. Grid size 10 matches `computeSampleGridSize` (area 0.04 → 6 + 19·0.2 ≈ 10). |
| 2. Ray origin/direction | `splatRay`, `src/script.ts:674-675` | No. A fresh `Raycaster` and `Vector2` per cell; probe clones origin/direction (`:1002-1003`). |
| 3–4. Spark raycast / distance | `node_modules/@sparkjsdev/spark/dist/spark.module.js:12827-12833` | No shared object. `point = ray.direction.clone().multiplyScalar(d).add(ray.origin)` is a new `Vector3` per hit. |
| 5. Stored position | `src/script.ts:1007-1008` | No. Pushes the fresh clone; no rounding. |
| 6. DBSCAN input | `GeometricContextManager.ts` (`rawPoints.map(p => [p.x,p.y,p.z])`) | No. Clustering, `.clone()` and `Box3` do not alter coordinates. |

Ruled out: reused mutable `Vector3`, wrong Spark result extraction, cached hit positions, rounding or transform collapse.

## Likely root cause

Each point is `origin + d·dir_i`. The 100 directions are distinct (the box spans 0.2 of the screen per axis). Identical points `P` therefore require `P = origin` and `d ≈ 0` for every ray. Parallel directions would also give identical points, but they are impossible here.

So the anchor `(1.45, -0.97, 1.39)` should equal the camera position at sampling time, with every `distance ≈ 0`. That means every ray hit a Gaussian at the camera, for example a large or low-opacity splat or floater enclosing or abutting the camera. Spark's `raycast_packed_buffer` is compiled WASM, so why it returns 0 could not be read. Its inputs are `near`, `far` and `minRaycastOpacity` (default 0.2).

## How to confirm

`SampleCellRecord` already stores `distance`, `position`, `rayOrigin` and `rayDirection` (`src/diagnostics/records.ts:98-110`). In the Bedside Table request, check:

- `cells[*].distance ≈ 0`
- `cells[*].position == cells[*].rayOrigin`
- how the click-hit position compares with this point

If the click hit is a real surface point at distance > 0, the camera likely moved between the click and the async Gemini response. The box is defined in the snapshot's image space, but `samplePointsFromBox` casts through the live camera (`src/script.ts:995`).

## Zero-sized geometry is never rejected

- `registerAndMeasureObject` only requires at least `minPts` points and at least one cluster. Identical points form a dense cluster, so zero extent passes.
- `fitOBB` returns `aabbFallback` when `e0 ≤ 1e-10` (`src/utils/obbFit.ts:105-106`), adding `margin·2 = 0.04` per axis (`:62-65`). The "artificial 0.04" is this margin, not a measurement.
- `validateObb` rejects only negative or non-finite sizes (`src/utils/obb.ts:62`).
- `runDetectionPipeline` (`src/script.ts:1070-1139`) anchors at `measured.centroid` and reports success. Nothing flags degenerate geometry.

## Minimal corrective recommendation

1. **Reject degenerate hits at the source.** In `samplePointsFromBox`, drop hits with `intersection.distance < ε`, or whose `point` is within ε of `ray.origin`. This is the real fix if the camera-inside-splat theory holds.
2. **Add a post-clustering degeneracy guard.** If the selected cluster's AABB is below about 1 cm on all axes, or `fitOBB` falls back to AABB on a zero-extent cluster, treat it as a failed lift and fall through to the click-hit fallback (`src/script.ts:1144`). Surface it in the diagnostics as a failure.
3. **Optional, if camera drift is confirmed.** Cast sampling rays through the click-time camera snapshot (already frozen by Task 2.1C) instead of the live camera.
