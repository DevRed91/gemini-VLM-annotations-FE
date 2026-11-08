/**
 * Structured semantic metadata returned during annotation.
 *
 * The parser is deliberately strict about shape and values, but tolerant about
 * optional fields and unknown top-level fields. An invalid or unsupported
 * payload normalizes to `undefined`, letting the viewer keep its legacy
 * label/description fallback instead of blocking annotation creation.
 */

export const ANNOTATION_METADATA_SCHEMA_VERSION = 1;

export interface AnnotationMetadata {
  readonly schemaVersion: number;
  readonly category?: string;
  readonly description?: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly synonyms?: readonly string[];
  readonly provenance?: {
    readonly source: "gemini";
    readonly confidence?: number;
  };
}

export type AnnotationMetadataInput = unknown;

const MAX_TEXT_LENGTH = 2000;
const MAX_ATTRIBUTE_KEY_LENGTH = 100;
const MAX_ATTRIBUTE_COUNT = 100;
const MAX_SYNONYM_COUNT = 50;

const UNKNOWN_VALUES = new Set([
  "unknown",
  "unavailable",
  "uncertain",
  "unclear",
  "not visible",
  "not specified",
  "not identified",
  "n a",
  "na",
  "null",
  "none",
]);

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_TEXT_LENGTH) return undefined;
  if (UNKNOWN_VALUES.has(normalized.toLowerCase())) return undefined;
  return normalized;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeAttributes(value: unknown): AnnotationMetadata["attributes"] | undefined {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const attributes: Record<string, string | number | boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || key.length > MAX_ATTRIBUTE_KEY_LENGTH) continue;
    if (Object.keys(attributes).length >= MAX_ATTRIBUTE_COUNT) break;

    if (typeof rawValue === "boolean" || isFiniteNumber(rawValue)) {
      attributes[key] = rawValue;
      continue;
    }
    if (typeof rawValue !== "string") continue;
    const normalized = normalizeText(rawValue);
    if (normalized !== undefined) attributes[key] = normalized;
  }
  return Object.freeze(attributes);
}

function normalizeSynonyms(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;

  const synonyms = new Set<string>();
  for (const item of value) {
    const normalized = normalizeText(item);
    if (normalized !== undefined) synonyms.add(normalized);
    if (synonyms.size >= MAX_SYNONYM_COUNT) break;
  }
  return Object.freeze([...synonyms]);
}

function normalizeProvenance(value: unknown): AnnotationMetadata["provenance"] | undefined {
  if (value === undefined) return { source: "gemini" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const source = (value as { source?: unknown }).source;
  if (source !== undefined && source !== "gemini") return undefined;
  const confidence = (value as { confidence?: unknown }).confidence;
  if (confidence !== undefined && (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1)) {
    return undefined;
  }
  return Object.freeze({
    source: "gemini",
    ...(confidence === undefined ? {} : { confidence }),
  });
}

/**
 * Accepts a Gemini `metadata` object and returns an isolated, frozen copy.
 * Returns `undefined` for missing or malformed metadata; callers should retain
 * the legacy label/description behavior in that case.
 */
export function parseAnnotationMetadata(input: AnnotationMetadataInput): AnnotationMetadata | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const raw = input as {
    schemaVersion?: unknown;
    category?: unknown;
    description?: unknown;
    attributes?: unknown;
    synonyms?: unknown;
    provenance?: unknown;
  };

  // Older responses without a version are treated as v1. A future consumer can
  // add migration branches before rejecting a newer version.
  const rawVersion = raw.schemaVersion;
  const schemaVersion = rawVersion === undefined
    ? ANNOTATION_METADATA_SCHEMA_VERSION
    : rawVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    return undefined;
  }

  const category = normalizeText(raw.category);
  const description = normalizeText(raw.description);
  const attributes = normalizeAttributes(raw.attributes);
  const synonyms = normalizeSynonyms(raw.synonyms);
  const provenance = normalizeProvenance(raw.provenance);
  if (attributes === undefined || provenance === undefined) return undefined;
  if (
    category === undefined &&
    description === undefined &&
    Object.keys(attributes).length === 0 &&
    (synonyms === undefined || synonyms.length === 0)
  ) {
    return undefined;
  }

  return Object.freeze({
    schemaVersion,
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description }),
    attributes,
    ...(synonyms === undefined ? {} : { synonyms }),
    provenance,
  });
}

/** Defensive copy used by the runtime registry. Unknown input is rejected. */
export function copyAnnotationMetadata(metadata: unknown): AnnotationMetadata | undefined {
  return metadata === undefined ? undefined : parseAnnotationMetadata(metadata);
}
