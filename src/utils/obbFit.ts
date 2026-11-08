import * as THREE from "three";
import { OBB } from "./obb";

export interface OBBFitOptions {
  /** Absolute margin added to each half extent. Default 0.02. */
  margin?: number;
  /** Fewer points than this uses an AABB fallback. Default 4. */
  minPoints?: number;
  /**
   * "pca" (default): free 3D orientation, contains every point.
   * "upright": yaw-only box about +Y (gravity aligned), robust to outliers and
   * stable for round objects.
   */
  mode?: "pca" | "upright";
  /**
   * Upright mode: fraction trimmed from each side of the horizontal extents.
   * Kept small because trimming shrinks round footprints. Default 0.01.
   */
  trim?: number;
  /** Upright mode: fraction trimmed from each side of the height. Default 0.02. */
  trimY?: number;
  /** Upright mode: fits with fewer points than this skip trimming. Default 40. */
  minTrimPoints?: number;
  /**
   * Upright mode: if one thin horizontal layer (e.g. a table top) holds most
   * points, fit only that layer so legs/floor do not inflate the height.
   * Default false.
   */
  dominantLayer?: boolean;
}

export interface OBBFitResult {
  obb: OBB;
  method: "pca" | "upright" | "aabb-fallback";
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

/** Quantile of an ascending-sorted array (nearest-rank, clamped). */
function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

/** Trimmed [lo, hi] extent of values (mutates order of `values`). */
function trimmedRange(values: number[], trim: number): [number, number] {
  values.sort((a, b) => a - b);
  return [quantile(values, trim), quantile(values, 1 - trim)];
}

/**
 * Densest contiguous horizontal layer of points, or the input unchanged when no
 * thin layer dominates (>= 50% of points and < 50% of the height range).
 */
export function dominantHorizontalLayer(
  points: readonly THREE.Vector3[],
  binSize = 0.04,
  edgeFraction = 0.2,
): readonly THREE.Vector3[] {
  if (points.length < 40) return points;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const range = yMax - yMin;
  if (!(range > binSize * 2)) return points;
  const nb = Math.floor(range / binSize) + 1;
  const bins = new Array<number>(nb).fill(0);
  const binOf = (y: number) => Math.min(nb - 1, Math.floor((y - yMin) / binSize));
  for (const p of points) bins[binOf(p.y)]++;
  let peak = 0;
  for (let i = 1; i < nb; i++) if (bins[i] > bins[peak]) peak = i;
  const thresh = bins[peak] * edgeFraction;
  let lo = peak;
  let hi = peak;
  while (lo > 0 && bins[lo - 1] >= thresh) lo--;
  while (hi < nb - 1 && bins[hi + 1] >= thresh) hi++;
  const layer = points.filter((p) => {
    const b = binOf(p.y);
    return b >= lo && b <= hi;
  });
  const thickness = (hi - lo + 1) * binSize;
  if (layer.length >= points.length * 0.5 && thickness < range * 0.5) return layer;
  return points;
}

/**
 * Gravity-aligned fit: yaw about +Y chosen to minimise the trimmed footprint
 * area. Near-isotropic footprints (round objects) fall back to yaw 0 so the
 * box does not spin arbitrarily.
 */
function fitUpright(
  points: readonly THREE.Vector3[],
  margin: number,
  trimOpt: number,
  trimYOpt: number,
  minTrimPoints: number,
): OBBFitResult {
  const n = points.length;
  const clampTrim = (t: number) =>
    n >= minTrimPoints ? Math.min(0.25, Math.max(0, t)) : 0;
  const trim = clampTrim(trimOpt);
  const trimY = clampTrim(trimYOpt);
  const us = new Array<number>(n);
  const vs = new Array<number>(n);
  const evaluate = (theta: number) => {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let i = 0; i < n; i++) {
      us[i] = points[i].x * c - points[i].z * s;
      vs[i] = points[i].x * s + points[i].z * c;
    }
    const [u0, u1] = trimmedRange(us, trim);
    const [v0, v1] = trimmedRange(vs, trim);
    return { area: (u1 - u0) * (v1 - v0), u0, u1, v0, v1 };
  };

  const steps = 90; // 1 degree over [0, 90deg): a rectangle is 90-degree periodic
  const base = evaluate(0);
  let best = { theta: 0, ...base };
  let worstArea = base.area;
  for (let k = 1; k < steps; k++) {
    const theta = (k / steps) * (Math.PI / 2);
    const r = evaluate(theta);
    worstArea = Math.max(worstArea, r.area);
    if (r.area < best.area) best = { theta, ...r };
  }
  // Isotropic footprint: orientation is unobservable, prefer axis-aligned.
  if (worstArea > 0 && (worstArea - best.area) / worstArea < 0.08) {
    best = { theta: 0, ...base };
  }

  const ys = points.map((p) => p.y);
  const [y0, y1] = trimmedRange(ys, trimY);
  const c = Math.cos(best.theta);
  const s = Math.sin(best.theta);
  const uc = (best.u0 + best.u1) / 2;
  const vc = (best.v0 + best.v1) / 2;
  // Inverse of the (u, v) projection above.
  const position = new THREE.Vector3(
    uc * c + vc * s,
    (y0 + y1) / 2,
    -uc * s + vc * c,
  );
  const size = new THREE.Vector3(
    best.u1 - best.u0,
    y1 - y0,
    best.v1 - best.v0,
  ).addScalar(margin * 2);
  // Box local x axis must equal the u direction (c, 0, -s) in world space.
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    best.theta,
  );
  return {
    obb: new OBB({ position, quaternion, size }),
    method: "upright",
    eigenvalues: [0, 0, 0],
  };
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
  if (opts.mode === "upright") {
    return fitUpright(
      opts.dominantLayer ? dominantHorizontalLayer(points) : points,
      margin,
      opts.trim ?? 0.01,
      opts.trimY ?? 0.02,
      opts.minTrimPoints ?? 40,
    );
  }

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
