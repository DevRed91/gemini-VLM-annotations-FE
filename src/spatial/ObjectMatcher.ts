/**
 * Local object search — deterministic semantic matching over a per-world
 * annotation inventory (`SpatialObjectRegistry.list()` output or any
 * `SearchableObject[]`).
 *
 * Search reads only annotation-time data already present in the inventory:
 * display label, structured category/description/attributes/synonyms, and
 * legacy flat attributes. It never calls Gemini or any annotation API.
 *
 * Design boundaries:
 * - Exact or whole-word-phrase matching after normalization: no fuzzy matching, embeddings,
 *   vector databases, or semantic search, and no Gemini/API calls.
 * - Read-only: the matcher never mutates the inventory, the registry, or any
 *   viewer state, and has no runtime imports (no Three.js, Spark, DOM).
 * - Geometry-blind: `worldObb` is never read and `attributes.obb` never
 *   filters results; cluster-fitted and pin-only annotations are equally
 *   searchable by label (see `types.ts` for the geometry-qualification seam).
 * - No deduplication: annotations of the same apparent physical object stay
 *   separate results, in inventory (registration) order.
 */

// Explicit `.ts` extensions: these modules must stay runnable under Node
// type stripping (unit tests, no bundler), unlike DOM-bound viewer code.
import type {
  SearchableObject,
  SearchOptions,
  SearchQuery,
  SearchResult,
  SearchQuantifier,
} from "./types.ts";
import { DEFAULT_SYNONYMS, foldSynonyms } from "./synonyms.ts";

/**
 * Deterministic label normalization shared by the query, registered labels,
 * attribute keys and attribute values:
 * 1. NFKC-fold exotic unicode (full-width forms, ligatures, ...).
 * 2. Lowercase.
 * 3. Fold apostrophe-like marks to a plain apostrophe (smart quotes).
 * 4. Replace every run of non letter/number/apostrophe characters
 *    (punctuation, symbols, hyphens, underscores) with a single space.
 * 5. Collapse whitespace runs and trim.
 * Non-string input normalizes to "" (treated as an absent label).
 */
export function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[^\p{L}\p{N}\s']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

interface ParsedQuery {
  readonly label: string | null;
  readonly attributes: ReadonlyArray<readonly [key: string, value: string]>;
  readonly quantifier: SearchQuantifier;
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function describeQuery(parsed: ParsedQuery): string {
  const parts: string[] = [];
  if (parsed.label !== null) {
    parts.push(`label ${JSON.stringify(truncate(parsed.label))}`);
  }
  if (parsed.attributes.length > 0) {
    const attributes = Object.fromEntries(parsed.attributes);
    parts.push(`attributes ${JSON.stringify(truncate(JSON.stringify(attributes)))}`);
  }
  return parts.join(" with ") || "the given query";
}

/** Validates the query and builds the normalized matching criteria up front. */
function parseQuery(query: SearchQuery): ParsedQuery {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new TypeError("SearchQuery must be an object");
  }
  const { label, attributes, quantifier } = query;

  if (quantifier !== undefined && quantifier !== "all" && quantifier !== "one") {
    throw new TypeError(
      `SearchQuery.quantifier must be "all" or "one", got ${JSON.stringify(quantifier)}`,
    );
  }
  if (label !== undefined && typeof label !== "string") {
    throw new TypeError("SearchQuery.label must be a string when present");
  }
  if (
    attributes !== undefined &&
    (typeof attributes !== "object" || attributes === null || Array.isArray(attributes))
  ) {
    throw new TypeError(
      "SearchQuery.attributes must be an object mapping non-empty strings to non-empty strings",
    );
  }

  // A label that normalizes to "" (empty, whitespace-, or punctuation-only)
  // is treated as an absent criterion, keeping empty-label queries valid
  // when attributes carry the criteria.
  const normalizedLabel = label === undefined ? "" : normalizeLabel(label);

  const criteria: Array<[key: string, value: string]> = [];
  const seenKeys = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(attributes ?? {})) {
    if (typeof rawValue !== "string") {
      throw new TypeError(`SearchQuery.attributes.${rawKey} must be a string`);
    }
    const key = normalizeLabel(rawKey);
    const value = normalizeLabel(rawValue);
    if (!key) {
      throw new TypeError(
        `SearchQuery.attributes key ${JSON.stringify(rawKey)} must normalize to a non-empty string`,
      );
    }
    if (!value) {
      throw new TypeError(
        `SearchQuery.attributes.${rawKey} must normalize to a non-empty string`,
      );
    }
    if (seenKeys.has(key)) {
      throw new TypeError(
        `SearchQuery.attributes contains conflicting entries for ${JSON.stringify(key)}`,
      );
    }
    seenKeys.add(key);
    criteria.push([key, value]);
  }

  if (normalizedLabel === "" && criteria.length === 0) {
    throw new TypeError(
      "SearchQuery must specify a label or at least one attribute; an empty query is never interpreted as a match-everything search",
    );
  }

  return {
    label: normalizedLabel === "" ? null : normalizedLabel,
    attributes: criteria,
    quantifier: quantifier ?? "all",
  };
}

function buildSynonymLookup(options?: SearchOptions): ReadonlyMap<string, string> {
  const dictionary = options?.synonyms ?? DEFAULT_SYNONYMS;
  if (!dictionary || typeof dictionary !== "object" || Array.isArray(dictionary)) {
    throw new TypeError("SearchOptions.synonyms must be an object mapping strings to strings");
  }
  const lookup = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(dictionary)) {
    const key = normalizeLabel(rawKey);
    const value = normalizeLabel(rawValue);
    if (!key || !value) {
      throw new TypeError(
        `SearchOptions.synonyms entry ${JSON.stringify(rawKey)} must map to a non-empty normalized label`,
      );
    }
    lookup.set(key, value);
  }
  return lookup;
}

/**
 * Attribute matching: the stored attribute must exist on the object AND its
 * normalized value must equal the normalized query value (AND semantics
 * across all query attributes; unrelated stored attributes are ignored).
 * Canonicalization is symmetric for strings, numbers and booleans through
 * `normalizeLabel(String(value))` ("3" matches 3, "true" matches true), so
 * string queries work against the registry's numeric/boolean values. A null
 * stored value or one that normalizes to "" never matches.
 */
/** Structured metadata attributes override legacy derived attributes on conflict. */
function effectiveAttributes(
  object: SearchableObject,
): Readonly<Record<string, unknown>> {
  const legacy = object.attributes && typeof object.attributes === "object"
    ? (object.attributes as Readonly<Record<string, unknown>>)
    : {};
  const metadataAttributes = object.metadata?.attributes;
  return metadataAttributes && typeof metadataAttributes === "object"
    ? { ...legacy, ...metadataAttributes }
    : legacy;
}

/**
 * Label-like fields matched as complete normalized phrases: display label,
 * metadata category, metadata description, and metadata synonyms. This never
 * performs substring/partial-word matching.
 */
function semanticLabelCandidates(object: SearchableObject): string[] {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return [object.semanticLabel];
  const candidates = [
    object.semanticLabel,
    metadata.category,
    metadata.description,
    ...(Array.isArray(metadata.synonyms) ? metadata.synonyms : []),
  ];
  return candidates.filter((value): value is string => typeof value === "string");
}

function attributeMatches(
  attributes: Readonly<Record<string, unknown>>,
  key: string,
  wanted: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(attributes, key)) return false;
  const stored = attributes[key];
  if (stored === null) return false;
  const normalizedStored = normalizeLabel(
    typeof stored === "string" ? stored : String(stored),
  );
  if (normalizedStored === "") return false;
  return normalizedStored === wanted;
}

/** Match a complete normalized phrase anywhere in a normalized label. */
function labelMatches(registered: string, wanted: string): boolean {
  return registered === wanted ||
    registered.startsWith(`${wanted} `) ||
    registered.endsWith(` ${wanted}`) ||
    registered.includes(` ${wanted} `);
}

/**
 * Runs one Phase 1 search over an annotation inventory.
 *
 * Behavior (all deterministic):
 * - Ordering: results preserve the inventory's own order (registry insertion
 *   order, i.e. annotation-creation order); no sorting, no deduplication.
 * - Quantifier `all`: matched for 1+ matches (all returned), no-match at 0.
 * - Quantifier `one`: matched for exactly 1, and for 2+ the status is
 *   `ambiguous` with every candidate returned — never a silent first pick.
 * - Labels match exactly or when the complete query phrase occurs within the
 *   registered label; partial-word matches are deliberately excluded.
 * - Invalid queries (wrong shape, no criteria, bad quantifier, bad
 *   attributes, bad synonyms option) throw `TypeError` instead of silently
 *   matching everything, mirroring `SpatialObjectRegistry`'s validation.
 * - Malformed inventory entries (missing label/attributes) never throw:
 *   a non-string label simply cannot match, missing attributes cannot
 *   satisfy attribute criteria, and entries without a usable non-empty
 *   string `objectId` are skipped because they cannot be reported.
 */
export function searchObjects(
  inventory: ReadonlyArray<SearchableObject>,
  query: SearchQuery,
  options?: SearchOptions,
): SearchResult {
  if (!Array.isArray(inventory)) {
    throw new TypeError("inventory must be an array of searchable objects");
  }
  const lookup = buildSynonymLookup(options);
  const parsed = parseQuery(query);

  const wantedLabel = parsed.label === null ? null : foldSynonyms(parsed.label, lookup);

  const matches: string[] = [];
  for (const object of inventory) {
    if (!object || typeof object !== "object") continue;
    if (typeof object.objectId !== "string" || object.objectId.trim() === "") continue;

    const attributes = effectiveAttributes(object);

    if (wantedLabel !== null) {
      // Every semantic field folds through the same dictionary as queries.
      const labelMatched = semanticLabelCandidates(object).some((candidate) =>
        labelMatches(foldSynonyms(normalizeLabel(candidate), lookup), wantedLabel),
      );
      if (!labelMatched) continue;
    }

    let qualifies = true;
    for (const [key, value] of parsed.attributes) {
      if (!attributeMatches(attributes, key, value)) {
        qualifies = false;
        break;
      }
    }
    if (qualifies) matches.push(object.objectId);
  }

  if (matches.length === 0) {
    return Object.freeze({
      annotationIds: Object.freeze([] as string[]),
      matchCount: 0,
      status: "no-match",
      reason: `no annotation matches ${describeQuery(parsed)}`,
    });
  }

  if (parsed.quantifier === "one" && matches.length > 1) {
    return Object.freeze({
      annotationIds: Object.freeze(matches.slice()),
      matchCount: matches.length,
      status: "ambiguous",
      reason: `${describeQuery(parsed)} matched ${matches.length} annotations but "one" was requested`,
    });
  }

  return Object.freeze({
    annotationIds: Object.freeze(
      parsed.quantifier === "one" ? [matches[0]] : matches,
    ),
    matchCount: matches.length,
    status: "matched",
  });
}
