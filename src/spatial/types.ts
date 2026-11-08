/**
 * Search contracts for Phase 1 local object search.
 *
 * These types describe matching over the per-world annotation registry
 * (Phase 0). The matcher (`ObjectMatcher.ts`) consumes a plain, structural
 * projection of registry data — never registry instances, DOM elements,
 * Gemini responses, Three.js or Spark objects — so search stays independent
 * of the viewer rendering system.
 */

export type SearchQuantifier = "all" | "one";

export interface SearchQuery {
  /** Label to match after normalization (case/whitespace/punctuation) and synonym folding. */
  readonly label?: string;
  /** Exact-attribute requirements, AND-combined. Keys and values are normalized strings. */
  readonly attributes?: Record<string, string>;
  /** `all` (default) returns every match; `one` reports ambiguity on 2+ matches. */
  readonly quantifier?: SearchQuantifier;
}

export interface SearchResult {
  /** Matching annotation IDs (the registry's `annotation-N` IDs), in inventory order. */
  readonly annotationIds: readonly string[];
  /** Total number of matching annotations, including every ambiguous candidate. */
  readonly matchCount: number;
  /** `matched`, `ambiguous` (quantifier `one` with 2+), or `no-match` (zero matches). */
  readonly status: "matched" | "ambiguous" | "no-match";
  /** Human-readable explanation, always present for no-match and ambiguous results. */
  readonly reason?: string;
}

export interface SearchOptions {
  /**
   * Replaces the built-in synonym dictionary for this query.
   * Spread `DEFAULT_SYNONYMS` (`synonyms.ts`) when extending it.
   */
  readonly synonyms?: Readonly<Record<string, string>>;
}

/**
 * Structural inventory entries accepted by the matcher. The Phase 0 registry's
 * `SpatialObjectSnapshot` ({ objectId, semanticLabel, attributes, worldObb })
 * satisfies this shape, so `registry.list()` can be passed without conversion,
 * while the matcher itself never touches geometry types (`obb.ts`, THREE).
 */
export interface SearchableObject {
  readonly objectId: string;
  readonly semanticLabel: string;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Geometry-qualification contract (the Phase 0 attribute `obb`): "cluster"
 * annotations carry a fitted world OBB registered as real geometry; "point"
 * annotations are pin-only fallbacks whose stored OBB is a zero-size point
 * that must never be read as object geometry. Phase 1 matching deliberately
 * does NOT use this distinction (labels and attributes only) — these helpers
 * are exported so future spatial search filters on the Phase 0 contract
 * instead of re-deriving it.
 */
export const GEOMETRY_ATTRIBUTE_KEY = "obb";

export type SpatialGeometryKind = "cluster" | "point";

export interface GeometryQualifiableObject {
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | null;
}

/** Returns the registered `attributes.obb` kind, or undefined when absent/mistyped. */
export function spatialGeometryKind(
  object: GeometryQualifiableObject | null | undefined,
): SpatialGeometryKind | undefined {
  const attributes = object?.attributes;
  if (!attributes || typeof attributes !== "object") return undefined;
  const value = attributes[GEOMETRY_ATTRIBUTE_KEY];
  return value === "cluster" || value === "point" ? value : undefined;
}

/** A "cluster" annotation is geometry-qualified; a "point" annotation is not. */
export function hasFittedGeometry(
  object: GeometryQualifiableObject | null | undefined,
): boolean {
  return spatialGeometryKind(object) === "cluster";
}
