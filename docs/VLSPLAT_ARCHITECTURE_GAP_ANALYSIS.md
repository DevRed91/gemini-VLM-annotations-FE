# VLSplat architecture gap analysis

Scope: map VLSplat §§3.1–3.3 to the current repository source. This is a status delta to the older [VLSPLAT_INVESTIGATION.md](VLSPLAT_INVESTIGATION.md), not a repeat of its method summary. “VERIFIED” refers to this checkout; “DOC” refers to the supplied VLSplat paper; “INFERRED” marks recommendations. No implementation or runtime tests were performed.

## Comparison matrix

| VLSplat section | Existing counterpart | Status and gap |
|---|---|---|
| §3.1 Codebook semantic lifting | The viewer sends an image snapshot and click coordinates to `/api/annotate`, consumes label/description/2D box results, samples the box with scene raycasts, then clusters the 3D points. [VERIFIED: `src/script.ts:47-51,794-830,656-677`] | **Partial.** This supplies a one-shot semantic proposal and geometric seed. VLSplat learns per-Gaussian features, groups them with an object codebook, and lifts multi-view mask supervision. Those learned features, codebook, and mask-training path are absent here. [DOC: VLSplat §3.1] |
| §3.2 Spatial support and scene graph | DBSCAN retains the largest point cluster; `fitOBB` fits its world-space support; `liftCluster` selects Gaussian storage indices by center-in-OBB and opacity. [VERIFIED: `src/GeometricContextManager/GeometricContextManager.ts:55-83`; `src/utils/obbFit.ts:217-301`; `src/utils/clusterLifter.ts:56-148`] | **Partial.** The geometry path can produce an object-sized region and a visual Gaussian selection. It does not build covariance-connected components, tight/expanded ROIs, or object-neighbor graph edges. VLSplat nodes also hold codebook identity, language evidence, and view evidence. [DOC: VLSplat §3.2] |
| §3.2 Node metadata | `SpatialObjectRegistry` stores stable string IDs, semantic labels, primitive attributes, and defensive copies of a world OBB. [VERIFIED: `src/utils/spatialObjectRegistry.ts:3-36,68-90,93-148`] | **Partial.** It is currently unreferenced by the viewer, has no edge/relation API, and intentionally has no Gaussian-index field. Viewer label/description and selection state are transient. There is no `ObjectMatcher` implementation in the current source. [VERIFIED: source search; `src/script.ts:59-69,84-94`] |
| §3.3 Intra/inter-node refinement | The highlighter maintains per-object selected indices and a mask for visual tinting. [VERIFIED: `src/utils/gaussianObjectHighlighter.ts:39-109,112-159`; `src/utils/gaussianMaskManager.ts:92-123,283-320`] | **Missing.** There are no learned Gaussian features/confidence, core-versus-candidate sets, object-view CLIP scoring, per-Gaussian opacity gates, or semantic feature updates. The mask is a display/selection mechanism, not VLSplat refinement. [DOC: VLSplat §3.3] |

## Answers

### 1–3. Implemented, partial, and missing

**Already implemented as reusable plumbing:** click-to-Gemini-endpoint integration; 2D-box-to-ray-hit sampling; adaptive-radius DBSCAN with largest-cluster selection; PCA/upright OBB fitting; OBB-to-Gaussian index lifting; multi-object color masks and viewer cleanup. The lift explicitly supports static non-LOD, non-paged splats only. [VERIFIED: `src/script.ts:794-830,692-732`; `src/GeometricContextManager/GeometricContextManager.ts:17-32,55-83`; `src/utils/gaussianIndexSupport.ts:3-30`; `README.md:189-203`]

**Partially implemented:** semantic identity exists as Gemini output and as a standalone registry data model, but the two are not connected. The viewer keeps annotation elements, fitted bounds, and numeric Gaussian-selection IDs in per-world memory and clears them on removal/reload; no frontend annotation/scene metadata serialization or durable storage call was found. The front end calls `/api/annotate`, but this checkout contains no endpoint/model implementation, so the Gemini backend contract is not verified here. [VERIFIED: `src/script.ts:32-50,84-94,403-457,806-830`; source search for storage APIs and backend symbols]

**Missing:** learned Gaussian semantics/codebook and multi-view mask lifting (§3.1); a scene graph with spatial relations and VLM-grounded node evidence (§3.2); and CLIP-guided intra/inter-node candidate refinement (§3.3). Current sampling returns `Vector3[]`, not `CandidatePoint` records with pixel/ray provenance; `liftCluster` then independently scans Gaussian centers inside the fitted OBB. No `CandidatePoint` type or `ObjectMatcher` exists in current `src/`. [VERIFIED: `src/script.ts:656-677`; `src/utils/clusterLifter.ts:56-60,102-148`; source symbol search]

### 4. Can `SpatialObjectRegistry` evolve into a `SpatialSceneGraph` safely?

Yes, as an additive layer. Keep registry IDs, snapshot/update semantics, and existing OBB ownership intact; compose it inside a graph that stores edges keyed by registry IDs. This preserves current callers and lets graph relations be added independently. Keep the string scene-node ID distinct from `GaussianObjectHighlighter`’s numeric 1–255 mask label, with an explicit association. The registry has no current viewer callers, so integration still needs lifecycle wiring. [VERIFIED: `src/utils/spatialObjectRegistry.ts:68-90,141-179`; `src/utils/gaussianObjectHighlighter.ts:11-25,161-170`; INFERRED: additive design]

### 5. Existing modules to reuse

- `src/script.ts` — request/annotation lifecycle, DOM card, world-generation guards, selection cleanup. [VERIFIED: `src/script.ts:403-457,794-837`]
- `src/GeometricContextManager/GeometricContextManager.ts` — point filtering, DBSCAN, measured cluster output. [VERIFIED: lines 34-83]
- `src/utils/obbFit.ts` and `src/utils/obb.ts` — fitted world-space bounds and OBB representation. [VERIFIED: `src/utils/obbFit.ts:32-36,217-301`; `src/utils/obb.ts:5-22,74-80`]
- `src/utils/spatialObjectRegistry.ts` — semantic node records and defensive metadata snapshots. [VERIFIED: lines 9-36,68-90,169-179]
- `src/utils/clusterLifter.ts`, `src/utils/gaussianObjectHighlighter.ts`, and `src/utils/gaussianMaskManager.ts` — Gaussian membership and per-object display selection. [VERIFIED: `src/utils/clusterLifter.ts:56-148`; `src/utils/gaussianObjectHighlighter.ts:72-109`; `src/utils/gaussianMaskManager.ts:283-320`]
- `src/utils/hoverTint.ts` — current OBB picking/fallback interaction. [VERIFIED: `src/script.ts:254-285,604-637`; `src/utils/hoverTint.ts:40-65`]

### 6. Smallest logical next phase

Wire a per-world `SpatialObjectRegistry` into the existing annotation lifecycle: after a successful fit/selection, register label, Gemini description, world OBB, and the associated numeric selection ID; remove the record with its annotation and clear the registry on world reload. Keep current rendering and mask behavior unchanged. This yields actual semantic-spatial nodes; add graph edges in a follow-on step. This first phase is in-memory only. No current storage contract was found to support a safe durable-persistence recommendation, so serialization should be scoped separately. [INFERRED]

## Existing-doc correction

`docs/VLSPLAT_INVESTIGATION.md` describes an earlier source snapshot (largest-cluster AABB and no mainline index lifting). Update its implementation-status portion to point to the now-present OBB fit, center/opacity index lift, multi-selection mask, and LOD/paging restriction documented in `README.md:189-203` and the source files above. Its sibling backend references were not inspected in this frontend checkout and should remain explicitly external/unverified.
