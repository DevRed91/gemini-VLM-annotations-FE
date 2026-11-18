import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";

import { generateSnapshotRay, type SnapshotVector3, type ViewSnapshot } from "../viewer/ViewSnapshot.ts";
import type { LiveWorldState } from "../viewer/SnapshotBinding.ts";
import { assertNonLodSplat } from "../utils/gaussianIndexSupport.ts";
import { fitOBB, type OBBFitResult } from "../utils/obbFit.ts";
import { assertCaptureCurrent, createSplatCaster, type CastFn } from "./geometry.ts";

export type LiftView = "front" | "side" | "top";

/** Decoded binary foreground mask: row-major, one byte per pixel, 1 = foreground (see `decodeRle`). */
export interface DecodedMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface ViewObservation {
  readonly view: LiftView;
  /** Frozen capture this observation was made in. Validated against the live world before use. */
  readonly snapshot: ViewSnapshot;
  /** False when the product was not verified visible in this view; the view is skipped entirely. */
  readonly visible: boolean;
  readonly mask?: DecodedMask | null;
  /** Gemini-convention [ymin, xmin, ymax, xmax] fractions; used as a rectangular mask only when no usable mask exists. */
  readonly bboxNormalized?: readonly [number, number, number, number];
}

export interface MultiViewLiftOptions {
  /** Max mask-constrained probe rays per view. Default 20. Each ray costs ~35 ms on a large splat. */
  raysPerView?: number;
  /** Search-volume padding as a fraction of the largest surface-hit extent. Default 0.15. */
  bboxPaddingRatio?: number;
  /** Inclusive minimum Gaussian opacity for candidacy. Default 0.05. */
  minOpacity?: number;
  /** A Gaussian more than this (scene units, along the view axis) behind the visible surface abstains. Default 0.25. */
  depthToleranceSceneUnits?: number;
  /** Positive (foreground, unoccluded) votes required. Default 1. */
  minPositiveVotes?: number;
}

export interface MultiViewLiftInput {
  readonly splat: SplatMesh;
  /** Current world generation of the viewer; snapshots from any other generation are excluded. */
  readonly worldGeneration: number;
  readonly views: readonly ViewObservation[];
  readonly options?: MultiViewLiftOptions;
  /** Override the splat raycaster (tests). Defaults to `createSplatCaster(splat)`. */
  readonly cast?: CastFn;
}

export interface ExcludedView {
  readonly view: LiftView;
  readonly reason: string;
}

export interface MultiViewLiftDiagnostics {
  /** Views that took part in Stage B voting. */
  readonly viewsUsed: readonly LiftView[];
  readonly excludedViews: readonly ExcludedView[];
  /** Raw splat hits per view from Stage A (before outlier filtering). */
  readonly sparseHitsPerView: Readonly<Partial<Record<LiftView, number>>>;
  /** Views whose foreground came from `bboxNormalized` instead of a SAM mask. */
  readonly bboxFallbackViews: readonly LiftView[];
  readonly outlierHitsRemoved: number;
  readonly surfacePointCount: number;
  readonly searchVolume: { readonly min: SnapshotVector3; readonly max: SnapshotVector3 } | null;
  /** Splats scanned in Stage A. */
  readonly scannedCount: number;
  /** Gaussians inside the padded AABB with opacity >= minOpacity. */
  readonly candidateCount: number;
  readonly acceptedCount: number;
  /** Candidates with at least one unoccluded view that placed them on background. */
  readonly rejectedBackgroundCount: number;
  /** Candidates (not already background-rejected) that ended below minPositiveVotes. */
  readonly rejectedInsufficientVotesCount: number;
  /** Candidates for which at least one view abstained because the Gaussian lies behind that view's surface. */
  readonly abstainedOccludedCount: number;
  readonly durationMs: number;
}

export interface MultiViewLiftResult {
  /** Ascending, unique storage indices into the non-LOD splat. */
  readonly indices: Uint32Array;
  /** OBB fitted to the fused visible-surface hits (hidden back sides are not sampled), or null with no hits. */
  readonly obb: OBBFitResult | null;
  readonly diagnostics: MultiViewLiftDiagnostics;
}

interface ResolvedOptions {
  raysPerView: number;
  bboxPaddingRatio: number;
  minOpacity: number;
  depthToleranceSceneUnits: number;
  minPositiveVotes: number;
}

function resolveOptions(options: MultiViewLiftOptions = {}): ResolvedOptions {
  const resolved = {
    raysPerView: options.raysPerView ?? 20,
    bboxPaddingRatio: options.bboxPaddingRatio ?? 0.15,
    minOpacity: options.minOpacity ?? 0.05,
    depthToleranceSceneUnits: options.depthToleranceSceneUnits ?? 0.25,
    minPositiveVotes: options.minPositiveVotes ?? 1,
  };
  if (!Number.isInteger(resolved.raysPerView) || resolved.raysPerView < 1) {
    throw new RangeError("raysPerView must be a positive integer");
  }
  if (!Number.isFinite(resolved.bboxPaddingRatio) || resolved.bboxPaddingRatio < 0) {
    throw new RangeError("bboxPaddingRatio must be a finite, non-negative number");
  }
  if (!Number.isFinite(resolved.minOpacity) || resolved.minOpacity < 0 || resolved.minOpacity > 1) {
    throw new RangeError("minOpacity must be a finite number in [0, 1]");
  }
  if (!Number.isFinite(resolved.depthToleranceSceneUnits) || resolved.depthToleranceSceneUnits < 0) {
    throw new RangeError("depthToleranceSceneUnits must be a finite, non-negative number");
  }
  if (!Number.isInteger(resolved.minPositiveVotes) || resolved.minPositiveVotes < 1) {
    throw new RangeError("minPositiveVotes must be a positive integer");
  }
  return resolved;
}

// ------------------------------------------------------------------- masks

const BBOX_MASK_RESOLUTION = 128;

function validateMask(mask: DecodedMask): void {
  if (
    !Number.isInteger(mask.width) || !Number.isInteger(mask.height) ||
    mask.width <= 0 || mask.height <= 0 ||
    !mask.data || mask.data.length !== mask.width * mask.height
  ) {
    throw new RangeError("mask data length must equal width * height");
  }
}

function hasForeground(mask: DecodedMask): boolean {
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) return true;
  return false;
}

/** Rectangular stand-in mask from a Gemini-convention box. Coarse; only used when no SAM mask exists. */
function maskFromBox(box: readonly number[]): DecodedMask {
  if (box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || !(box[0] < box[2]) || !(box[1] < box[3])) {
    throw new RangeError("bboxNormalized must be [ymin, xmin, ymax, xmax] fractions with min < max");
  }
  const n = BBOX_MASK_RESOLUTION;
  const data = new Uint8Array(n * n);
  const [ymin, xmin, ymax, xmax] = box;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    if (v < ymin || v > ymax) continue;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      if (u >= xmin && u <= xmax) data[y * n + x] = 1;
    }
  }
  return { width: n, height: n, data };
}

/** Is the normalized top-left point (u, v) on a foreground pixel? */
function maskAt(mask: DecodedMask, u: number, v: number): boolean {
  const x = Math.min(mask.width - 1, Math.floor(u * mask.width));
  const y = Math.min(mask.height - 1, Math.floor(v * mask.height));
  return mask.data[y * mask.width + x] === 1;
}

/** Chessboard distance to the nearest background pixel (image border counts as background). */
function interiorDistance(mask: DecodedMask): Uint16Array {
  const { width: w, height: h, data } = mask;
  const dist = new Uint16Array(w * h);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : dist[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      dist[y * w + x] = 1 + Math.min(at(x - 1, y), at(x, y - 1), at(x - 1, y - 1), at(x + 1, y - 1));
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!data[i]) continue;
      dist[i] = Math.min(dist[i], 1 + Math.min(at(x + 1, y), at(x, y + 1), at(x + 1, y + 1), at(x - 1, y + 1)));
    }
  }
  return dist;
}

const INTERIOR_FRACTION = 0.2;
const MAX_SAMPLING_POOL = 20000;

/**
 * Deterministic foreground samples that cover the mask's extent while staying
 * off its boundary: the pool is every pixel at least 20% of the mask's
 * inscribed radius from the edge (edge pixels are where SAM noise and
 * background grazing live), then farthest-point sampling spreads `count`
 * probes across the pool, starting from its deepest pixel. Spreading matters:
 * the probes' 3D hits define the search volume, so probes bunched in the
 * middle would shrink it inside the object.
 */
export function sampleMaskInterior(mask: DecodedMask, count: number): Array<{ u: number; v: number }> {
  validateMask(mask);
  const dist = interiorDistance(mask);
  let maxDist = 0;
  let deepest = -1;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] > maxDist) {
      maxDist = dist[i];
      deepest = i;
    }
  }
  if (deepest < 0) return [];

  const pick = (minDist: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < dist.length; i++) if (dist[i] >= minDist) out.push(i);
    return out;
  };
  let pool = pick(Math.max(1, Math.ceil(maxDist * INTERIOR_FRACTION)));
  if (pool.length < count) pool = pick(1);
  if (pool.length > MAX_SAMPLING_POOL) {
    const stride = pool.length / MAX_SAMPLING_POOL;
    pool = Array.from({ length: MAX_SAMPLING_POOL }, (_, k) => pool[Math.floor(k * stride)]);
    if (!pool.includes(deepest)) pool.push(deepest);
  }

  const px = (i: number) => i % mask.width;
  const py = (i: number) => Math.floor(i / mask.width);
  let chosen: number[];
  if (pool.length <= count) {
    chosen = pool;
  } else {
    chosen = [deepest];
    const gap = new Float64Array(pool.length).fill(Infinity);
    while (chosen.length < count) {
      const last = chosen[chosen.length - 1];
      let bestK = 0;
      let bestGap = -1;
      for (let k = 0; k < pool.length; k++) {
        const d = (px(pool[k]) - px(last)) ** 2 + (py(pool[k]) - py(last)) ** 2;
        if (d < gap[k]) gap[k] = d;
        if (gap[k] > bestGap) {
          bestGap = gap[k];
          bestK = k;
        }
      }
      chosen.push(pool[bestK]);
    }
  }
  return chosen.map((i) => ({ u: (px(i) + 0.5) / mask.width, v: (py(i) + 0.5) / mask.height }));
}

// ------------------------------------------------------------------ helpers

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Drop hits far from the component-wise median (median + 4 robust sigma, never tighter than 1.5x median spread). */
function inlierMask(points: readonly SnapshotVector3[]): boolean[] {
  if (points.length < 4) return points.map(() => true);
  const c = {
    x: median(points.map((p) => p.x)),
    y: median(points.map((p) => p.y)),
    z: median(points.map((p) => p.z)),
  };
  const d = points.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z));
  const med = median(d);
  const mad = median(d.map((x) => Math.abs(x - med)));
  const limit = Math.max(med + 4 * Math.max(1.4826 * mad, 1e-6), 1.5 * med);
  return d.map((x) => x <= limit);
}

interface DepthSample {
  readonly u: number;
  readonly v: number;
  /** Depth along the capture camera's viewing axis, scene units. */
  readonly depth: number;
}

/** Column-major 4x4 (THREE / snapshot layout) applied to a point; returns [x, y, z, w]. */
function apply(m: readonly number[], x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

interface ViewState {
  readonly view: LiftView;
  readonly snapshot: ViewSnapshot;
  readonly mask: DecodedMask;
  samples: DepthSample[];
  rawHits: number;
}

// ------------------------------------------------------------------- lifter

/**
 * Resolve the Gaussian storage indices belonging to one verified product from
 * several snapshot views. Prune in 3D first (sparse mask-constrained raycasts
 * give a padded AABB), then vote in 2D (each candidate is projected into every
 * view; a Gaussian behind that view's visible surface abstains, otherwise the
 * view votes by the mask pixel it lands on).
 *
 * Depth convention: depths are measured along each capture camera's viewing
 * axis (view-space -z), for both the Gaussian and the ray-hit surface samples.
 * Unlike Euclidean camera distance this is constant across a fronto-parallel
 * surface, so the nearest-sample surface lookup is not biased by ray angle.
 *
 * Limitation: only surfaces seen by some view are sampled, so the AABB (and the
 * OBB) cover what the views can see, padded by `bboxPaddingRatio`.
 */
export async function liftMultiViewGaussians(input: MultiViewLiftInput): Promise<MultiViewLiftResult> {
  const { splat, worldGeneration, views } = input;
  const options = resolveOptions(input.options);
  await splat.initialized;
  assertNonLodSplat(splat, "Multi-view Gaussian lifting");
  const numSplats = splat.numSplats;
  if (!Number.isSafeInteger(numSplats) || numSplats < 0) {
    throw new RangeError("splat.numSplats must be a non-negative safe integer");
  }
  const seen = new Set<LiftView>();
  for (const observation of views) {
    if (seen.has(observation.view)) throw new RangeError(`Duplicate observation for view "${observation.view}"`);
    seen.add(observation.view);
  }

  const start = performance.now();
  const live: LiveWorldState = { worldGeneration, splat, splatLoaded: true };
  const excluded: ExcludedView[] = [];
  const bboxFallbackViews: LiftView[] = [];
  const states: ViewState[] = [];

  // ---- snapshot validation: exclude, never mix coordinate frames
  for (const observation of views) {
    if (!observation.visible) {
      excluded.push({ view: observation.view, reason: "not visible" });
      continue;
    }
    try {
      assertCaptureCurrent(observation.snapshot, live);
    } catch (error) {
      excluded.push({ view: observation.view, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let mask: DecodedMask | null = null;
    try {
      if (observation.mask) {
        validateMask(observation.mask);
        if (hasForeground(observation.mask)) mask = observation.mask;
      }
      if (!mask && observation.bboxNormalized) {
        mask = maskFromBox(observation.bboxNormalized);
        bboxFallbackViews.push(observation.view);
      }
    } catch (error) {
      excluded.push({ view: observation.view, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!mask) {
      excluded.push({ view: observation.view, reason: "no foreground mask or bbox" });
      continue;
    }
    states.push({ view: observation.view, snapshot: observation.snapshot, mask, samples: [], rawHits: 0 });
  }

  // ---- Stage A: sparse mask-constrained raycasts
  const cast = input.cast ?? createSplatCaster(splat);
  const hitPoints: SnapshotVector3[] = [];
  const hitOwner: Array<{ state: ViewState; sample: DepthSample }> = [];
  for (const state of states) {
    const { snapshot } = state;
    for (const { u, v } of sampleMaskInterior(state.mask, options.raysPerView)) {
      const ray = generateSnapshotRay(snapshot, u, v, worldGeneration);
      const hit = cast(ray.origin, ray.direction)[0];
      if (!hit) continue;
      const view = apply(snapshot.camera.inverseWorldMatrix, hit.point.x, hit.point.y, hit.point.z);
      const depth = -view[2];
      if (!(depth > 0) || !Number.isFinite(depth)) continue;
      state.rawHits++;
      hitPoints.push(hit.point);
      hitOwner.push({ state, sample: { u, v, depth } });
    }
  }

  const sparseHitsPerView: Partial<Record<LiftView, number>> = {};
  for (const state of states) sparseHitsPerView[state.view] = state.rawHits;

  const keep = inlierMask(hitPoints);
  const inliers: THREE.Vector3[] = [];
  keep.forEach((ok, i) => {
    if (!ok) return;
    inliers.push(new THREE.Vector3(hitPoints[i].x, hitPoints[i].y, hitPoints[i].z));
    hitOwner[i].state.samples.push(hitOwner[i].sample);
  });
  const outlierHitsRemoved = hitPoints.length - inliers.length;
  const voting = states.filter((s) => s.samples.length > 0);
  for (const state of states) {
    if (state.samples.length === 0) excluded.push({ view: state.view, reason: "no splat surface hits inside the mask" });
  }

  const finish = (
    indices: Uint32Array,
    obb: OBBFitResult | null,
    extra: Partial<MultiViewLiftDiagnostics>,
  ): MultiViewLiftResult => ({
    indices,
    obb,
    diagnostics: {
      viewsUsed: voting.map((s) => s.view),
      excludedViews: excluded,
      sparseHitsPerView,
      bboxFallbackViews,
      outlierHitsRemoved,
      surfacePointCount: inliers.length,
      searchVolume: null,
      scannedCount: 0,
      candidateCount: 0,
      acceptedCount: indices.length,
      rejectedBackgroundCount: 0,
      rejectedInsufficientVotesCount: 0,
      abstainedOccludedCount: 0,
      durationMs: performance.now() - start,
      ...extra,
    },
  });

  if (voting.length === 0 || inliers.length === 0) return finish(new Uint32Array(0), null, {});

  const box = new THREE.Box3().setFromPoints(inliers);
  const size = box.getSize(new THREE.Vector3());
  const pad = Math.max(options.bboxPaddingRatio * Math.max(size.x, size.y, size.z), 1e-6);
  box.expandByScalar(pad);
  const searchVolume = {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
  };

  // ---- Stage A (cont.): one scan of Gaussian centres inside the padded AABB
  splat.updateWorldMatrix(true, false);
  const world = splat.matrixWorld;
  const centre = new THREE.Vector3();
  const candidateIndex: number[] = [];
  const candidatePos: number[] = [];
  let scannedCount = 0;
  splat.forEachSplat((index, center, _scales, _quaternion, opacity) => {
    scannedCount++;
    // Spark reuses callback objects between invocations: copy immediately.
    centre.copy(center).applyMatrix4(world);
    const alpha = opacity;
    if (!Number.isSafeInteger(index) || index < 0 || index >= numSplats) return;
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isFinite(centre.z)) return;
    if (!(alpha >= options.minOpacity)) return;
    if (!box.containsPoint(centre)) return;
    candidateIndex.push(index);
    candidatePos.push(centre.x, centre.y, centre.z);
  });

  // ---- Stage B: projective mask + occlusion consensus
  const accepted: number[] = [];
  let rejectedBackground = 0;
  let rejectedInsufficient = 0;
  let abstainedOccluded = 0;
  for (let c = 0; c < candidateIndex.length; c++) {
    const x = candidatePos[c * 3];
    const y = candidatePos[c * 3 + 1];
    const z = candidatePos[c * 3 + 2];
    let positive = 0;
    let penalties = 0;
    let occluded = false;
    for (const state of voting) {
      const { camera } = state.snapshot;
      const viewPoint = apply(camera.inverseWorldMatrix, x, y, z);
      const clip = apply(camera.projectionMatrix, viewPoint[0], viewPoint[1], viewPoint[2]);
      if (!(clip[3] > 0)) continue; // behind the camera: this view cannot judge it
      const u = 0.5 + (clip[0] / clip[3]) * 0.5;
      const v = 0.5 - (clip[1] / clip[3]) * 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue; // outside the frame: abstain
      const depth = -viewPoint[2];

      let nearest = state.samples[0];
      let best = Infinity;
      for (const sample of state.samples) {
        const d = (sample.u - u) ** 2 + (sample.v - v) ** 2;
        if (d < best) {
          best = d;
          nearest = sample;
        }
      }
      if (depth - nearest.depth > options.depthToleranceSceneUnits) {
        occluded = true; // behind this view's visible surface: abstain
        continue;
      }
      if (maskAt(state.mask, u, v)) positive++;
      else penalties++;
    }
    if (occluded) abstainedOccluded++;
    if (penalties > 0) rejectedBackground++;
    else if (positive < options.minPositiveVotes) rejectedInsufficient++;
    else accepted.push(candidateIndex[c]);
  }

  accepted.sort((a, b) => a - b);
  const indices = Uint32Array.from(new Set(accepted));
  return finish(indices, fitOBB(inliers), {
    searchVolume,
    scannedCount,
    candidateCount: candidateIndex.length,
    rejectedBackgroundCount: rejectedBackground,
    rejectedInsufficientVotesCount: rejectedInsufficient,
    abstainedOccludedCount: abstainedOccluded,
  });
}
