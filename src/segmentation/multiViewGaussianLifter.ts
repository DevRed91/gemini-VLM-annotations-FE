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

/** One peer object's observation in one of the same frozen capture views. */
export interface PeerViewObservation extends ViewObservation {
  readonly objectId: string;
}

export interface MultiViewLiftOptions {
  /** Max mask-constrained probe rays per view (target and each peer). Default 40. Each ray costs ~35 ms on a large splat. */
  raysPerView?: number;
  /** Search-volume padding as a fraction of the largest surface-hit extent. Default 0.15. */
  bboxPaddingRatio?: number;
  /** Inclusive minimum Gaussian opacity for candidacy. Default 0.05. */
  minOpacity?: number;
  /** A Gaussian more than this (scene units, along the view axis) behind the visible surface abstains. Default 0.25. */
  depthToleranceSceneUnits?: number;
  /**
   * Inset each side of a rectangular box mask (target and peers) before Stage A sampling. Default 0.025:
   * a larger inset leaves the rim of a wide flat surface (tabletop corners) without nearby probes.
   */
  boxInsetRatio?: number;
  /** Estimate per-view tolerance from Stage A depth IQR; zero-variance samples use depthToleranceSceneUnits. Default true. */
  useAdaptiveDepthTolerance?: boolean;
  /** Peer must be nearer by more than this scene-unit margin to own a candidate. Default 0. */
  peerOwnershipMargin?: number;
  /** Positive (foreground, unoccluded) votes required. Default 1. */
  minPositiveVotes?: number;
  /**
   * A peer whose mask has IoU >= this with the target's mask in every shared view is treated as a duplicate
   * or parent label ("table" vs "dining table") and ignored. One-sided containment is deliberately not used:
   * a tissue box on a table is fully contained in the table's mask and must stay a competing peer. Default 0.7.
   */
  duplicatePeerIoU?: number;
  /**
   * A view's peers may claim at most this fraction of that view's Stage A target hits; the claims with the
   * weakest depth advantage are returned to the target. 1 disables the cap. Default 0.85.
   */
  maxPeerHitConsumptionRatio?: number;
  /**
   * Nearest-sample surface lookups ignore samples farther than this many mean sample spacings in UV
   * (spacing = sqrt(mask area / raysPerView)), so sparse rays cannot match across gaps. Default 5, wide
   * enough that the outer rim of a box-masked surface still resolves a local surface depth.
   */
  uvLookupSpacingFactor?: number;
  /**
   * Fit the upright OBB to the densest horizontal layer only. Off by default: it collapses multi-part
   * objects (sofa seat + backrest, shelving) to a slab. Default false.
   */
  dominantLayer?: boolean;
}

export interface MultiViewLiftInput {
  readonly splat: SplatMesh;
  /** Current world generation of the viewer; snapshots from any other generation are excluded. */
  readonly worldGeneration: number;
  readonly views: readonly ViewObservation[];
  /** Sibling detections from the same Gemini response, mapped to the same captures. */
  readonly peerObjects?: readonly PeerViewObservation[];
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
  /** Candidate centers owned by a nearer/closer peer object's surface. */
  readonly rejectedPeerCount: number;
  /** Candidate primitives above the robust scene-relative scale fence (upper-slab primitives are exempt). */
  readonly rejectedScaleCount: number;
  /** Wide flat primitives at the bottom of the search box, below a distinct upper support slab (floor under a table). */
  readonly rejectedFloorCount: number;
  /** Thin horizontal primitives on the upper support slab spared from the scale fence that it would otherwise have rejected. */
  readonly slabScaleExemptCount: number;
  /** Estimated upper horizontal support plane (75th-percentile Stage A hit Y), or null with no hits. */
  readonly upperSurfaceY: number | null;
  /** Lowest Stage A inlier hit Y, or null with no hits. */
  readonly minHitY: number | null;
  /** Target Stage A hits removed because a peer surface was nearer or co-surface in the same view. */
  readonly peerSurfaceHitsRemoved: number;
  /** Peer views skipped for invisibility, stale snapshots, or unusable masks. */
  readonly excludedPeerViews: number;
  /** Peer object ids ignored as duplicate/parent labels of the target (mask IoU >= duplicatePeerIoU in every shared view). */
  readonly duplicatePeerIds: readonly string[];
  /** Views where the peer-consumption cap returned some peer-claimed hits to the target. */
  readonly peerOwnershipCappedViews: readonly LiftView[];
  /** Effective per-view Stage B depth thresholds (scene units). */
  readonly depthToleranceByView: Readonly<Partial<Record<LiftView, number>>>;
  /** Candidates (not already background-rejected) that ended below minPositiveVotes. */
  readonly rejectedInsufficientVotesCount: number;
  /** Candidates for which at least one view abstained because the Gaussian lies behind a target or peer surface. */
  readonly abstainedOccludedCount: number;
  readonly durationMs: number;
}

export interface MultiViewLiftResult {
  /** Ascending, unique storage indices into the non-LOD splat. */
  readonly indices: Uint32Array;
  /** OBB fitted to the fused visible-surface hits (hidden back sides are not sampled), or null with no hits. */
  readonly obb: OBBFitResult | null;
  /** Inlier surface hits used to fit `obb`; retained for a point-only annotation fallback. */
  readonly surfacePoints: readonly SnapshotVector3[];
  readonly diagnostics: MultiViewLiftDiagnostics;
}

interface ResolvedOptions {
  raysPerView: number;
  bboxPaddingRatio: number;
  minOpacity: number;
  depthToleranceSceneUnits: number;
  boxInsetRatio: number;
  useAdaptiveDepthTolerance: boolean;
  peerOwnershipMargin: number;
  minPositiveVotes: number;
  duplicatePeerIoU: number;
  maxPeerHitConsumptionRatio: number;
  uvLookupSpacingFactor: number;
  dominantLayer: boolean;
}

function resolveOptions(options: MultiViewLiftOptions = {}): ResolvedOptions {
  const resolved = {
    raysPerView: options.raysPerView ?? 40,
    bboxPaddingRatio: options.bboxPaddingRatio ?? 0.15,
    minOpacity: options.minOpacity ?? 0.05,
    depthToleranceSceneUnits: options.depthToleranceSceneUnits ?? 0.25,
    boxInsetRatio: options.boxInsetRatio ?? 0.025,
    useAdaptiveDepthTolerance: options.useAdaptiveDepthTolerance ?? true,
    peerOwnershipMargin: options.peerOwnershipMargin ?? 0,
    minPositiveVotes: options.minPositiveVotes ?? 1,
    duplicatePeerIoU: options.duplicatePeerIoU ?? 0.7,
    maxPeerHitConsumptionRatio: options.maxPeerHitConsumptionRatio ?? 0.85,
    uvLookupSpacingFactor: options.uvLookupSpacingFactor ?? 5,
    dominantLayer: options.dominantLayer ?? false,
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
  if (!Number.isFinite(resolved.boxInsetRatio) || resolved.boxInsetRatio < 0 || resolved.boxInsetRatio >= 0.5) {
    throw new RangeError("boxInsetRatio must be finite and in [0, 0.5)");
  }
  if (typeof resolved.useAdaptiveDepthTolerance !== "boolean") {
    throw new TypeError("useAdaptiveDepthTolerance must be a boolean");
  }
  if (!Number.isFinite(resolved.peerOwnershipMargin) || resolved.peerOwnershipMargin < 0) {
    throw new RangeError("peerOwnershipMargin must be finite and non-negative");
  }
  if (!Number.isInteger(resolved.minPositiveVotes) || resolved.minPositiveVotes < 1) {
    throw new RangeError("minPositiveVotes must be a positive integer");
  }
  if (!Number.isFinite(resolved.duplicatePeerIoU) || resolved.duplicatePeerIoU <= 0 || resolved.duplicatePeerIoU > 1) {
    throw new RangeError("duplicatePeerIoU must be finite and in (0, 1]");
  }
  if (!Number.isFinite(resolved.maxPeerHitConsumptionRatio) || resolved.maxPeerHitConsumptionRatio < 0 || resolved.maxPeerHitConsumptionRatio > 1) {
    throw new RangeError("maxPeerHitConsumptionRatio must be finite and in [0, 1]");
  }
  if (!Number.isFinite(resolved.uvLookupSpacingFactor) || resolved.uvLookupSpacingFactor <= 0) {
    throw new RangeError("uvLookupSpacingFactor must be finite and positive");
  }
  if (typeof resolved.dominantLayer !== "boolean") throw new TypeError("dominantLayer must be a boolean");
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
function maskFromBox(box: readonly number[], insetRatio = 0): DecodedMask {
  if (box.length !== 4 || !box.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || !(box[0] < box[2]) || !(box[1] < box[3])) {
    throw new RangeError("bboxNormalized must be [ymin, xmin, ymax, xmax] fractions with min < max");
  }
  const n = BBOX_MASK_RESOLUTION;
  const data = new Uint8Array(n * n);
  const [rawYMin, rawXMin, rawYMax, rawXMax] = box;
  const insetX = (rawXMax - rawXMin) * insetRatio;
  const insetY = (rawYMax - rawYMin) * insetRatio;
  const ymin = rawYMin + insetY;
  const xmin = rawXMin + insetX;
  const ymax = rawYMax - insetY;
  const xmax = rawXMax - insetX;
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
  readonly point: SnapshotVector3;
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
  /** Mean UV spacing of this view's successful Stage A hits: sqrt(mask area / hits). Set after sampling. */
  spacing: number;
  /** Max UV distance for nearest-sample surface lookups (see `uvLookupSpacingFactor`). Set after sampling. */
  lookupRadius: number;
  /** Foreground area as a fraction of the image. */
  readonly areaFraction: number;
  /** Stage A hits that ended up claimed by a peer (after the consumption cap). */
  peerOwnedRemoved: number;
}

interface PeerState extends ViewState {
  readonly objectId: string;
}

interface GaussianCandidate {
  readonly index: number;
  readonly center: SnapshotVector3;
  readonly covarianceWorld: readonly number[];
  /** Longest transformed one-sigma axis, in world units. */
  readonly maxScale: number;
  /** One-sigma extent along world +Y. */
  readonly verticalScale: number;
  /** Largest one-sigma extent within the world XZ plane. */
  readonly horizontalScale: number;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
}

/**
 * Per-view Stage B depth tolerance, scene units:
 *   max(sceneNoiseFloor, 0.5 * IQR + localGradientAllowance)
 * - IQR is the spread of Stage A hit depths. A sloped surface (tabletop seen from
 *   a low angle) legitimately spans depth, and a nearest-sample surface lookup is
 *   off by a large fraction of that spread, so half the IQR is allowed.
 * - localGradientAllowance = median nearest-neighbour depth slope (depth per UV)
 *   times the probe spacing, capped at the IQR: the extra error a lookup makes
 *   when the nearest probe is a spacing away on a steep surface.
 * - sceneNoiseFloor = max(1e-4, 0.5% of the median depth, 2% of the hit extent):
 *   ray jitter that scales with how far away and how big the scene is. The lifter
 *   additionally floors the result at 2.5x the median candidate primitive size.
 * When the spread is within that floor the hits are effectively flat, which says
 * nothing about primitive thickness, so the configured `fallback` is used.
 */
function adaptiveDepthTolerance(samples: readonly DepthSample[], fallback: number, spacing: number): number {
  const depths = samples.map((sample) => sample.depth);
  const centerDepth = median(depths);
  let extent = 0;
  for (const a of samples) for (const b of samples) extent = Math.max(extent, distance3(a.point, b.point));
  const noiseFloor = Math.max(1e-4, centerDepth * 0.005, extent * 0.02);
  const iqr = quantile(depths, 0.75) - quantile(depths, 0.25);
  if (iqr <= noiseFloor) return fallback;
  const slopes: number[] = [];
  for (const a of samples) {
    let best = Infinity;
    let slope = 0;
    for (const b of samples) {
      if (a === b) continue;
      const d = Math.hypot(a.u - b.u, a.v - b.v);
      if (d > 0 && d < best) {
        best = d;
        slope = Math.abs(a.depth - b.depth) / d;
      }
    }
    if (best < Infinity) slopes.push(slope);
  }
  const gradientAllowance = slopes.length > 0 ? Math.min(iqr, median(slopes) * spacing) : 0;
  return Math.max(noiseFloor, 0.5 * iqr + gradientAllowance);
}

/** Nearest Stage A sample in UV, or null when none lies within `maxUvDistance` (no local surface to judge by). */
function sampleNearest(samples: readonly DepthSample[], u: number, v: number, maxUvDistance: number): DepthSample | null {
  let nearest: DepthSample | null = null;
  let best = maxUvDistance * maxUvDistance;
  for (const sample of samples) {
    const distance = (sample.u - u) ** 2 + (sample.v - v) ** 2;
    if (distance <= best) {
      best = distance;
      nearest = sample;
    }
  }
  return nearest;
}

/**
 * Front-most Stage A sample within `maxUvDistance`, or null. Used for a peer's local surface: its mask
 * also contains background seen through gaps (chair legs, openings), so the UV-nearest hit can be a far
 * background hit; the peer's visible surface is the nearest layer in the neighbourhood.
 */
function sampleFrontMost(samples: readonly DepthSample[], u: number, v: number, maxUvDistance: number): DepthSample | null {
  let front: DepthSample | null = null;
  const limit = maxUvDistance * maxUvDistance;
  for (const sample of samples) {
    if ((sample.u - u) ** 2 + (sample.v - v) ** 2 > limit) continue;
    if (!front || sample.depth < front.depth) front = sample;
  }
  return front;
}

/**
 * Multiples of the median candidate primitive size granted as depth slack (see Stage B tolerance floor).
 * 2.5 rather than ~1 radius: on a surface seen at a grazing angle the nearest-sample lookup is off by
 * several primitive radii along the view axis, and a tighter floor makes those views abstain.
 */
const PRIMITIVE_DEPTH_SLACK = 2.5;

// Support-slab heuristics. All distances are fractions of the largest Stage A hit extent so they track scene scale.
/** Half-thickness of the "on the upper support plane" band. */
const SLAB_TOLERANCE_FRACTION = 0.04;
/** A primitive is flat/horizontal when its vertical sigma is at most this fraction of its horizontal sigma. */
const FLAT_PRIMITIVE_RATIO = 0.35;
/** Slab primitives may be this fraction of the horizontal hit extent wide (the normal fence stops at 0.25 of the extent). */
const SLAB_MAX_HORIZONTAL_SCALE_FRACTION = 0.5;
/** Height above the lowest hit that counts as "the floor band". */
const FLOOR_MARGIN_FRACTION = 0.05;
/** The floor band is only filtered when the upper slab sits at least this many floor margins above the lowest hit. */
const FLOOR_SEPARATION_MARGINS = 3;
/** Flat primitives wider than this fraction of the hit extent are "wide" for floor rejection. */
const FLOOR_WIDE_EXTENT_FRACTION = 0.04;

const OVERLAP_GRID = 64;

/** Foreground IoU of two masks compared on a common normalized grid (resolutions may differ). */
function maskIoU(a: DecodedMask, b: DecodedMask): number {
  let intersection = 0;
  let union = 0;
  for (let y = 0; y < OVERLAP_GRID; y++) {
    const v = (y + 0.5) / OVERLAP_GRID;
    for (let x = 0; x < OVERLAP_GRID; x++) {
      const u = (x + 0.5) / OVERLAP_GRID;
      const inA = maskAt(a, u, v);
      const inB = maskAt(b, u, v);
      if (inA && inB) intersection++;
      if (inA || inB) union++;
    }
  }
  return union === 0 ? 0 : intersection / union;
}

function maskAreaFraction(mask: DecodedMask): number {
  let count = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] === 1) count++;
  return count / mask.data.length;
}

function makeViewState(
  view: LiftView,
  snapshot: ViewSnapshot,
  mask: DecodedMask,
  options: ResolvedOptions,
): ViewState {
  const areaFraction = maskAreaFraction(mask);
  const spacing = Math.sqrt(areaFraction / options.raysPerView);
  return {
    view,
    snapshot,
    mask,
    samples: [],
    rawHits: 0,
    areaFraction,
    spacing,
    lookupRadius: spacing * options.uvLookupSpacingFactor,
    peerOwnedRemoved: 0,
  };
}

/** Real hit density, not probe density: rays that miss the splat leave gaps the lookup must not bridge. */
function finalizeSpacing(state: ViewState, options: ResolvedOptions): void {
  state.spacing = Math.sqrt(state.areaFraction / Math.max(1, state.rawHits));
  state.lookupRadius = state.spacing * options.uvLookupSpacingFactor;
}

function distanceSq3(a: SnapshotVector3, b: SnapshotVector3): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function distance3(a: SnapshotVector3, b: SnapshotVector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** World covariance = L R diag(scale²) Rᵀ Lᵀ (row-major 3x3). */
function gaussianWorldCovariance(
  scales: THREE.Vector3,
  quaternion: THREE.Quaternion,
  world: THREE.Matrix4,
): { covariance: number[]; maxScale: number } {
  const q = quaternion;
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  const e = world.elements;
  const linear = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  const axes = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) axes[r * 3 + c] += linear[r * 3 + k] * rotation[k * 3 + c];
  }
  const size = [Math.abs(scales.x), Math.abs(scales.y), Math.abs(scales.z)];
  const covariance = new Array<number>(9).fill(0);
  let maxScale = 0;
  for (let c = 0; c < 3; c++) {
    let axisLength = 0;
    for (let r = 0; r < 3; r++) axisLength += axes[r * 3 + c] ** 2;
    maxScale = Math.max(maxScale, Math.sqrt(axisLength) * size[c]);
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      covariance[r * 3 + k] += axes[r * 3 + c] * axes[k * 3 + c] * size[c] ** 2;
    }
  }
  return { covariance, maxScale };
}

/** One-sigma extents of a row-major world covariance along +Y and within the XZ plane. */
function verticalHorizontalSigma(covariance: readonly number[]): { vertical: number; horizontal: number } {
  const xx = covariance[0], xz = covariance[2], zz = covariance[8];
  const mean = (xx + zz) / 2;
  const largest = mean + Math.sqrt(((xx - zz) / 2) ** 2 + xz * xz);
  return { vertical: Math.sqrt(Math.max(0, covariance[4])), horizontal: Math.sqrt(Math.max(0, largest)) };
}

function transformCovariance(covariance: readonly number[], matrix: readonly number[]): number[] {
  const linear = [matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9], matrix[2], matrix[6], matrix[10]];
  const first = new Array<number>(9).fill(0);
  const result = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) first[r * 3 + c] += linear[r * 3 + k] * covariance[k * 3 + c];
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 3; k++) result[r * 3 + c] += first[r * 3 + k] * linear[c * 3 + k];
  }
  return result;
}

/** Approximate normalized-image one-sigma footprint using the perspective Jacobian. */
function projectedSigma(
  state: ViewState,
  covarianceWorld: readonly number[],
  clip: readonly [number, number, number, number],
): { u: number; v: number } {
  const covarianceView = transformCovariance(covarianceWorld, state.snapshot.camera.inverseWorldMatrix);
  const [x, y, , w] = clip;
  if (!(w > 0)) return { u: 0, v: 0 };
  const p = state.snapshot.camera.projectionMatrix;
  const jU = [
    0.5 * (p[0] * w - x * p[3]) / (w * w),
    0.5 * (p[4] * w - x * p[7]) / (w * w),
    0.5 * (p[8] * w - x * p[11]) / (w * w),
  ];
  const jV = [
    -0.5 * (p[1] * w - y * p[3]) / (w * w),
    -0.5 * (p[5] * w - y * p[7]) / (w * w),
    -0.5 * (p[9] * w - y * p[11]) / (w * w),
  ];
  const variance = (j: number[]) => {
    let total = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) total += j[r] * covarianceView[r * 3 + c] * j[c];
    return Math.max(0, total);
  };
  return { u: Math.sqrt(variance(jU)), v: Math.sqrt(variance(jV)) };
}

/** Fraction of a small deterministic Gaussian footprint that falls on foreground. */
function maskCoverage(mask: DecodedMask, u: number, v: number, sigmaU: number, sigmaV: number): number {
  const offsets: readonly [number, number][] = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.7, 0.7], [0.7, -0.7], [-0.7, 0.7], [-0.7, -0.7],
  ];
  let foreground = 0;
  for (const [du, dv] of offsets) {
    if (maskAt(mask, u + du * sigmaU, v + dv * sigmaV)) foreground++;
  }
  return foreground / offsets.length;
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
  const peerStates: PeerState[] = [];
  let excludedPeerViews = 0;

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
        mask = maskFromBox(observation.bboxNormalized, options.boxInsetRatio);
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
    states.push(makeViewState(observation.view, observation.snapshot, mask, options));
  }

  const seenPeerViews = new Set<string>();
  for (const observation of input.peerObjects ?? []) {
    const key = `${observation.objectId}\u0000${observation.view}`;
    if (!observation.objectId || seenPeerViews.has(key)) {
      excludedPeerViews++;
      continue;
    }
    seenPeerViews.add(key);
    if (!observation.visible) {
      excludedPeerViews++;
      continue;
    }
    try {
      assertCaptureCurrent(observation.snapshot, live);
    } catch {
      excludedPeerViews++;
      continue;
    }
    const matchingTarget = states.find((state) => state.view === observation.view);
    if (!matchingTarget || matchingTarget.snapshot.id !== observation.snapshot.id) {
      excludedPeerViews++;
      continue;
    }
    let mask: DecodedMask | null = null;
    try {
      if (observation.mask) {
        validateMask(observation.mask);
        if (hasForeground(observation.mask)) mask = observation.mask;
      }
      if (!mask && observation.bboxNormalized) mask = maskFromBox(observation.bboxNormalized, options.boxInsetRatio);
    } catch {
      excludedPeerViews++;
      continue;
    }
    if (!mask) {
      excludedPeerViews++;
      continue;
    }
    peerStates.push({
      ...makeViewState(observation.view, observation.snapshot, mask, options),
      objectId: observation.objectId,
    });
  }

  // ---- duplicate / parent peer guard: a peer whose mask matches the target's in
  // every shared view is the same object under another label; it must not claim
  // the target's own surface.
  const duplicatePeerIds: string[] = [];
  {
    const byObject = new Map<string, PeerState[]>();
    for (const peer of peerStates) byObject.set(peer.objectId, [...(byObject.get(peer.objectId) ?? []), peer]);
    for (const [objectId, group] of byObject) {
      const isDuplicate = group.every((peer) => {
        const target = states.find((state) => state.view === peer.view)!;
        return maskIoU(target.mask, peer.mask) >= options.duplicatePeerIoU;
      });
      if (isDuplicate) duplicatePeerIds.push(objectId);
    }
    if (duplicatePeerIds.length > 0) {
      const skip = new Set(duplicatePeerIds);
      for (let i = peerStates.length - 1; i >= 0; i--) if (skip.has(peerStates[i].objectId)) peerStates.splice(i, 1);
    }
  }

  // ---- Stage A: sparse mask-constrained raycasts
  const cast = input.cast ?? createSplatCaster(splat);
  const hitOwner: Array<{ state: ViewState; sample: DepthSample }> = [];
  const sampleState = (state: ViewState) => {
    const { snapshot } = state;
    for (const { u, v } of sampleMaskInterior(state.mask, options.raysPerView)) {
      const ray = generateSnapshotRay(snapshot, u, v, worldGeneration);
      const hit = cast(ray.origin, ray.direction)[0];
      if (!hit) continue;
      const view = apply(snapshot.camera.inverseWorldMatrix, hit.point.x, hit.point.y, hit.point.z);
      const depth = -view[2];
      if (!(depth > 0) || !Number.isFinite(depth)) continue;
      state.rawHits++;
      const point = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
      const sample = { u, v, depth, point };
      if ("objectId" in state) state.samples.push(sample);
      else {
        hitOwner.push({ state, sample });
      }
    }
  };
  for (const state of states) sampleState(state);
  for (const state of peerStates) sampleState(state);
  for (const state of [...states, ...peerStates]) finalizeSpacing(state, options);

  // A target-box ray that lands on a peer's nearer visible surface is not a
  // target surface sample and must not inflate either the search AABB or OBB.
  // Returns the peer's depth advantage (>= 0) when a peer owns the hit, else null.
  const peerAdvantage = (state: ViewState, sample: DepthSample): number | null => {
    for (const peer of peerStates) {
      if (peer.view !== state.view || peer.samples.length === 0 || !maskAt(peer.mask, sample.u, sample.v)) continue;
      const peerSample = sampleFrontMost(peer.samples, sample.u, sample.v, peer.lookupRadius);
      if (!peerSample) continue;
      // A target hit within the scene noise floor of the peer's local surface
      // (same depth layer, in either direction) is ambiguous and goes to the peer:
      // two rays on one splat surface differ by sub-splat depth jitter. Beyond
      // that, the peer must be strictly nearer. Target hits clearly nearer than
      // the peer stay with the target.
      const tieTolerance = Math.max(options.peerOwnershipMargin, 1e-4, sample.depth * 0.005);
      const advantage = sample.depth - peerSample.depth;
      if (Math.abs(advantage) <= tieTolerance) return 0;
      if (advantage > options.peerOwnershipMargin) return advantage;
    }
    return null;
  };
  const peerOwned = new Set<{ state: ViewState; sample: DepthSample }>();
  const peerOwnershipCappedViews: LiftView[] = [];
  for (const state of states) {
    const hits = hitOwner.filter((hit) => hit.state === state);
    const owned = hits
      .map((hit) => ({ hit, advantage: peerAdvantage(state, hit.sample) }))
      .filter((entry): entry is { hit: typeof entry.hit; advantage: number } => entry.advantage !== null);
    // Peers may not consume more than the cap of this view's hits; return the
    // claims with the weakest depth advantage (most likely noise) to the target.
    const allowed = Math.floor(options.maxPeerHitConsumptionRatio * hits.length);
    if (owned.length > allowed) {
      owned.sort((x, y) => x.advantage - y.advantage);
      owned.splice(0, owned.length - allowed);
      peerOwnershipCappedViews.push(state.view);
    }
    for (const entry of owned) peerOwned.add(entry.hit);
    state.peerOwnedRemoved = owned.length;
  }
  const eligibleHitPoints: SnapshotVector3[] = [];
  const eligibleHitOwner: Array<{ state: ViewState; sample: DepthSample }> = [];
  for (const hit of hitOwner) {
    if (peerOwned.has(hit)) continue;
    eligibleHitPoints.push(hit.sample.point);
    eligibleHitOwner.push(hit);
  }

  const sparseHitsPerView: Partial<Record<LiftView, number>> = {};
  for (const state of states) sparseHitsPerView[state.view] = state.rawHits;

  const keep = inlierMask(eligibleHitPoints);
  const inliers: THREE.Vector3[] = [];
  keep.forEach((ok, i) => {
    if (!ok) return;
    inliers.push(new THREE.Vector3(eligibleHitPoints[i].x, eligibleHitPoints[i].y, eligibleHitPoints[i].z));
    eligibleHitOwner[i].state.samples.push(eligibleHitOwner[i].sample);
  });
  const peerSurfaceHitsRemoved = hitOwner.length - eligibleHitPoints.length;
  const outlierHitsRemoved = eligibleHitPoints.length - inliers.length;
  const voting = states.filter((s) => s.samples.length > 0);
  const depthToleranceByView: Partial<Record<LiftView, number>> = {};
  for (const state of voting) {
    depthToleranceByView[state.view] = options.useAdaptiveDepthTolerance
      ? adaptiveDepthTolerance(state.samples, options.depthToleranceSceneUnits, state.spacing)
      : options.depthToleranceSceneUnits;
  }
  for (const state of states) {
    if (state.samples.length === 0) {
      excluded.push({
        view: state.view,
        reason: state.peerOwnedRemoved > 0 && state.peerOwnedRemoved === state.rawHits
          ? "all hits peer-owned"
          : "no splat surface hits inside the mask",
      });
    }
  }

  const finish = (
    indices: Uint32Array,
    obb: OBBFitResult | null,
    extra: Partial<MultiViewLiftDiagnostics>,
  ): MultiViewLiftResult => ({
    indices,
    obb,
    surfacePoints: inliers.map((point) => ({ x: point.x, y: point.y, z: point.z })),
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
      rejectedPeerCount: 0,
      rejectedScaleCount: 0,
      rejectedFloorCount: 0,
      slabScaleExemptCount: 0,
      upperSurfaceY: null,
      minHitY: null,
      peerSurfaceHitsRemoved,
      excludedPeerViews,
      duplicatePeerIds,
      peerOwnershipCappedViews,
      depthToleranceByView,
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
  const candidates: GaussianCandidate[] = [];
  let scannedCount = 0;
  splat.forEachSplat((index, center, scales, quaternion, opacity) => {
    scannedCount++;
    // Spark reuses callback objects between invocations: copy immediately.
    centre.copy(center).applyMatrix4(world);
    const alpha = opacity;
    if (!Number.isSafeInteger(index) || index < 0 || index >= numSplats) return;
    if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y) || !Number.isFinite(centre.z)) return;
    if (!(alpha >= options.minOpacity)) return;
    if (!box.containsPoint(centre)) return;
    // Cheap rejects are done: only now pay for copying the reused callback objects.
    const scale = scales.clone();
    const orientation = quaternion.clone();
    if (![scale.x, scale.y, scale.z, orientation.x, orientation.y, orientation.z, orientation.w].every(Number.isFinite)) return;
    const primitive = gaussianWorldCovariance(scale, orientation, world);
    if (!Number.isFinite(primitive.maxScale)) return;
    const sigma = verticalHorizontalSigma(primitive.covariance);
    candidates.push({
      index,
      center: { x: centre.x, y: centre.y, z: centre.z },
      covarianceWorld: primitive.covariance,
      maxScale: primitive.maxScale,
      verticalScale: sigma.vertical,
      horizontalScale: sigma.horizontal,
    });
  });

  // Support-slab geometry from the Stage A inlier hits. The upper support plane
  // is the 75th-percentile hit height: a tabletop is seen by the top view and by
  // the low band of every oblique view, so it holds the upper quartile even
  // when many oblique rays land on legs or floor beneath it.
  const hitYs = inliers.map((point) => point.y);
  const upperSurfaceY = quantile(hitYs, 0.75);
  const minHitY = Math.min(...hitYs);
  const maxExtent = Math.max(size.x, size.y, size.z);
  const slabTolerance = SLAB_TOLERANCE_FRACTION * maxExtent;
  const floorMargin = FLOOR_MARGIN_FRACTION * maxExtent;
  const onUpperSlab = (y: number) => Math.abs(y - upperSurfaceY) <= slabTolerance;
  const isFlat = (candidate: GaussianCandidate) =>
    candidate.verticalScale <= FLAT_PRIMITIVE_RATIO * candidate.horizontalScale;
  // Only when the slab is clearly above the lowest hit is there a "below the
  // slab" floor band to clean; an object that sits on the floor itself (rug,
  // mat) has no separation and its own wide flat splats must survive.
  const filterFloorBand = upperSurfaceY - minHitY >= FLOOR_SEPARATION_MARGINS * floorMargin;
  const floorWideScale = FLOOR_WIDE_EXTENT_FRACTION * maxExtent;
  const isGrazingFloorSplat = (candidate: GaussianCandidate) =>
    filterFloorBand && candidate.center.y <= minHitY + floorMargin &&
    isFlat(candidate) && candidate.horizontalScale > floorWideScale;
  const slabMaxHorizontalScale = SLAB_MAX_HORIZONTAL_SCALE_FRACTION * Math.max(size.x, size.z);
  const isUpperSlabPrimitive = (candidate: GaussianCandidate) =>
    onUpperSlab(candidate.center.y) && isFlat(candidate) && candidate.horizontalScale <= slabMaxHorizontalScale;

  // Wide grazing floor splats under the object are removed first so they cannot
  // inflate the scale distribution that the fence below is derived from.
  const floorRejected = candidates.filter(isGrazingFloorSplat);
  const rejectedFloor = floorRejected.length;
  const floorRejectedSet = new Set(floorRejected);
  const floorKept = rejectedFloor === 0 ? candidates : candidates.filter((candidate) => !floorRejectedSet.has(candidate));

  // A robust candidate-relative upper fence removes exceptionally broad floor
  // and wall primitives. The object-relative floor avoids rejecting a valid
  // anisotropic surface splat solely because its long in-plane axes exceed the
  // compact bulk distribution. Thin horizontal primitives on the upper support
  // slab are exempt (up to half the horizontal hit extent): low-texture white
  // tabletops are reconstructed with a few very wide flat ellipsoids that the
  // fence would otherwise prune, leaving holes in the surface.
  const scaleQ1 = quantile(floorKept.map((candidate) => candidate.maxScale), 0.25);
  const scaleQ3 = quantile(floorKept.map((candidate) => candidate.maxScale), 0.75);
  const scaleIqr = scaleQ3 - scaleQ1;
  const scaleFence = Math.max(
    scaleQ3 + 3 * Math.max(scaleIqr, scaleQ3 * 0.25, 1e-6),
    maxExtent * 0.25,
  );
  let slabScaleExempt = 0;
  const scaleEligible = floorKept.filter((candidate) => {
    if (candidate.maxScale <= scaleFence) return true;
    if (!isUpperSlabPrimitive(candidate)) return false;
    slabScaleExempt++;
    return true;
  });
  const rejectedScale = floorKept.length - scaleEligible.length;
  // Primitive-thickness floor for the adaptive tolerance: a Gaussian's centre can sit
  // about one primitive radius behind the surface its own probe ray reported, so a
  // tolerance below the typical primitive size would call every surface splat
  // "occluded". Applied only to adaptive tolerances (a fixed tolerance is the caller's).
  if (options.useAdaptiveDepthTolerance && scaleEligible.length > 0) {
    const primitiveFloor = PRIMITIVE_DEPTH_SLACK * median(scaleEligible.map((candidate) => candidate.maxScale));
    for (const state of voting) {
      depthToleranceByView[state.view] = Math.max(depthToleranceByView[state.view]!, primitiveFloor);
    }
  }
  const nearestTargetSurfaceDistanceSq = (point: SnapshotVector3): number => {
    let nearest = Infinity;
    for (const surface of inliers) nearest = Math.min(nearest, distanceSq3(point, surface));
    return nearest;
  };
  const peersByView = new Map<LiftView, PeerState[]>();
  const peerCloud = new Map<string, SnapshotVector3[]>();
  for (const peer of peerStates) {
    if (peer.samples.length === 0) continue;
    peerCloud.set(peer.objectId, [...(peerCloud.get(peer.objectId) ?? []), ...peer.samples.map((sample) => sample.point)]);
    peersByView.set(peer.view, [...(peersByView.get(peer.view) ?? []), peer]);
  }
  // Peers whose own surface lies below the upper support plane. Hits on the plane
  // itself are ambiguous (a peer's 2D box overlapping the tabletop collects
  // tabletop hits), so only off-plane hits classify a peer: below-plane hits
  // (seat, legs) must outnumber above-plane hits (a chair back, or a box on the
  // table). A peer with no off-plane hits (a flat placemat) stays an ordinary peer.
  const peersBelowSlab = new Set<string>();
  for (const [objectId, points] of peerCloud) {
    let below = 0;
    let above = 0;
    for (const point of points) {
      if (point.y < upperSurfaceY - slabTolerance) below++;
      else if (point.y > upperSurfaceY + slabTolerance) above++;
    }
    if (below > above) peersBelowSlab.add(objectId);
  }

  // ---- Stage B: projective mask + occlusion + peer-ownership consensus
  const accepted: number[] = [];
  const acceptedCenters: THREE.Vector3[] = [];
  let rejectedBackground = 0;
  let rejectedPeer = 0;
  let rejectedInsufficient = 0;
  let abstainedOccluded = 0;
  for (const candidate of scaleEligible) {
    const { x, y, z } = candidate.center;
    let positive = 0;
    let penalties = 0;
    let peerVotes = 0;
    let occluded = false;
    const candidateOnUpperSlab = onUpperSlab(y);
    // Candidate-to-surface distances are view-independent (target and each peer's
    // surface points pooled over all views): compute each once per candidate, lazily.
    let targetDistanceSq = -1;
    let targetDistance = -1;
    const peerDistanceSq = new Map<string, number>();
    const closerToPeerThanTarget = (objectId: string): boolean => {
      if (targetDistanceSq < 0) {
        targetDistanceSq = nearestTargetSurfaceDistanceSq(candidate.center);
        targetDistance = Math.sqrt(targetDistanceSq);
      }
      let peerSq = peerDistanceSq.get(objectId);
      if (peerSq === undefined) {
        peerSq = Infinity;
        for (const point of peerCloud.get(objectId) ?? []) peerSq = Math.min(peerSq, distanceSq3(candidate.center, point));
        peerDistanceSq.set(objectId, peerSq);
      }
      const margin = options.peerOwnershipMargin;
      return margin === 0 ? peerSq < targetDistanceSq : targetDistance > margin && peerSq < (targetDistance - margin) ** 2;
    };
    for (const state of voting) {
      const { camera } = state.snapshot;
      const viewPoint = apply(camera.inverseWorldMatrix, x, y, z);
      const clip = apply(camera.projectionMatrix, viewPoint[0], viewPoint[1], viewPoint[2]);
      if (!(clip[3] > 0)) continue; // behind the camera: this view cannot judge it
      const u = 0.5 + (clip[0] / clip[3]) * 0.5;
      const v = 0.5 - (clip[1] / clip[3]) * 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue; // outside the frame: abstain
      const depth = -viewPoint[2];
      const tolerance = depthToleranceByView[state.view]!;

      // The candidate's own view-axis depth is compared with the local surface of
      // the target and of each peer at the candidate's pixel.
      const nearest = sampleNearest(state.samples, u, v, state.lookupRadius);
      if (nearest && depth - nearest.depth > tolerance) {
        occluded = true; // behind this view's visible target surface: abstain
        continue;
      }
      const sigma = projectedSigma(state, candidate.covarianceWorld, clip);

      let behindPeer = false;
      let ownedByPeer = false;
      for (const peer of peersByView.get(state.view) ?? []) {
        if (maskCoverage(peer.mask, u, v, sigma.u, sigma.v) < 0.25) continue;
        const peerSurface = sampleFrontMost(peer.samples, u, v, peer.lookupRadius);
        if (!peerSurface) continue;
        // A peer whose surface lies below the upper support plane (a tucked-in chair
        // seat) neither hides nor owns a candidate sitting on that plane, even where
        // the two 2D boxes overlap: the overlap is a projection artefact.
        if (candidateOnUpperSlab && peersBelowSlab.has(peer.objectId)) continue;
        if (depth - peerSurface.depth > tolerance) behindPeer = true; // hidden by the peer in this view
        else if (
          Math.abs(depth - peerSurface.depth) <= tolerance &&
          closerToPeerThanTarget(peer.objectId)
        ) ownedByPeer = true;
      }
      if (behindPeer) {
        occluded = true; // occlusion by a peer is not evidence either way: abstain
        continue;
      }
      if (ownedByPeer) {
        peerVotes++;
        continue;
      }

      const targetCoverage = maskCoverage(state.mask, u, v, sigma.u, sigma.v);
      if (!nearest) {
        // No target probe within the UV cap: visibility cannot be verified, so a
        // foreground landing abstains; a background landing still counts against it.
        if (targetCoverage >= 0.25) continue;
        penalties++;
        continue;
      }
      if (targetCoverage >= 0.25) positive++;
      else penalties++;
    }
    if (occluded) abstainedOccluded++;
    // Peer ownership is decided per view and only wins on a strict majority of
    // the votes cast, so one noisy peer view cannot override the other views.
    if (peerVotes > positive) rejectedPeer++;
    else if (penalties > 0) rejectedBackground++;
    else if (positive < options.minPositiveVotes) rejectedInsufficient++;
    else {
      accepted.push(candidate.index);
      acceptedCenters.push(new THREE.Vector3(x, y, z));
    }
  }

  accepted.sort((a, b) => a - b);
  const indices = Uint32Array.from(new Set(accepted));
  // Fit to the accepted Gaussian centres so the box spans the lifted object, not
  // the inset Stage A probe cloud; fall back to the surface hits with no members.
  const obbPoints = acceptedCenters.length > 0 ? acceptedCenters : inliers;
  return finish(indices, fitOBB(obbPoints, { mode: "upright", dominantLayer: options.dominantLayer }), {
    searchVolume,
    scannedCount,
    candidateCount: candidates.length,
    rejectedBackgroundCount: rejectedBackground,
    rejectedPeerCount: rejectedPeer,
    rejectedScaleCount: rejectedScale,
    rejectedFloorCount: rejectedFloor,
    slabScaleExemptCount: slabScaleExempt,
    upperSurfaceY,
    minHitY,
    peerSurfaceHitsRemoved,
    excludedPeerViews,
    rejectedInsufficientVotesCount: rejectedInsufficient,
    abstainedOccludedCount: abstainedOccluded,
    depthToleranceByView,
  });
}
