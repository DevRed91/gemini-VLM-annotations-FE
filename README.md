# Gaussian Splat Object Selection & Highlighting

A research and engineering project exploring object-level selection, Gaussian index lifting and GPU-based highlighting in 3D Gaussian Splatting scenes using **SparkJS, Three.js and WebGL shaders**.

The objective is to develop a reliable foundation for selecting, associating and visualising individual objects within Gaussian Splat scenes, eventually enabling AI-driven spatial search and scene understanding.

## Project Overview

Traditional 3D object selection operates on explicit geometry such as meshes, vertices and bounding volumes. Gaussian Splatting represents scenes differently: objects and environments are reconstructed using collections of anisotropic 3D Gaussians.

This creates a different selection problem:

**Given a spatial region representing an object, how can we identify the Gaussian primitives associated with that region and highlight them efficiently without modifying the underlying scene representation?**

This project investigates that problem through a phased implementation:

1. Validate Gaussian identity and GPU mask rendering.
2. Establish a geometric selection baseline using oriented bounding boxes.
3. Convert geometric selections into Gaussian storage indices.
4. Render selections using GPU-based masks.
5. Extend the architecture to support multiple independently selected objects.

The longer-term direction is to connect Gaussian-level selection with semantic object understanding and spatial intelligence.

## Technology Stack

| Technology | Purpose |
|---|---|
| TypeScript | Core application and spatial processing |
| Three.js | 3D scene and rendering infrastructure |
| SparkJS 2.0.0 | Gaussian Splat loading and rendering |
| WebGL / GLSL | GPU-based Gaussian highlighting |
| R8UI textures | Integer-based Gaussian selection masks |
| Vite | Development server and build tooling |
| Playwright | Browser-based validation |
| Node.js | Development and validation scripts |

## Architecture

The current experimental selection pipeline is:

```text
3D Scene / Gaussian Splat
          |
          v
 Object Detection / Annotation
          |
          v
   3D Object Region
          |
          v
   OBB Representation
          |
          v
   Gaussian Index Lifting
          |
          v
   Gaussian Storage Indices
          |
          v
   GPU Selection Mask
          |
          v
   GLSL Shader Modifier
          |
          v
  Gaussian Highlighting
```

The selection and rendering responsibilities are deliberately separated.

- Geometric processing determines which Gaussian indices satisfy a selection region.
- The mask manager maintains the GPU representation of selected indices.
- The shader modifier uses the mask to visualise selected Gaussians.

The current implementation uses Gaussian centres and source opacity for geometric membership. It does not establish semantic ownership of individual Gaussians.

## Implementation Progress

### Phase 0 — Gaussian Identity and GPU Mask Probe

**Status: Implemented and validated for the tested non-LOD configuration.**

Objective: Investigate whether Gaussian storage indices can be used to identify and selectively highlight individual Gaussian primitives through a GPU mask.

Implemented:

- Gaussian identity investigation using SparkJS.
- R8UI mask texture.
- Gaussian index-to-texture coordinate mapping.
- Shader-based selection highlighting.
- Integration with the existing modifier chain.
- Debug-region selection for comparing CPU Gaussian indices with shader indices.
- Mask replacement and clearing.

Validation:

- Tested with `Apartment.sog`.
- Approximately 699,086 Gaussian splats.
- CPU-selected indices and shader debug-region selection produced identical output in the tested comparison.
- Mask replacement and clearing were validated.
- Modifier composition with hover highlighting was investigated.

The validation used headless Chromium and software rendering. Hardware GPU, LOD and mobile behaviour were not established.

### Phase 1 — OBB Geometric Selection Baseline

**Status: Implemented and validated as a geometric baseline.**

Objective: Establish a geometric selection mechanism that identifies Gaussian centres within an oriented bounding box fitted around an extracted object.

Implemented:

- PCA-based OBB fitting.
- 3×3 Jacobi eigensolver.
- Eigenvalue sorting and orientation correction.
- Right-handed OBB coordinate frame.
- AABB fallback for degenerate point distributions.
- World-space and splat-local coordinate handling.
- OBB-based Gaussian highlighting.
- Persistent cluster highlighting alongside transient hover highlighting.
- Development-only detection injection for deterministic testing.

Validation included:

- Basic OBB selection.
- Translation and rotation checks.
- World-to-local coordinate consistency.
- Highlight and wireframe alignment checks.
- Multiple detection replacement behaviour.

Limitations:

- OBB membership is not semantic segmentation.
- Background Gaussians can be included within the bounding volume.
- Uniform scale is assumed by the coordinate conversion implementation.
- LOD and broad hardware GPU validation were not established.

### Phase 2 — Gaussian Index Lifting

**Status: Implemented and browser-validated.**

Objective: Convert an existing world-space OBB into a deterministic collection of Gaussian storage indices and render those indices using an independent GPU mask manager.

Implemented components:

**`clusterLifter.ts`**

- Converts a world-space OBB into Gaussian storage indices.
- Supports configurable geometric margin and minimum opacity.
- Uses Gaussian centres for membership testing.
- Returns sorted, deduplicated indices.
- Reports diagnostics including scanned, candidate, accepted, rejected and invalid counts.
- Validates input geometry and transformations.
- Explicitly rejects unsupported LOD and paged sources.

**`gaussianMaskManager.ts`**

- Owns an R8UI selection texture.
- Maps Gaussian storage indices to texture coordinates.
- Applies highlighting through a shader modifier.
- Supports mask replacement and clearing.
- Tracks changed bytes and avoids unnecessary updates.
- Handles invalid and duplicate indices.
- Supports idempotent disposal.

**Validation results**

The final recorded Phase 2 validation reported:

- 21 assertion-bearing checks passed.
- Zero failed checks.
- CPU and shader selection agreement.
- Correct mask replacement and clearing.
- Transform invariance checks.
- Modifier composition checks.
- Resource disposal checks.
- Explicit LOD and paged-source rejection.

A reference performance run on `Apartment.sog` with 699,086 splats reported:

| Operation | Recorded time |
|---|---:|
| Full Gaussian lifting | 58.2 ms |
| Gaussian source scan | 43.7 ms |
| Mask rewrite | 38.1 ms |
| First visible highlight | Frame 2 |

### Phase 3 — Multi-Object Index-Mask Integration

**Status: Implemented; browser validation is in progress.**

The integrated viewer defaults to the static, non-LOD `/Apartment.sog` source. Annotation pins, object labels, and projected OBB wireframes remain visible by default, without persistent Gaussian tinting. Set `VITE_ENABLE_GAUSSIAN_HIGHLIGHTING=true` to opt into the experimental `GaussianObjectHighlighter` and OBB tint fallback; Gaussian index lifting remains available for development and validation.

When highlighting is enabled, a fitted world-space OBB is passed directly to `liftCluster()`; world-to-local conversion is used only for the wireframe helper and the unsupported-source OBB tint fallback.

- One 4096-wide R8UI mask stores labels `1..255`; zero is unselected.
- One 256-entry palette texture gives each object a stable, distinct color.
- The most recently added or updated selection wins overlaps. Clearing it restores the most recent underlying membership.
- `GaussianObjectHighlighter` serializes add/update, clear-one, clear-all, and disposal per world. IDs are not reused within a world.
- Persistent masking is installed before transient hover tint. Each modifier and texture has an explicit disposal owner.
- Reload clears annotation DOM, helpers, selections, hover state, textures, modifiers, and the old splat. Generation guards ignore stale loads and annotation responses.
- LOD/paged sources are not index-lifted. Detected regions use the OBB tint fallback instead.

This remains centre/OBB membership, not semantic segmentation; background Gaussians inside a fitted box may be included.

### Object-search track — Phase 3 viewer selection

The Spatial Search panel can now drive annotation emphasis in the real viewer. Each result exposes **Select in scene**, result groups expose **Select all in scene** and **Clear selection**, and the viewer exposes `setChatSelection()`, `clearChatSelection()`, and `getChatSelection()` using canonical `annotation-N` IDs. Emphasis reuses annotation pins, labels, cards, and OBB wireframes; it does not refit geometry, traverse Gaussians, or enable Gaussian highlighting. New searches and world reloads explicitly clear the previous selection. Details: `docs/chat-object-search-phase-3-viewer-selection.md`, results: `docs/chat-object-search-phase-3-viewer-selection-results.json`.

### Object-search track — Phase 0 registry integration

Phase 0 of the chat object-search plan (`docs/chat-object-search-investigation.md`) is implemented: every viewer annotation registers into a per-world `SpatialObjectRegistry` as a spatial object keyed by its canonical `annotation-N` ID, removals unregister, and a world reload installs a fresh registry. Labels, VLM descriptions, and world OBBs are queryable in-memory; pin-only fallbacks register a zero-size point OBB tagged `obb: "point"`. Details: `docs/chat-object-search-phase-0-registry.md`, results: `docs/chat-object-search-phase-0-results.json`.

## Browser validation

Install dependencies and the one-time Chromium runtime:

```bash
npm install
npx playwright install chromium
```

Run the regression and integration suites:

```bash
npm run validate:phase2
npm run validate:phase3
npm run validate:registry
npm run validate:search
npm run validate:chat
npm run validate:viewer-selection
```

The Gaussian multi-object Phase 3 validator defaults to 20 real-scene selection samples and writes `docs/phase3-results.json`. For a shorter development check, `PHASE3_REPETITIONS=2 npm run validate:phase3` reduces only the timing sample count; it is not the acceptance run.

These validators start their own Vite server. Existing-server overrides include `PHASE2_URL`, `PHASE3_URL`, `REGISTRY_URL`, `SEARCH_URL`, `CHAT_URL`, and `VIEWER_SELECTION_URL`; `CHROME_EXE` selects a Chromium executable, and `PLAYWRIGHT_MODULE` supports an external Playwright installation. The DEV-only `window.__sl.inject(label, box)` hook injects deterministic detections without contacting Gemini.

For a manual smoke test, run `npm run dev`, create two annotations, check hover over each, close one annotation, reload the world, and repeat with `/Apartment-lod.rad` to exercise the OBB fallback.

## Build and type checks

```bash
npm run build
npx tsc --noEmit --incremental false
```

The no-emit TypeScript check currently passes with zero diagnostics.
