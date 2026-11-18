import type { SplatMesh } from "@sparkjsdev/spark";
import { liftCluster } from "./clusterLifter";
import type { ClusterLiftDiagnostics, ClusterLiftOptions } from "./clusterLifter";
import { nonLodSplatRejectionReason } from "./gaussianIndexSupport";
import { GaussianMaskManager } from "./gaussianMaskManager";
import type {
  GaussianMaskSnapshot,
  GaussianMaskUpdate,
} from "./gaussianMaskManager";
import { cloneObb, OBB } from "./obb";

export type GaussianObjectId = number;

export interface GaussianObjectSelectOptions extends ClusterLiftOptions {
  /** Update this existing object instead of allocating a new stable ID. */
  objectId?: GaussianObjectId;
}

export interface GaussianObjectSelectionSnapshot {
  objectId: GaussianObjectId;
  /** The mask label; equal to objectId in this implementation. */
  label: number;
  color: [number, number, number];
  worldObb: OBB;
  selectedIds: Uint32Array;
  lift: ClusterLiftDiagnostics;
}

export interface GaussianObjectSelectionResult extends GaussianObjectSelectionSnapshot {
  mask: GaussianMaskUpdate;
}

export interface DirectIndexSelectionOptions {
  /**
   * World-space OBB to hand back when index lifting is unsupported (LOD / paged
   * splat). The caller draws the wireframe/tint; no mask label is written.
   */
  fallbackObb?: OBB;
}

export interface DirectIndexSelectionResult {
  /** Caller-supplied identity (e.g. a verified product ID). */
  objectId: string;
  /** Stable mask label in [1, 255]; 0 when mode is "obb-fallback" (no label was allocated). */
  labelId: number;
  /** Unique, in-range storage indices written to the mask. */
  acceptedCount: number;
  /** Non-integer or out-of-range inputs that were dropped. */
  invalidCount: number;
  /** Repeated in-range inputs that were collapsed. */
  duplicateCount: number;
  mode: "indices" | "obb-fallback";
  color: [number, number, number] | null;
  /** Why index lifting was refused (set only for "obb-fallback"). */
  fallbackReason: string | null;
  /** Cloned fallback OBB (set only for "obb-fallback"). */
  fallbackObb: OBB | null;
  mask: GaussianMaskUpdate | null;
}

export interface DirectIndexSelectionSnapshot {
  objectId: string;
  labelId: number;
  color: [number, number, number];
  selectedIds: Uint32Array;
}

interface StoredIndexSelection {
  objectId: string;
  selectedIds: Uint32Array;
  requestGeneration: number;
}

interface StoredSelection {
  worldObb: OBB;
  selectedIds: Uint32Array;
  lift: ClusterLiftDiagnostics;
  requestGeneration: number;
}

/**
 * Serialized selection owner for one static, non-LOD SplatMesh. IDs are not
 * reused, so late async work cannot accidentally target a newer selection.
 */
export class GaussianObjectHighlighter {
  private readonly selections = new Map<GaussianObjectId, StoredSelection>();
  /** Direct-index selections, keyed by mask label (labels share nextObjectId with select()). */
  private readonly indexSelections = new Map<number, StoredIndexSelection>();
  /** Stable string objectId -> label for this world. Never reassigned, so retired labels are never reused. */
  private readonly labelByObjectId = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private nextObjectId = 1;
  private worldGeneration = 0;
  private disposed = false;

  static async create(splat: SplatMesh): Promise<GaussianObjectHighlighter> {
    const mask = await GaussianMaskManager.create(splat);
    return new GaussianObjectHighlighter(splat, mask);
  }

  private constructor(
    private readonly splat: SplatMesh,
    readonly mask: GaussianMaskManager,
  ) {}

  get size(): number {
    return this.selections.size + this.indexSelections.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Add a selection, or update options.objectId. A null result means the request
   * was invalidated by clear-one, clear-all, or disposal before it could commit.
   */
  select(
    worldObb: OBB,
    options: GaussianObjectSelectOptions = {},
  ): Promise<GaussianObjectSelectionResult | null> {
    if (this.disposed) return Promise.resolve(null);
    // Validate/copy synchronously so later caller mutation cannot change a queued request.
    const obb = cloneObb(worldObb, "worldObb");
    const requestedId = options.objectId;
    if (requestedId !== undefined) {
      this.assertObjectId(requestedId);
      if (!this.selections.has(requestedId)) {
        return Promise.reject(new RangeError(`Unknown Gaussian object: ${requestedId}`));
      }
    }
    const objectId = requestedId ?? this.allocateObjectId();
    const existing = this.selections.get(objectId);
    const requestGeneration = existing?.requestGeneration ?? 0;
    const worldGeneration = this.worldGeneration;
    const liftOptions: ClusterLiftOptions = {
      margin: options.margin,
      minOpacity: options.minOpacity,
    };

    return this.enqueue(async () => {
      if (!this.isRequestCurrent(objectId, requestGeneration, worldGeneration)) return null;
      const lifted = await liftCluster(this.splat, obb, liftOptions);
      if (!this.isRequestCurrent(objectId, requestGeneration, worldGeneration)) return null;

      const maskUpdate = this.mask.replaceLabel(objectId, lifted.indices);
      const selection: StoredSelection = {
        worldObb: obb,
        selectedIds: lifted.indices,
        lift: lifted.diagnostics,
        requestGeneration,
      };
      this.selections.set(objectId, selection);
      return this.result(objectId, selection, maskUpdate);
    });
  }

  /**
   * Select exact storage indices (e.g. a multi-view Gaussian membership) under a
   * caller-owned string ID. The same ID always maps to the same label. A null
   * result means the request was invalidated by clear / clear-all / disposal
   * before it could commit. Without options.fallbackObb, an unsupported (LOD /
   * paged) splat rejects; with it, the OBB is returned and nothing is masked.
   */
  selectIndices(
    objectId: string,
    indices: Uint32Array | readonly number[],
    options: DirectIndexSelectionOptions = {},
  ): Promise<DirectIndexSelectionResult | null> {
    if (this.disposed) return Promise.resolve(null);
    if (typeof objectId !== "string" || objectId.length === 0) {
      throw new TypeError("objectId must be a non-empty string");
    }
    if (!indices || !Number.isSafeInteger(indices.length) || indices.length < 0) {
      throw new TypeError("indices must be an array-like collection of storage indices");
    }
    const fallbackObb = options.fallbackObb ? cloneObb(options.fallbackObb, "fallbackObb") : null;

    const unsupported = nonLodSplatRejectionReason(this.splat);
    if (unsupported) {
      if (!fallbackObb) {
        return Promise.reject(new Error(
          `Gaussian index lifting supports only non-LOD, non-paged SplatMesh inputs (found ${unsupported})`,
        ));
      }
      return Promise.resolve({
        objectId,
        labelId: 0,
        acceptedCount: 0,
        invalidCount: 0,
        duplicateCount: 0,
        mode: "obb-fallback",
        color: null,
        fallbackReason: unsupported,
        fallbackObb,
        mask: null,
      });
    }

    // Validate, dedupe and sort synchronously so later caller mutation cannot alter a queued request.
    const numSplats = this.mask.numSplats;
    const unique = new Set<number>();
    let invalidCount = 0;
    let duplicateCount = 0;
    for (let i = 0; i < indices.length; i++) {
      const id = indices[i];
      if (!Number.isSafeInteger(id) || id < 0 || id >= numSplats) invalidCount++;
      else if (unique.has(id)) duplicateCount++;
      else unique.add(id);
    }
    const cleanIndices = Uint32Array.from(unique).sort();

    let labelId = this.labelByObjectId.get(objectId);
    if (labelId === undefined) {
      labelId = this.allocateObjectId();
      this.labelByObjectId.set(objectId, labelId);
    }
    const label = labelId;
    const existing = this.indexSelections.get(label);
    const requestGeneration = existing?.requestGeneration ?? 0;
    const worldGeneration = this.worldGeneration;

    return this.enqueue(() => {
      if (!this.isIndexRequestCurrent(label, requestGeneration, worldGeneration)) return null;
      const maskUpdate = this.mask.replaceLabel(label, cleanIndices);
      if (cleanIndices.length > 0) {
        this.indexSelections.set(label, {
          objectId,
          selectedIds: cleanIndices,
          requestGeneration: this.indexSelections.get(label)?.requestGeneration ?? requestGeneration,
        });
      } else {
        this.indexSelections.delete(label);
      }
      return {
        objectId,
        labelId: label,
        acceptedCount: cleanIndices.length,
        invalidCount,
        duplicateCount,
        mode: "indices" as const,
        color: this.mask.getLabelColor(label),
        fallbackReason: null,
        fallbackObb: null,
        mask: maskUpdate,
      };
    });
  }

  /** Mask label assigned to a string object ID by selectIndices, if any. */
  getLabelForObject(objectId: string): number | undefined {
    return this.labelByObjectId.get(objectId);
  }

  getIndexSelection(objectId: string): DirectIndexSelectionSnapshot | undefined {
    const label = this.labelByObjectId.get(objectId);
    const selection = label === undefined ? undefined : this.indexSelections.get(label);
    return label !== undefined && selection ? this.indexSnapshot(label, selection) : undefined;
  }

  listIndexSelections(): DirectIndexSelectionSnapshot[] {
    return [...this.indexSelections.entries()]
      .sort(([a], [b]) => a - b)
      .map(([label, selection]) => this.indexSnapshot(label, selection));
  }

  /** Clears an object added by select() or selectIndices() (by its numeric label). */
  clear(objectId: GaussianObjectId): Promise<GaussianMaskUpdate | null> {
    if (this.disposed) return Promise.resolve(null);
    this.assertObjectId(objectId);
    const current = this.selections.get(objectId);
    if (current) current.requestGeneration++;
    const currentIndex = this.indexSelections.get(objectId);
    if (currentIndex) currentIndex.requestGeneration++;
    return this.enqueue(() => {
      if (this.disposed) return null;
      if (!this.selections.has(objectId) && !this.indexSelections.has(objectId)) return null;
      this.selections.delete(objectId);
      this.indexSelections.delete(objectId);
      return this.mask.clearLabel(objectId);
    });
  }

  clearAll(): Promise<GaussianMaskUpdate | null> {
    if (this.disposed) return Promise.resolve(null);
    const worldGeneration = ++this.worldGeneration;
    for (const selection of this.selections.values()) selection.requestGeneration++;
    for (const selection of this.indexSelections.values()) selection.requestGeneration++;
    return this.enqueue(() => {
      if (this.disposed || worldGeneration !== this.worldGeneration) return null;
      this.selections.clear();
      this.indexSelections.clear();
      return this.mask.clear();
    });
  }

  get(objectId: GaussianObjectId): GaussianObjectSelectionSnapshot | undefined {
    this.assertObjectId(objectId);
    const selection = this.selections.get(objectId);
    return selection ? this.snapshot(objectId, selection) : undefined;
  }

  list(): GaussianObjectSelectionSnapshot[] {
    return [...this.selections.entries()]
      .sort(([a], [b]) => a - b)
      .map(([objectId, selection]) => this.snapshot(objectId, selection));
  }

  maskSnapshot(): GaussianMaskSnapshot {
    return this.mask.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worldGeneration++;
    for (const selection of this.selections.values()) selection.requestGeneration++;
    for (const selection of this.indexSelections.values()) selection.requestGeneration++;
    this.selections.clear();
    this.indexSelections.clear();
    this.mask.dispose();
  }

  private allocateObjectId(): GaussianObjectId {
    if (this.nextObjectId > 255) {
      throw new RangeError("At most 255 Gaussian object IDs can be allocated per world");
    }
    return this.nextObjectId++;
  }

  private assertObjectId(objectId: number): void {
    if (!Number.isInteger(objectId) || objectId < 1 || objectId > 255) {
      throw new RangeError("objectId must be an integer in [1, 255]");
    }
  }

  private isRequestCurrent(
    objectId: GaussianObjectId,
    requestGeneration: number,
    worldGeneration: number,
  ): boolean {
    if (this.disposed || worldGeneration !== this.worldGeneration) return false;
    const current = this.selections.get(objectId);
    if (!current) return requestGeneration === 0;
    return current.requestGeneration === requestGeneration;
  }

  private isIndexRequestCurrent(
    label: number,
    requestGeneration: number,
    worldGeneration: number,
  ): boolean {
    if (this.disposed || worldGeneration !== this.worldGeneration) return false;
    const current = this.indexSelections.get(label);
    if (!current) return requestGeneration === 0;
    return current.requestGeneration === requestGeneration;
  }

  private indexSnapshot(label: number, selection: StoredIndexSelection): DirectIndexSelectionSnapshot {
    return {
      objectId: selection.objectId,
      labelId: label,
      color: this.mask.getLabelColor(label),
      selectedIds: selection.selectedIds.slice(),
    };
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private result(
    objectId: GaussianObjectId,
    selection: StoredSelection,
    mask: GaussianMaskUpdate,
  ): GaussianObjectSelectionResult {
    return { ...this.snapshot(objectId, selection), mask };
  }

  private snapshot(
    objectId: GaussianObjectId,
    selection: StoredSelection,
  ): GaussianObjectSelectionSnapshot {
    return {
      objectId,
      label: objectId,
      color: this.mask.getLabelColor(objectId),
      worldObb: cloneObb(selection.worldObb),
      selectedIds: selection.selectedIds.slice(),
      lift: { ...selection.lift },
    };
  }
}
