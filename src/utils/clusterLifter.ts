import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { OBB } from "./obb";
import { validateObb } from "./obb";
import { assertNonLodSplat } from "./gaussianIndexSupport";

export interface ClusterLiftOptions {
  /** Inclusive expansion of each OBB half-extent, in OBB-local/world units. */
  margin?: number;
  /** Inclusive minimum opacity, applied only after geometric candidacy. */
  minOpacity?: number;
}

export interface ClusterLiftDiagnostics {
  numSplats: number;
  scanned: number;
  candidates: number;
  accepted: number;
  opacityRejected: number;
  invalid: number;
  duplicateIndices: number;
  scanDurationMs: number;
}

export interface ClusterLiftResult {
  /** Ascending, unique indices into the non-LOD splat's underlying storage. */
  indices: Uint32Array;
  diagnostics: ClusterLiftDiagnostics;
}

function validateInputs(splat: SplatMesh, obb: OBB, options: ClusterLiftOptions): {
  margin: number;
  minOpacity: number;
  numSplats: number;
} {
  assertNonLodSplat(splat, "Gaussian index lifting");

  const margin = options.margin ?? 0;
  const minOpacity = options.minOpacity ?? 0;
  if (!Number.isFinite(margin) || margin < 0) {
    throw new RangeError("margin must be a finite, non-negative number");
  }
  if (!Number.isFinite(minOpacity) || minOpacity < 0 || minOpacity > 1) {
    throw new RangeError("minOpacity must be a finite number in [0, 1]");
  }

  validateObb(obb);

  const numSplats = splat.numSplats;
  if (!Number.isSafeInteger(numSplats) || numSplats < 0) {
    throw new RangeError("splat.numSplats must be a non-negative safe integer");
  }
  return { margin, minOpacity, numSplats };
}

/**
 * Lift an already-fitted world-space OBB to exact non-LOD storage indices.
 * This performs centre/opacity filtering only; it does not fit OBBs or infer
 * semantic ownership. Callback objects are copied before further processing
 * because Spark reuses them between forEachSplat invocations.
 */
export async function liftCluster(
  splat: SplatMesh,
  obb: OBB,
  options: ClusterLiftOptions = {},
): Promise<ClusterLiftResult> {
  await splat.initialized;
  const { margin, minOpacity, numSplats } = validateInputs(splat, obb, options);

  splat.updateWorldMatrix(true, false);
  const obbWorld = obb.getWorldMatrix();
  const determinant = obbWorld.determinant() * splat.matrixWorld.determinant();
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-20) {
    throw new RangeError("OBB and splat transforms must be finite and invertible");
  }
  const splatToObb = new THREE.Matrix4()
    .copy(obbWorld)
    .invert()
    .multiply(splat.matrixWorld);
  if (!splatToObb.elements.every(Number.isFinite)) {
    throw new RangeError("OBB and splat transforms must produce a finite mapping");
  }

  const half = obb.halfExtents;
  const hx = half.x + margin;
  const hy = half.y + margin;
  const hz = half.z + margin;
  const local = new THREE.Vector3();
  const accepted: number[] = [];
  const seen = new Uint8Array(numSplats);
  const diagnostics: ClusterLiftDiagnostics = {
    numSplats,
    scanned: 0,
    candidates: 0,
    accepted: 0,
    opacityRejected: 0,
    invalid: 0,
    duplicateIndices: 0,
    scanDurationMs: 0,
  };

  const scanStart = performance.now();
  splat.forEachSplat((index, center, _scales, _quaternion, opacity) => {
    diagnostics.scanned++;

    // Copy all callback values used by the scan immediately.
    local.copy(center);
    const splatOpacity = opacity;
    if (!Number.isSafeInteger(index) || index < 0 || index >= numSplats) {
      diagnostics.invalid++;
      return;
    }
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) {
      diagnostics.invalid++;
      return;
    }

    local.applyMatrix4(splatToObb);
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y) || !Number.isFinite(local.z)) {
      diagnostics.invalid++;
      return;
    }
    if (Math.abs(local.x) > hx || Math.abs(local.y) > hy || Math.abs(local.z) > hz) {
      return;
    }

    diagnostics.candidates++;
    if (!Number.isFinite(splatOpacity)) {
      diagnostics.invalid++;
      return;
    }
    if (splatOpacity < minOpacity) {
      diagnostics.opacityRejected++;
      return;
    }
    if (seen[index]) {
      diagnostics.duplicateIndices++;
      return;
    }
    seen[index] = 1;
    accepted.push(index);
  });
  diagnostics.scanDurationMs = performance.now() - scanStart;

  accepted.sort((a, b) => a - b);
  const indices = Uint32Array.from(accepted);
  diagnostics.accepted = indices.length;
  return { indices, diagnostics };
}
