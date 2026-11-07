import type { SplatMesh } from "@sparkjsdev/spark";
import { liftCluster } from "./clusterLifter";
import type { ClusterLiftDiagnostics, ClusterLiftOptions } from "./clusterLifter";
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
    return this.selections.size;
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

  clear(objectId: GaussianObjectId): Promise<GaussianMaskUpdate | null> {
    if (this.disposed) return Promise.resolve(null);
    this.assertObjectId(objectId);
    const current = this.selections.get(objectId);
    if (current) current.requestGeneration++;
    return this.enqueue(() => {
      if (this.disposed) return null;
      if (!this.selections.has(objectId)) return null;
      this.selections.delete(objectId);
      return this.mask.clearLabel(objectId);
    });
  }

  clearAll(): Promise<GaussianMaskUpdate | null> {
    if (this.disposed) return Promise.resolve(null);
    const worldGeneration = ++this.worldGeneration;
    for (const selection of this.selections.values()) selection.requestGeneration++;
    return this.enqueue(() => {
      if (this.disposed || worldGeneration !== this.worldGeneration) return null;
      this.selections.clear();
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
    this.selections.clear();
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
