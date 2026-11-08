# Chat object search — Phase 1: local object search (matching)

**Status: implemented and validated (2026-11-08).** Annotations in the Phase 0
per-world registry can be found through deterministic local label/attribute
matching — no Gemini, no external API, no Gaussian highlighting changes, no
viewer state mutation. Unit tests: `npm test` →
`45 passing` (`node --test tests/`); viewer validation:
`npm run validate:search` → `7/7 pass`
(`docs/chat-object-search-phase-1-results.json`).

## Files

| File | Role |
|---|---|
| `src/spatial/types.ts` | `SearchQuery` / `SearchResult` / `SearchOptions` contracts; `SearchableObject` structural inventory entry; geometry-qualification seam (constants + accessors) |
| `src/spatial/ObjectMatcher.ts` | `searchObjects(inventory, query, options?)` — deterministic matching; `normalizeLabel` |
| `src/spatial/synonyms.ts` | `SynonymMap`, `DEFAULT_SYNONYMS` (`couch → sofa`), `foldSynonyms` |
| `tests/ObjectMatcher.test.ts` | 45 unit tests incl. a real-`SpatialObjectRegistry` integration suite |
| `scripts/spatial-search-validate.mjs` | Viewer e2e (7 tests) over `window.__sl.search` |
| `src/script.ts` | DEV-only seam: `window.__sl.search(query, options?)` → matcher over the live registry (`null` between worlds) |

## Matching behavior

Every search runs `searchObjects(inventory, query, options?)`, where the
inventory is any `SearchableObject[]` — in practice `registry.list()`, which
satisfies the structural contract without conversion. Matching is read-only
and order-preserving: results are returned in inventory order (registry
insertion order, i.e. annotation-creation order), never sorted or deduplicated
(annotations of the same apparent physical object remain separate results).

### Normalization (`normalizeLabel`)

Applied identically to query labels, registered labels, attribute keys, and
attribute values (attribute values only; synonyms never fold attributes):
NFKC-unicode fold → lowercase → smart-apostrophe fold → punctuation runs
(anything but letters/numbers/apostrophe) become single spaces → whitespace
collapse → trim. `"SOFA"`, `" sofa "`, `"Dining  Table"`, `"Sofa!"`,
`"Dining-Table"` all match their canonical forms. A label that normalizes to
`""` (empty/whitespace/punctuation-only) is treated as an absent criterion.
Non-string input normalizes to `""` and cannot match.

### Synonyms (`synonyms.ts`)

A small directional dictionary, separate from the algorithm. Entries map a
variant to its canonical label (`couch: "sofa"`); **both** query labels and
registered labels fold through it, so `couch` finds `Sofa` and `sofa` also
finds records explicitly labeled `Couch`. Only explicitly listed variants
ever fold (documented choice; the alternative — query-side-only expansion,
which would keep `sofa` queries from returning `Couch`-labeled records — was
considered and rejected as less useful for VLM-generated inventory). Chains
are supported (`loveseat → couch → sofa`); a cyclic chain is treated as
malformed and left unfolded (fail-safe). `SearchOptions.synonyms` replaces
the built-in dictionary for the query (spread `DEFAULT_SYNONYMS` to extend);
malformed dictionaries throw.

### Attributes

`{ attributes: { material: "wood" } }` requires the registered object to
carry the key with an equal normalized value — **AND** semantics across all
entries; missing keys fail the criterion (never a silent match). Query values
are strings; registered numbers/booleans canonicalize through their string
form (`"3"` matches `3`, `"true"` matches `true`), and `null` values never
match. The `obb` attribute is an ordinary attribute: `{ attributes: { obb:
"point" } }` finds pin-only annotations, but matching never filters by it
implicitly.

### Quantifiers and statuses

| Quantifier | Matches | Result |
|---|---:|---|
| `all` (default) | 0 | `no-match`, empty `annotationIds`, `matchCount 0`, `reason` |
| `all` | 1+ | `matched`, all IDs in inventory order |
| `one` | 0 | `no-match` |
| `one` | 1 | `matched`, single ID |
| `one` | 2+ | `ambiguous`, **all** candidate IDs returned, `reason` names the count — never a silent first pick |

`matchCount` is always the total number of matches (not truncated by the
quantifier).

### Invalid input

Structurally invalid queries **throw `TypeError`** (mirroring
`SpatialObjectRegistry`'s validation): non-object queries, missing/empty/`""`
label with no or empty attributes (an empty query is **never** interpreted as
a match-everything search), unsupported `quantifier` values (no silent
default for typos), non-string labels, non-record or array `attributes`,
non-string/empty-normalized attribute keys or values, and duplicate
attribute keys that normalize to the same name. An empty label **with valid
attributes is valid** (attribute-only search). Inventory-level robustness:
malformed entries (non-string labels, missing attributes, unusable IDs) are
skipped or treated as no-criteria, never thrown.

### Geometry qualification (seam only)

Matching is geometry-blind in Phase 1: `worldObb` is never read, and both
cluster-fitted (`obb: "cluster"`) and pin-only (`obb: "point"`) annotations
are searchable by label, preserving the Phase 0 distinction. `types.ts`
exports `spatialGeometryKind()` / `hasFittedGeometry()` so future spatial
search can filter on the existing Phase 0 tags instead of re-deriving them;
point OBBs are still never interpreted as geometry.

## Dev seam

```js
// DEV build only, alongside __sl.registry / __sl.spatialRegistry:
window.__sl.search({ label: " sofa " });
// → { annotationIds: ["annotation-1"], matchCount: 1, status: "matched" }
window.__sl.search({ label: "table", quantifier: "one" });
// → ambiguous result with every candidate when 2+ tables exist
window.__sl.search({});          // throws TypeError (zero-criteria query)
```

## Validation

```bash
npm test               # 45 unit tests (matcher + real-registry integration)
npm run validate:search  # 7/7 viewer tests; writes docs/chat-object-search-phase-1-results.json
```

Verified 2026-11-08: unit suite 45/45 pass; viewer validation 7/7 pass with
zero console/page errors; `npx tsc --noEmit` adds no diagnostics beyond the
four pre-existing ones; `npm run build` succeeds.

## Known limitations

- Exact matching only: no fuzzy matching, stemming, embeddings, vector
  databases, or semantic search (per spec — Phase 1 must prove deterministic
  local matching first).
- Synonym folding is symmetric for the explicit pair (searching `sofa`
  returns `Couch`-labeled records too); extend `SearchOptions.synonyms` per
  query if stricter behavior is needed.
- Attribute values are not synonym-folded by design.
- No conversational context, no spatial relationships, no chat UI — those
  are later phases; geometry qualification intentionally stops at the
  accessor seam.

## Recommended next task

Phase 2 groundwork: give the matcher a spatial predicate layer over
`registry.list()` snapshots using `hasFittedGeometry()` as the qualification
gate — e.g. search + "nearest to annotation-N" disambiguation — consuming the
`ambiguous` result this phase already produces, before any chat/UI integration.
