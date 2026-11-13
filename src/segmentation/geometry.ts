import * as THREE from "three";

import {
  projectSnapshotPoint,
  type SnapshotRay,
  type SnapshotVector3,
  type ViewSnapshot,
} from "../viewer/ViewSnapshot.ts";
import { bindSnapshot, type LiveWorldState } from "../viewer/SnapshotBinding.ts";
import type { PixelPoint } from "./contract.ts";

/** One splat intersection along a ray. */
export interface RayHit {
  readonly distance: number;
  readonly point: SnapshotVector3;
}

/** Casts a world-space ray into the scene and returns ALL hits, nearest first. */
export type CastFn = (origin: SnapshotVector3, direction: SnapshotVector3) => RayHit[];

/**
 * Cast straight into the splat via `SplatMesh.raycast`, NOT through
 * `Raycaster.intersectObject(splat)`. The latter recurses into children, and
 * every annotation adds an invisible OBB LineSegments helper as a child of the
 * splat, which hijacks later rays (see memory: splat-raycast-helper-pollution).
 * The direct call only ever sees splats. Cost is ~35 ms per ray on a large
 * scene, so callers must keep ray counts small.
 */
export function createSplatCaster(splat: THREE.Object3D): CastFn {
  return (origin, direction) => {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!(length > 0)) throw new RangeError("ray direction must be non-zero");
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(origin.x, origin.y, origin.z),
      new THREE.Vector3(direction.x / length, direction.y / length, direction.z / length),
    );
    const hits: THREE.Intersection[] = [];
    splat.raycast(raycaster, hits);
    hits.sort((a, b) => a.distance - b.distance);
    return hits.map((h) => ({ distance: h.distance, point: { x: h.point.x, y: h.point.y, z: h.point.z } }));
  };
}

const dist = (a: SnapshotVector3, b: SnapshotVector3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// ------------------------------------------------------------------ anchor

export interface AnchorRefinement {
  readonly anchor: SnapshotVector3;
  /** Number of probe rays that hit the splat. */
  readonly hitCount: number;
  readonly probeCount: number;
  /** Median distance (world units) from the chosen anchor to the other hits. 0 for a single hit. */
  readonly spread: number;
  /** Enough hits AND they agree: a lone or scattered hit is not trusted as "the surface". */
  readonly stable: boolean;
}

/**
 * Choose a robust anchor from several nearby ray hits: the MEDOID (the real
 * hit with the smallest summed distance to the others). A single floater or a
 * hit on a neighbouring object is outvoted instead of becoming the anchor.
 * Returns null when no probe hit anything.
 */
export function refineAnchor(
  hits: readonly SnapshotVector3[],
  probeCount: number,
  stableRadius = 0.1,
  minStableHits = 3,
): AnchorRefinement | null {
  if (hits.length === 0) return null;
  let best = 0;
  let bestSum = Infinity;
  for (let i = 0; i < hits.length; i++) {
    let sum = 0;
    for (let j = 0; j < hits.length; j++) if (i !== j) sum += dist(hits[i], hits[j]);
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  const others = hits.filter((_, i) => i !== best).map((h) => dist(h, hits[best])).sort((a, b) => a - b);
  const spread = others.length === 0 ? 0 : others[Math.floor((others.length - 1) / 2)];
  return {
    anchor: { ...hits[best] },
    hitCount: hits.length,
    probeCount,
    spread,
    stable: hits.length >= minStableHits && spread <= stableRadius,
  };
}

/** Normalized (u, v) probe offsets: the centre plus a ring of 8 at `radius` (normalized units). */
export function probeOffsets(radiusU: number, radiusV: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < 8; i++) {
    const angle = (i * Math.PI) / 4;
    offsets.push([Math.cos(angle) * radiusU, Math.sin(angle) * radiusV]);
  }
  return offsets;
}

// -------------------------------------------------------------- projection

export type ProjectionStatus = "in-view" | "outside-frame" | "behind-camera";

export interface ProjectedAnchor {
  readonly status: ProjectionStatus;
  /** Image-pixel position (top-left origin); null only when behind the camera. */
  readonly image: { x: number; y: number } | null;
  readonly normalized: { u: number; v: number } | null;
  /** Euclidean distance camera -> anchor, world units. */
  readonly cameraDistance: number;
}

/** Project a world point into one capture using only that capture's frozen camera. */
export function projectAnchorToImage(
  snapshot: ViewSnapshot,
  anchor: SnapshotVector3,
  currentWorldGeneration: number,
): ProjectedAnchor {
  const p = projectSnapshotPoint(snapshot, anchor, currentWorldGeneration);
  const cameraDistance = dist(snapshot.camera.position, anchor);
  if (p.behindCamera || !p.normalized) {
    return { status: "behind-camera", image: null, normalized: null, cameraDistance };
  }
  const { u, v } = p.normalized;
  return {
    status: p.outsideClipVolume ? "outside-frame" : "in-view",
    image: { x: u * snapshot.image.width, y: v * snapshot.image.height },
    normalized: { u, v },
    cameraDistance,
  };
}

// -------------------------------------------------------------- visibility

export type Visibility = "visible" | "occluded" | "unverified";

export interface VisibilityCheck {
  readonly visibility: Visibility;
  /** anchorDistance - nearest hit distance. > tolerance => something is in front. null when unverified. */
  readonly frontDistance: number | null;
  readonly tolerance: number;
  readonly note: string;
}

export function visibilityTolerance(anchorDistance: number, absolute = 0.05, relative = 0.02): number {
  return Math.max(absolute, relative * anchorDistance);
}

/**
 * Is the anchor the first thing the capture camera would see along its line
 * of sight? `hits` must be sorted nearest-first. NOTE: an anchor on the far
 * side of a thin object is reported "occluded" because the object's own near
 * surface is in front of it; that is a geometric fact, not a verdict on the
 * target. The tolerance is also a guess in scene units.
 */
export function classifyVisibility(
  hits: readonly RayHit[],
  anchorDistance: number,
  tolerance = visibilityTolerance(anchorDistance),
): VisibilityCheck {
  if (hits.length === 0) {
    return { visibility: "unverified", frontDistance: null, tolerance, note: "no splat hit along the line of sight (splat not settled, or anchor in empty space)" };
  }
  const front = anchorDistance - hits[0].distance;
  if (front > tolerance) {
    return {
      visibility: "occluded",
      frontDistance: front,
      tolerance,
      note: `surface ${front.toFixed(3)} in front of the anchor (another object, or this object's own near side)`,
    };
  }
  return { visibility: "visible", frontDistance: front, tolerance, note: "anchor is at or in front of the first splat hit" };
}

/** Line of sight from a capture camera to the anchor. */
export function lineOfSight(snapshot: ViewSnapshot, anchor: SnapshotVector3): SnapshotRay {
  const o = snapshot.camera.position;
  const d = { x: anchor.x - o.x, y: anchor.y - o.y, z: anchor.z - o.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (!(len > 0)) throw new RangeError("anchor coincides with the capture camera");
  return { origin: { ...o }, direction: { x: d.x / len, y: d.y / len, z: d.z / len } };
}

/** Pixel position -> the capture's own world ray (frozen camera; no live state). */
export function pixelToNormalized(snapshot: ViewSnapshot, x: number, y: number): { u: number; v: number } {
  return { u: x / snapshot.image.width, v: y / snapshot.image.height };
}

// ----------------------------------------------------------------- binding

/**
 * Throws StaleSnapshotError unless the capture was taken in the current world
 * with the splat transform unchanged; a capture from before a reload no longer
 * describes this scene and projecting into it would silently be wrong.
 */
export function assertCaptureCurrent(snapshot: ViewSnapshot, live: LiveWorldState): void {
  bindSnapshot(snapshot, live);
}

export function positivePoint(image: { x: number; y: number }): PixelPoint {
  return { x: image.x, y: image.y, label: 1 };
}
