import { cloneObb, OBB } from "./obb.ts";
import { copyAnnotationMetadata, type AnnotationMetadata } from "../spatial/AnnotationMetadata.ts";

export type SpatialObjectId = string;
export type SpatialObjectAttributeValue = string | number | boolean | null;
export type SpatialObjectAttributes = Readonly<
  Record<string, SpatialObjectAttributeValue>
>;

export interface SpatialObjectInput {
  /** Optional application ID. The registry generates a non-reused ID otherwise. */
  readonly objectId?: SpatialObjectId;
  readonly semanticLabel: string;
  readonly attributes?: SpatialObjectAttributes;
  /** Structured semantic metadata; optional for legacy/fallback annotations. */
  readonly metadata?: AnnotationMetadata;
  /** World-space bounds; stored as a defensive clone. */
  readonly worldObb: OBB;
}

export interface SpatialObjectPatch {
  readonly semanticLabel?: string;
  /** Replaces the complete attribute map rather than shallow-merging it. */
  readonly attributes?: SpatialObjectAttributes;
  readonly metadata?: AnnotationMetadata;
  readonly worldObb?: OBB;
}

export interface SpatialObjectSnapshot {
  readonly objectId: SpatialObjectId;
  readonly semanticLabel: string;
  readonly metadata?: AnnotationMetadata;
  readonly attributes: SpatialObjectAttributes;
  /** A defensive clone; mutating it does not mutate the registry. */
  readonly worldObb: OBB;
}

interface StoredSpatialObject {
  readonly semanticLabel: string;
  readonly metadata?: AnnotationMetadata;
  readonly attributes: SpatialObjectAttributes;
  readonly worldObb: OBB;
}

function copyLabel(label: string): string {
  if (typeof label !== "string" || !label.trim()) {
    throw new TypeError("semanticLabel must be a non-empty string");
  }
  return label.trim();
}

function copyAttributes(
  attributes: SpatialObjectAttributes | undefined,
): SpatialObjectAttributes {
  if (attributes === undefined) return Object.freeze({});
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new TypeError("attributes must be a record of primitive values");
  }
  const copy: Record<string, SpatialObjectAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(`attributes.${key} must be a string, number, boolean, or null`);
    }
    copy[key] = value;
  }
  return Object.freeze(copy);
}

/**
 * Lightweight, provider-independent semantic object storage. Numeric mask
 * labels and Gaussian storage indices deliberately have no representation here.
 */
export class SpatialObjectRegistry {
  private readonly records = new Map<SpatialObjectId, StoredSpatialObject>();
  private readonly usedIds = new Set<SpatialObjectId>();
  private nextGeneratedId = 1;

  get size(): number {
    return this.records.size;
  }

  register(input: SpatialObjectInput): SpatialObjectSnapshot {
    if (!input) throw new TypeError("A spatial object registration is required");
    const objectId = this.allocateId(input.objectId);
    const semanticLabel = copyLabel(input.semanticLabel);
    const attributes = copyAttributes(input.attributes);
    const metadata = copyAnnotationMetadata(input.metadata);
    const worldObb = cloneObb(input.worldObb, "worldObb");

    this.usedIds.add(objectId);
    this.records.set(objectId, { semanticLabel, metadata, attributes, worldObb });
    return this.snapshot(objectId, this.records.get(objectId)!);
  }

  update(
    objectId: SpatialObjectId,
    patch: SpatialObjectPatch,
  ): SpatialObjectSnapshot {
    const current = this.records.get(objectId);
    if (!current) throw new RangeError(`Unknown spatial object: ${objectId}`);
    if (
      !patch ||
      (patch.semanticLabel === undefined &&
        patch.metadata === undefined &&
        patch.attributes === undefined &&
        patch.worldObb === undefined)
    ) {
      throw new TypeError("A spatial object patch must contain at least one field");
    }

    const next: StoredSpatialObject = {
      semanticLabel:
        patch.semanticLabel === undefined
          ? current.semanticLabel
          : copyLabel(patch.semanticLabel),
      metadata: patch.metadata === undefined
        ? current.metadata
        : copyAnnotationMetadata(patch.metadata),
      attributes:
        patch.attributes === undefined
          ? current.attributes
          : copyAttributes(patch.attributes),
      worldObb:
        patch.worldObb === undefined
          ? current.worldObb
          : cloneObb(patch.worldObb, "worldObb"),
    };
    this.records.set(objectId, next);
    return this.snapshot(objectId, next);
  }

  get(objectId: SpatialObjectId): SpatialObjectSnapshot | undefined {
    const record = this.records.get(objectId);
    return record ? this.snapshot(objectId, record) : undefined;
  }

  has(objectId: SpatialObjectId): boolean {
    return this.records.has(objectId);
  }

  list(): SpatialObjectSnapshot[] {
    return [...this.records].map(([objectId, record]) =>
      this.snapshot(objectId, record),
    );
  }

  remove(objectId: SpatialObjectId): boolean {
    return this.records.delete(objectId);
  }

  /** Clear current records without making old object IDs reusable. */
  clear(): void {
    this.records.clear();
  }

  private allocateId(requested: SpatialObjectId | undefined): SpatialObjectId {
    if (requested !== undefined) {
      if (typeof requested !== "string" || !requested.trim()) {
        throw new TypeError("objectId must be a non-empty string");
      }
      const objectId = requested.trim();
      if (this.usedIds.has(objectId)) {
        throw new RangeError(`Spatial object ID has already been used: ${objectId}`);
      }
      return objectId;
    }

    let objectId: string;
    do {
      objectId = `spatial-object-${this.nextGeneratedId++}`;
    } while (this.usedIds.has(objectId));
    return objectId;
  }

  private snapshot(
    objectId: SpatialObjectId,
    record: StoredSpatialObject,
  ): SpatialObjectSnapshot {
    return Object.freeze({
      objectId,
      semanticLabel: record.semanticLabel,
      metadata: record.metadata,
      attributes: record.attributes,
      worldObb: cloneObb(record.worldObb),
    });
  }
}
