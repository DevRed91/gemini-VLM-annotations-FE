import * as THREE from "three";

import { generateSnapshotRay, validateViewSnapshot, type ViewSnapshot } from "./ViewSnapshot.ts";

/**
 * A ViewSnapshot bound to the exact splat instance that was drawn in it.
 * The snapshot is plain frozen data and cannot carry object identity itself,
 * so the viewer keeps the instance alongside it.
 */
export interface SnapshotBinding {
  readonly snapshotId: string;
  readonly worldGeneration: number;
  /** Frozen data: image, camera world/inverse/projection matrices, splat matrixWorld. */
  readonly snapshot: ViewSnapshot;
  /** The exact splat instance drawn in the snapshot (identity, compared by reference). */
  readonly splat: THREE.Object3D;
}

/** Live viewer state a binding is checked against. */
export interface LiveWorldState {
  readonly worldGeneration: number;
  readonly splat: THREE.Object3D | null;
  readonly splatLoaded: boolean;
}

export type StaleReason =
  | "no-splat"
  | "world-generation"
  | "splat-instance"
  | "splat-transform";

export class StaleSnapshotError extends Error {
  readonly reason: StaleReason;
  constructor(reason: StaleReason, message: string) {
    super(message);
    this.name = "StaleSnapshotError";
    this.reason = reason;
  }
}

const MATRIX_EPSILON = 1e-6;

function matricesMatch(a: readonly number[], b: ArrayLike<number>): boolean {
  if (a.length !== 16 || b.length !== 16) return false;
  for (let i = 0; i < 16; i++) if (!(Math.abs(a[i] - b[i]) <= MATRIX_EPSILON)) return false;
  return true;
}

/**
 * Pair a freshly captured snapshot with the splat that is live right now.
 * Rejects before splat initialization (no splat, or world not yet ready).
 */
export function bindSnapshot(snapshot: ViewSnapshot, live: LiveWorldState): SnapshotBinding {
  if (!live.splat || !live.splatLoaded) {
    throw new StaleSnapshotError("no-splat", "Cannot bind a view snapshot before the splat is initialized");
  }
  const binding: SnapshotBinding = Object.freeze({
    snapshotId: snapshot.id,
    worldGeneration: snapshot.worldGeneration,
    snapshot,
    splat: live.splat,
  });
  assertBindingCurrent(binding, live);
  return binding;
}

/**
 * Throw StaleSnapshotError unless the snapshot's world generation, splat
 * instance, and splat world transform all still match the live viewer.
 */
export function assertBindingCurrent(binding: SnapshotBinding, live: LiveWorldState): void {
  if (!live.splat || !live.splatLoaded) {
    throw new StaleSnapshotError("no-splat", "Snapshot is stale: no initialized splat is loaded");
  }
  if (binding.worldGeneration !== live.worldGeneration || binding.snapshot.worldGeneration !== live.worldGeneration) {
    throw new StaleSnapshotError(
      "world-generation",
      `Snapshot is stale: captured generation ${binding.worldGeneration}, current generation ${live.worldGeneration}`,
    );
  }
  if (binding.splat !== live.splat) {
    throw new StaleSnapshotError("splat-instance", "Snapshot is stale: the splat instance was replaced");
  }
  validateViewSnapshot(binding.snapshot, live.worldGeneration);
  const frozen = binding.snapshot.splat;
  if (!frozen || !matricesMatch(frozen.matrixWorld, binding.splat.matrixWorld.elements)) {
    // Spark raycasts through the splat's *live* matrixWorld, so a moved splat
    // would make snapshot rays hit different geometry than the image shows.
    throw new StaleSnapshotError("splat-transform", "Snapshot is stale: the splat world transform changed");
  }
}

/**
 * Same contract as SplatViewer.splatRay, but the ray comes from the frozen
 * snapshot camera instead of the live camera. Normalized (u,v) are fractions
 * of the snapshot image, origin top-left, y down.
 */
export function snapshotSplatRay(
  binding: SnapshotBinding,
  live: LiveWorldState,
  normalizedX: number,
  normalizedY: number,
): { ray: THREE.Ray; intersection: THREE.Intersection | null } {
  assertBindingCurrent(binding, live);
  const { origin, direction } = generateSnapshotRay(
    binding.snapshot,
    normalizedX,
    normalizedY,
    live.worldGeneration,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.set(origin.x, origin.y, origin.z);
  raycaster.ray.direction.set(direction.x, direction.y, direction.z);
  const intersects = raycaster.intersectObject(binding.splat);
  return { ray: raycaster.ray, intersection: intersects.length > 0 ? intersects[0] : null };
}

/**
 * Verify the camera pose did not change between the pre-capture state (the
 * pose the user clicked in) and the snapshot's render. Returns the max
 * element difference of the world matrices; throws if above tolerance.
 */
export function assertPoseUnchanged(
  poseBeforeCapture: ArrayLike<number>,
  snapshot: ViewSnapshot,
  tolerance = 1e-6,
): number {
  const after = snapshot.camera.worldMatrix;
  let drift = 0;
  for (let i = 0; i < 16; i++) drift = Math.max(drift, Math.abs(poseBeforeCapture[i] - after[i]));
  if (!(drift <= tolerance)) {
    throw new Error(`Camera pose changed during snapshot capture (max matrix drift ${drift})`);
  }
  return drift;
}

/**
 * Validate a detection box before it is converted to NDC: Gemini convention
 * [ymin, xmin, ymax, xmax], fractions of the snapshot image (origin top-left,
 * y down), and an image whose size matches the drawing buffer.
 */
export function assertImageSpaceBox(
  snapshot: ViewSnapshot,
  box: readonly number[],
): void {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new RangeError("box must be four finite fractions in [0, 1] ordered [ymin, xmin, ymax, xmax]");
  }
  const [ymin, xmin, ymax, xmax] = box;
  if (!(ymin < ymax) || !(xmin < xmax)) {
    throw new RangeError("box must satisfy ymin < ymax and xmin < xmax");
  }
  if (
    snapshot.image.width !== snapshot.viewport.drawingBufferWidth ||
    snapshot.image.height !== snapshot.viewport.drawingBufferHeight
  ) {
    throw new RangeError("snapshot image dimensions do not match the drawing buffer");
  }
}
