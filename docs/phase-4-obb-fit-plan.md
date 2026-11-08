# Phase 4: OBB Fit Quality Plan

## Problem

The magenta OBB and Gaussian highlight on annotated objects (e.g. a round dining table) were skewed, tilted, too tall, and only partly covering the object.

Pipeline: `annotateFromDetection` → `samplePointsFromBox` (rays through Gemini's 2D box) → `filterDepthOutliers` → `registerAndMeasureObject` (DBSCAN) → `fitOBB` → `GaussianObjectHighlighter.select` (lift to Gaussian indices).

Scene facts: up axis is +Y. The scene loads `/Apartment.sog`, a non-LOD format, so Gaussian lifting is supported. The file format is not a cause of the misfit.

## Done (validated by `npm run validate:phase4`, 8/8)

| Step | Change | Where |
|------|--------|-------|
| B | Upright fit: yaw-only about +Y, 1° sweep minimising trimmed footprint area; no tilt | `fitOBB({mode:"upright"})` in `src/utils/obbFit.ts` |
| A | Outlier control: adaptive DBSCAN eps (3× median NN distance, clamped 0.05–0.3) and depth-outlier filter | `adaptiveEps`, `filterDepthOutliers` in `GeometricContextManager.ts` |
| F | Trimmed extents: horizontal `trim` 1%, height `trimY` 2% | `obbFit.ts` |
| 1 | Dominant horizontal layer: bin heights at 4 cm, fit only the densest layer, so legs and floor don't set the height | `dominantHorizontalLayer`, `dominantLayer` option |

Result on the real scene: the label is correct, and the box is now a thin slab on the tabletop.

## Still open

1. **Partial coverage.** The box and highlight cover only the near/left part of the table. The right third, past the vase, is missing.
2. **Footprint overshoot.** A yaw-aligned rectangle around a round object leaves corner slack.
3. **Label errors** (Gemini once called the table "Chair"). This is a detection issue, out of scope here.

### Suspected cause of partial coverage (unconfirmed)

The OBB can only be as wide as the ray samples. Either Gemini's 2D box is too narrow on the right (the vase and numbers occlude the surface), or the depth filter or DBSCAN drops sparse grazing-angle samples there.

**Step 0 (diagnosis):** log the raw 2D box, the point counts after sampling, after `filterDepthOutliers`, and after DBSCAN, plus the screen-space extent of the surviving points. This decides whether to fix sampling or go straight to Gaussian refit.

## Next steps

### Step 2 — Plan C: refit from Gaussians (recommended)

Grow the selection beyond the sampled points using the scene's own Gaussians. Non-LOD only.

1. Lift the initial OBB to Gaussian indices (existing `select`).
2. Expand the OBB footprint by a margin, lift again, and keep Gaussians within the dominant height layer that are contiguous (spatially connected) with the first selection.
3. Refit with `fitOBB(upright, dominantLayer)` on the Gaussian centres.
4. Repeat for a small bounded number of iterations (2–3) and stop when the box change is below a tolerance.
5. Guards: cap growth (e.g. max 2× the initial footprint), require opacity ≥ `minOpacity`, and fall back to the initial fit if growth leaks onto the floor or neighbouring objects.

Validation: synthetic test with a disc whose samples cover only half; the refit should recover most of the disc. Also check in the viewer on the table.

### Step 3 — Circle/ellipse footprint fit

For round objects, fit a circle or ellipse to the footprint and use its bounding square, which removes the corner overshoot. Choose it when the footprint's circularity is high, otherwise keep the rectangle.

### Later

- **D:** shape priors, such as a RANSAC plane for table tops.
- **E:** segmentation masks or multi-view sampling in place of a single-view 2D box.

## Verification checklist

- [ ] `npm run validate:phase4` passes
- [ ] `npm run validate:phase3` passes in a browser (the PCA default is unchanged)
- [ ] `npx tsc --noEmit` shows no new errors (4 pre-existing errors in `gaussianIdProbe.ts`, `utils.ts`, `worldlabs.ts` are out of scope)
- [ ] Table annotation re-run in the viewer: the box is a slab covering the full table top
