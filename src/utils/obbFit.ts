import * as THREE from "three";
import { OBB } from "./obb";

export interface OBBFitOptions {
  /** Absolute margin added to each half extent. Default 0.02. */
  margin?: number;
  /** Fewer points than this uses an AABB fallback. Default 4. */
  minPoints?: number;
}

export interface OBBFitResult {
  obb: OBB;
  method: "pca" | "aabb-fallback";
  eigenvalues: [number, number, number];
}

/** Eigen-decomposition of a symmetric 3x3 row-major matrix. */
function jacobiEigen(a: number[]): { values: number[]; vectors: THREE.Vector3[] } {
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const A = a.slice();
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) /
        (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p];
        const akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq;
        A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k];
        const aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk;
        A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => A[j * 3 + j] - A[i * 3 + i]);
  return {
    values: idx.map((i) => A[i * 3 + i]),
    vectors: idx.map((i) =>
      new THREE.Vector3(v[i], v[3 + i], v[6 + i]).normalize(),
    ),
  };
}

function aabbFallback(
  points: readonly THREE.Vector3[],
  margin: number,
): OBBFitResult {
  const box = new THREE.Box3().setFromPoints(points.slice());
  const size = box.getSize(new THREE.Vector3()).addScalar(margin * 2);
  const obb = new OBB({ position: box.getCenter(new THREE.Vector3()), size });
  return { obb, method: "aabb-fallback", eigenvalues: [0, 0, 0] };
}

/** Fit a world-space OBB using PCA, with a degenerate-input AABB fallback. */
export function fitOBB(
  points: readonly THREE.Vector3[],
  opts: OBBFitOptions = {},
): OBBFitResult | null {
  const margin = opts.margin ?? 0.02;
  const minPoints = opts.minPoints ?? 4;
  if (points.length === 0) return null;
  if (points.length < minPoints) return aabbFallback(points, margin);

  const n = points.length;
  const mean = new THREE.Vector3();
  for (const p of points) mean.add(p);
  mean.divideScalar(n);

  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const x = p.x - mean.x;
    const y = p.y - mean.y;
    const z = p.z - mean.z;
    cov[0] += x * x;
    cov[1] += x * y;
    cov[2] += x * z;
    cov[4] += y * y;
    cov[5] += y * z;
    cov[8] += z * z;
  }
  cov[3] = cov[1];
  cov[6] = cov[2];
  cov[7] = cov[5];
  for (let i = 0; i < 9; i++) cov[i] /= n;

  const { values, vectors } = jacobiEigen(cov);
  const [e0, e1, e2] = values;
  if (!(e0 > 1e-10) || !Number.isFinite(e0) || e1 < e0 * 1e-6) {
    return aabbFallback(points, margin);
  }

  const [ax, ay] = vectors;
  for (const axis of [ax, ay]) {
    const m = Math.abs(axis.x) >= Math.abs(axis.y) &&
      Math.abs(axis.x) >= Math.abs(axis.z)
      ? axis.x
      : Math.abs(axis.y) >= Math.abs(axis.z)
        ? axis.y
        : axis.z;
    if (m < 0) axis.negate();
  }
  ay.sub(ax.clone().multiplyScalar(ax.dot(ay))).normalize();
  const az = new THREE.Vector3().crossVectors(ax, ay).normalize();

  const basis = new THREE.Matrix4().makeBasis(ax, ay, az);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis).normalize();

  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const d = new THREE.Vector3();
  for (const p of points) {
    d.subVectors(p, mean);
    const local = new THREE.Vector3(d.dot(ax), d.dot(ay), d.dot(az));
    min.min(local);
    max.max(local);
  }
  const localCenter = min.clone().add(max).multiplyScalar(0.5);
  const position = mean.clone()
    .addScaledVector(ax, localCenter.x)
    .addScaledVector(ay, localCenter.y)
    .addScaledVector(az, localCenter.z);
  const size = max.clone().sub(min).addScalar(margin * 2);

  return {
    obb: new OBB({ position, quaternion, size }),
    method: "pca",
    eigenvalues: [e0, e1, e2],
  };
}

/** Convert a world OBB to a near-uniform-scale object's local space. */
export function obbWorldToLocal(world: OBB, object: THREE.Object3D): OBB {
  object.updateWorldMatrix(true, false);
  const inverse = object.matrixWorld.clone().invert();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  inverse.decompose(pos, q, s);
  const sAbs = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
  const localPos = world.position.clone().applyMatrix4(inverse);
  const localQuat = q.clone().multiply(world.quaternion).normalize();
  return new OBB({
    position: localPos,
    quaternion: localQuat,
    size: world.size.clone().multiplyScalar(sAbs),
  });
}
