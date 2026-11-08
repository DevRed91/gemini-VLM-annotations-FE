# Chat object search — Phase 0: registry integration

**Status: implemented and validated (2026-11-08).** Every annotation created in
the viewer is now searchable through `SpatialObjectRegistry`. Results:
`docs/chat-object-search-phase-0-results.json`; run with
`npm run validate:registry`.

Plan of record: `docs/chat-object-search-investigation.md` §4 (proposed) became
this implementation.

## Work-item results

| # | Work item | Result |
|---|---|---|
| 0.1 | Inspect `ViewerAnnotation` / `SpatialObjectRegistry` | `src/script.ts:60`, `src/utils/spatialObjectRegistry.ts` — registry was compiled but unreferenced (design wired, never connected) |
| 0.2 | Annotation creation points | Single funnel: `createAnnotationElement()` (`src/script.ts:484`), called only by `annotateFromDetection()` (cluster-fit and pin-fallback variants) |
| 0.3 | Deletion and cleanup paths | `removeAnnotation()` (single), `clearAllSelections()`, and `clearAnnotationVisuals()` via `clearWorldResources()` (world switch) — one shared visual tear-down, `removeAnnotationVisual()` |
| 0.4 | Registry data contract | See below |
| 0.5 | Registry instance per world | Field `SplatViewer.spatialRegistry`; constructed at success of `loadWorld()` next to `splatLoaded`, dropped in `clearWorldResources()` after annotations unregister |
| 0.6 | Register after successful creation | `registerAnnotation()` call at the end of `createAnnotationElement()` — creation implies registration; contract violations log to console, never break annotation flow |
| 0.7 | Unregister by annotation ID | `removeAnnotationVisual()` calls `registry.remove(annotation.apartmentId)` — covers single delete, clear-all, and world switch |
| 0.8 | Reset with `loadWorld()` | Fresh registry per world; a fresh instance is used instead of `clear()` so the old world's ID space cannot leak |
| 0.9 | Async stale-world guard | Registration happens synchronously inside `createAnnotationElement()`, downstream of `annotateFromDetection()`'s `worldGeneration` checks (`src/script.ts` capture + re-check after each await); no stale world can register |
| 0.10 | `window.__sl` inspection | `__sl.registry` → `{ size, objects }` snapshot (or `null` between worlds); `__sl.spatialRegistry` → raw instance for console probing (DEV only) |
| 0.11 | Duplicate annotations | Same physical object annotated twice → two registry entries under distinct IDs; IDs are drawn from the monotonic `annotationSequence`, which never resets |
| 0.12 | Regression tests | New `scripts/registry-validate.mjs` (7/7 pass); Phase 3 viewer suite re-run: the only failures are pre-existing in the working tree and registry-independent — see below |

### Phase 3 regression run — findings, not caused by this change

`PHASE3_VIEWER_ONLY=1 PHASE3_REPETITIONS=2 npm run validate:phase3` (2026-11-08)
reports 5 failing viewer tests. All 5 assert `splat.objectModifiers.length`
counts that are exactly **one lower** than expected in every state
(2→1, 2→1, 2→1, 1→0), which matches the removed global
`new HoverTint(splat)` modifier from the uncommitted hover-interaction
removal in `src/script.ts` (also still referenced at
`scripts/phase3-validate.mjs:294,300`, where `viewer.hoverTint` no longer
exists). The last committed run (`2026-11-07`) passed 0-fail with the older
modifier counts. In every failing state the annotation axis is correct
(`annotationCount`, `helpers`, `selections`, and cleared-after-reload all
match), so the annotation flow — and with it Phase 0 — is intact. Updating
the Phase 3 expectations for the hover removal is pending work for whoever
owns that change.

## Data contract

```ts
registry.register({
  objectId,            // canonical `apartmentId`: `annotation-N`
  semanticLabel,       // annotation label (VLM class name)
  attributes: {
    description,       // VLM free text, when present
    obb: "cluster" | "point",
  },
  worldObb,            // fitted cluster OBB, or a zero-size point OBB at the pin
})
```

- **One canonical ID** — registry `objectId` ≡ annotation `apartmentId`. The
  Gaussian mask ID (1–255) never appears in the registry, matching the
  registry's "no numeric mask labels" design comment.
- **Point OBBs** — pin-only annotations (failed lift/fit) register a
  zero-size OBB at the pin position with `obb: "point"` so Phase 2 spatial
  predicates can exclude them. The Phase 0 plan's completion test needs the
  cluster-fitted path, which is covered by tests 1–6.
- **Fresh registry (not `clear()`)** — `SpatialObjectRegistry.clear()` keeps
  used IDs non-reusable by design; a fresh instance per world expresses
  "old inventory is gone" structurally. Cross-world ID collisions remain
  impossible because `annotationSequence` is monotonic for the viewer's
  lifetime (verified: reload keeps counting at `annotation-3`).
- **Bookkeeping left as-is** — the `viewer.apartments[]` write-only list is
  unchanged; folding it into the registry later stays optional per §4 of the
  investigation.

## Completion test (from the plan)

```
Load Apartment.sog            → registry created, empty          (test 1)
Annotate sofa                 → registry holds annotation-1      (test 2)
Annotate table (same surface) → registry holds annotation-1/-2   (test 3)
Delete sofa annotation        → registry holds annotation-2      (test 4)
Load another world            → registry fresh and empty         (test 6)
```

Tests run against the real viewer (`__sl.inject` seam, Apartment.sog then
Apartment-lod.rad), headless Chromium + SwiftShader, with hard gates on
console/page errors, shader errors, and GL errors.

## Validation

```bash
npm run validate:registry   # writes docs/chat-object-search-phase-0-results.json
```

Verified 2026-11-08: 7/7 pass; zero console/page errors; `finalGlError = 0`;
`npx tsc --noEmit` adds no diagnostics beyond the four pre-existing ones
(`gaussianIdProbe.ts`, `utils.ts`, `worldlabs.ts`); `npm run build` succeeds.

Out of scope, deferred to Phase 1: inventory projection to
`{ objectId, label, attributes }` for the `/api/chat/search` payload (the
registry holds the full snapshot; the projection is a wire concern), and the
chat UI/selection layer.
