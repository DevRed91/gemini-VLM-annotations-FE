/**
 * Small, isolated persistence layer for annotation semantic metadata and the
 * minimum annotation presentation data needed to restore it in the viewer.
 *
 * Storage is keyed by normalized scene URL, so one world can never expose
 * another world's records. No database, backend, or Gaussian indices are used;
 * only semantic metadata, pin/OBB pose, and dimensions are persisted.
 */

import {
  ANNOTATION_METADATA_SCHEMA_VERSION,
  copyAnnotationMetadata,
  type AnnotationMetadata,
} from "./AnnotationMetadata.ts";

export interface Vector3Json {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuaternionJson {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface OBBJson {
  readonly position: Vector3Json;
  readonly quaternion: QuaternionJson;
  readonly size: Vector3Json;
}

export interface AnnotationDimensionsJson {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

export interface SceneAnnotationRecord {
  readonly schemaVersion: 1;
  readonly annotationId: string;
  readonly label: string;
  readonly description?: string;
  readonly metadata?: AnnotationMetadata;
  readonly position: Vector3Json;
  readonly geometry: {
    readonly kind: "cluster" | "point";
    readonly obb?: OBBJson;
  };
  readonly dimensions?: AnnotationDimensionsJson;
}

interface PersistedSceneAnnotations {
  readonly schemaVersion: 1;
  readonly worldKey: string;
  readonly annotations: SceneAnnotationRecord[];
}

export interface SceneAnnotationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type OBBLike = {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
};

const STORE_PREFIX = "gemini-annotation-metadata:v1";

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function vector(value: unknown, name: string): Vector3Json {
  if (!value || typeof value !== "object") throw new TypeError(`${name} must be a vector`);
  const { x, y, z } = value as Record<string, unknown>;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z)) {
    throw new TypeError(`${name} must contain finite x, y, and z values`);
  }
  return Object.freeze({ x, y, z });
}

function quaternion(value: unknown, name: string): QuaternionJson {
  if (!value || typeof value !== "object") throw new TypeError(`${name} must be a quaternion`);
  const { x, y, z, w } = value as Record<string, unknown>;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z) || !finiteNumber(w)) {
    throw new TypeError(`${name} must contain finite x, y, z, and w values`);
  }
  const lengthSquared = x * x + y * y + z * z + w * w;
  if (Math.abs(lengthSquared - 1) > 1e-6) {
    throw new RangeError(`${name} must be unit length`);
  }
  return Object.freeze({ x, y, z, w });
}

function obb(value: unknown, name = "worldObb"): OBBJson {
  if (!value || typeof value !== "object") throw new TypeError(`${name} must be an OBB`);
  const raw = value as {
    position?: unknown;
    quaternion?: unknown;
    size?: unknown;
  };
  const size = vector(raw.size, `${name}.size`);
  if (size.x < 0 || size.y < 0 || size.z < 0) {
    throw new RangeError(`${name}.size components must be non-negative`);
  }
  return Object.freeze({
    position: vector(raw.position, `${name}.position`),
    quaternion: quaternion(raw.quaternion, `${name}.quaternion`),
    size,
  });
}

function dimensions(value: unknown): AnnotationDimensionsJson {
  if (!value || typeof value !== "object") throw new TypeError("dimensions must be an object");
  const raw = value as Record<string, unknown>;
  if (!finiteNumber(raw.width) || !finiteNumber(raw.height) || !finiteNumber(raw.depth)) {
    throw new TypeError("dimensions must contain finite width, height, and depth values");
  }
  return Object.freeze({
    width: raw.width,
    height: raw.height,
    depth: raw.depth,
  });
}

function normalizeRecord(input: unknown): SceneAnnotationRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("A scene annotation record is required");
  }
  const raw = input as Record<string, unknown>;
  const annotationId = typeof raw.annotationId === "string" ? raw.annotationId.trim() : "";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!annotationId) throw new TypeError("annotationId must be a non-empty string");
  if (!label) throw new TypeError("label must be a non-empty string");
  if (raw.schemaVersion !== ANNOTATION_METADATA_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion must be ${ANNOTATION_METADATA_SCHEMA_VERSION}`);
  }
  if (!raw.geometry || typeof raw.geometry !== "object") {
    throw new TypeError("geometry is required");
  }
  const geometryRaw = raw.geometry as { kind?: unknown; obb?: unknown };
  if (geometryRaw.kind !== "cluster" && geometryRaw.kind !== "point") {
    throw new TypeError('geometry.kind must be "cluster" or "point"');
  }
  const metadata = copyAnnotationMetadata(raw.metadata);
  const description = typeof raw.description === "string" && raw.description.trim()
    ? raw.description.trim()
    : undefined;

  return Object.freeze({
    schemaVersion: ANNOTATION_METADATA_SCHEMA_VERSION,
    annotationId,
    label,
    ...(description === undefined ? {} : { description }),
    ...(metadata === undefined ? {} : { metadata }),
    position: vector(raw.position, "position"),
    geometry: Object.freeze({
      kind: geometryRaw.kind,
      ...(geometryRaw.kind === "cluster" ? { obb: obb(geometryRaw.obb, "geometry.obb") } : {}),
    }),
    ...(raw.dimensions === undefined ? {} : { dimensions: dimensions(raw.dimensions) }),
  });
}

/** Builds a JSON-safe record from viewer annotation data. */
export function createSceneAnnotationRecord(input: {
  readonly annotationId: string;
  readonly label: string;
  readonly description?: string;
  readonly metadata?: AnnotationMetadata;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly worldObb?: OBBLike | null;
  readonly dimensions?: AnnotationDimensionsJson | null;
}): SceneAnnotationRecord {
  const kind = input.worldObb ? "cluster" : "point";
  return normalizeRecord({
    schemaVersion: ANNOTATION_METADATA_SCHEMA_VERSION,
    annotationId: input.annotationId,
    label: input.label,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    position: input.position,
    geometry: {
      kind,
      ...(kind === "cluster" ? { obb: input.worldObb } : {}),
    },
    ...(input.dimensions ? { dimensions: input.dimensions } : {}),
  });
}

/** Converts persisted JSON into a plain OBB-like object for viewer restoration. */
export function deserializeObbJson(value: OBBJson): OBBJson {
  return obb(value, "storedOBB");
}

export function normalizeWorldKey(worldUrl: string): string {
  if (typeof worldUrl !== "string" || !worldUrl.trim()) {
    throw new TypeError("worldUrl must be a non-empty string");
  }
  const url = new URL(worldUrl, "http://local.scene");
  url.hash = "";
  return url.toString();
}

export class SceneAnnotationMetadataStore {
  private readonly worldKey: string;
  private readonly storageKey: string;
  private readonly storage: SceneAnnotationStorage;

  constructor(
    worldKey: string,
    storage: SceneAnnotationStorage,
  ) {
    if (!worldKey || typeof worldKey !== "string") throw new TypeError("worldKey must be a non-empty string");
    if (!storage || typeof storage !== "object") throw new TypeError("scene annotation storage is required");
    this.worldKey = worldKey;
    this.storage = storage;
    this.storageKey = `${STORE_PREFIX}:${encodeURIComponent(worldKey)}`;
  }

  list(): SceneAnnotationRecord[] {
    return this.load().annotations.map((record) => normalizeRecord(record));
  }

  get(annotationId: string): SceneAnnotationRecord | undefined {
    return this.list().find((record) => record.annotationId === annotationId);
  }

  save(record: SceneAnnotationRecord): void {
    const normalized = normalizeRecord(record);
    const scene = this.load();
    const annotations = scene.annotations.filter(
      (item) => item.annotationId !== normalized.annotationId,
    );
    annotations.push(normalized);
    this.persist({ ...scene, annotations });
  }

  update(
    annotationId: string,
    patch: Partial<Pick<SceneAnnotationRecord, "label" | "description" | "metadata">>,
  ): SceneAnnotationRecord {
    const current = this.get(annotationId);
    if (!current) throw new RangeError(`Unknown annotation: ${annotationId}`);
    const next = normalizeRecord({ ...current, ...patch });
    this.save(next);
    return next;
  }

  remove(annotationId: string): boolean {
    const scene = this.load();
    const next = scene.annotations.filter((item) => item.annotationId !== annotationId);
    if (next.length === scene.annotations.length) return false;
    this.persist({ ...scene, annotations: next });
    return true;
  }

  clear(): void {
    this.storage.removeItem(this.storageKey);
  }

  maxAnnotationSequence(): number {
    let max = 0;
    for (const record of this.list()) {
      const match = /^annotation-(\d+)$/.exec(record.annotationId);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  private load(): PersistedSceneAnnotations {
    const raw = this.storage.getItem(this.storageKey);
    if (raw === null) {
      return Object.freeze({ schemaVersion: 1, worldKey: this.worldKey, annotations: [] });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Object.freeze({ schemaVersion: 1, worldKey: this.worldKey, annotations: [] });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Object.freeze({ schemaVersion: 1, worldKey: this.worldKey, annotations: [] });
    }
    const candidate = parsed as { schemaVersion?: unknown; worldKey?: unknown; annotations?: unknown };
    if (candidate.schemaVersion !== 1 || candidate.worldKey !== this.worldKey || !Array.isArray(candidate.annotations)) {
      return Object.freeze({ schemaVersion: 1, worldKey: this.worldKey, annotations: [] });
    }
    return Object.freeze({
      schemaVersion: 1,
      worldKey: this.worldKey,
      annotations: candidate.annotations.filter(
        (item) => {
          try {
            normalizeRecord(item);
            return true;
          } catch {
            return false;
          }
        },
      ),
    });
  }

  private persist(scene: PersistedSceneAnnotations): void {
    this.storage.setItem(this.storageKey, JSON.stringify(scene));
  }
}

export function createSceneAnnotationMetadataStore(
  worldUrl: string,
  storage: SceneAnnotationStorage = globalThis.localStorage,
): SceneAnnotationMetadataStore {
  return new SceneAnnotationMetadataStore(normalizeWorldKey(worldUrl), storage);
}
