import * as THREE from "three";

export const OBB_QUATERNION_TOLERANCE = 1e-6;

/**
 * Oriented bounding box: rigid transform (position + rotation) plus full
 * size in world units. Scale is deliberately not baked into the matrix.
 */
export class OBB {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly size = new THREE.Vector3(1, 1, 1);

  constructor(init?: {
    position?: THREE.Vector3;
    quaternion?: THREE.Quaternion;
    size?: THREE.Vector3;
  }) {
    if (init?.position) this.position.copy(init.position);
    if (init?.quaternion) this.quaternion.copy(init.quaternion);
    if (init?.size) this.size.copy(init.size);
  }

  /** Build from an Object3D whose geometry is a box of `geometrySize`. */
  static fromObject3D(obj: THREE.Object3D, geometrySize: THREE.Vector3): OBB {
    return new OBB().syncFromObject3D(obj, geometrySize);
  }

  /** Re-read pose/scale from an Object3D (call after it moves). */
  syncFromObject3D(obj: THREE.Object3D, geometrySize: THREE.Vector3): this {
    obj.updateWorldMatrix(true, false);
    const s = new THREE.Vector3();
    obj.matrixWorld.decompose(this.position, this.quaternion, s);
    // A mirrored object (negative scale) decomposes to a negative axis scale.
    // A box is symmetric, so only the magnitude matters.
    s.set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
    this.size.copy(geometrySize).multiply(s);
    return this;
  }

  get halfExtents(): THREE.Vector3 {
    return this.size.clone().multiplyScalar(0.5);
  }

  /** Box local -> world (rigid, no scale). */
  getWorldMatrix(target = new THREE.Matrix4()): THREE.Matrix4 {
    return target.compose(this.position, this.quaternion, UNIT_SCALE);
  }
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

export function validateObb(obb: OBB, name = "obb"): void {
  if (
    ![obb.position.x, obb.position.y, obb.position.z].every(Number.isFinite)
  ) {
    throw new RangeError(`${name}.position must contain only finite values`);
  }
  if (![obb.size.x, obb.size.y, obb.size.z].every(Number.isFinite)) {
    throw new RangeError(`${name}.size must contain only finite values`);
  }
  if (obb.size.x < 0 || obb.size.y < 0 || obb.size.z < 0) {
    throw new RangeError(`${name}.size components must be non-negative`);
  }
  const q = obb.quaternion;
  if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) {
    throw new RangeError(`${name}.quaternion must contain only finite values`);
  }
  if (Math.abs(q.lengthSq() - 1) > OBB_QUATERNION_TOLERANCE) {
    throw new RangeError(`${name}.quaternion must be unit length`);
  }
}

/** Return a validated defensive copy of an OBB. */
export function cloneObb(obb: OBB, name = "obb"): OBB {
  if (!obb) throw new TypeError(`${name} must be an OBB`);
  const clone = new OBB(obb);
  validateObb(clone, name);
  return clone;
}
