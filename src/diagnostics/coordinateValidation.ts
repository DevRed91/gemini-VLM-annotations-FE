import * as THREE from "three";
import type {
  AnnotationRequestDiagnostics,
  CameraStateRecord,
  ClickCameraSnapshot,
  DetectionDiagnostics,
  SplatTransformRecord,
  Vec3Record,
  ViewportRecord,
} from "./types.ts";

/**
 * Development-only coordinate-frame validation core (Task 2.1C).
 *
 * Replays recorded 2D clicks and 3D hit points through the *click-time*
 * camera projection and measures where they land, to make coordinate-frame
 * consistency observable. Everything here is pure data-in/data-out over the
 * Task 1 diagnostic records plus explicitly captured camera snapshots; no
 * function ever mutates a record, and nothing feeds back into the annotation
 * pipeline.
 *
 * Coordinate conventions used throughout (verified against the production
 * code paths, see docs/annotation-diagnostics-task2-1c.md):
 *   - "normalized" screen coordinates are 0..1 relative to the canvas
 *     bounding rect, with +v pointing DOWN (script.ts click handler).
 *   - NDC is -1..1 with +y pointing UP; splatRay uses
 *     `ndcY = -(normalizedY * 2 - 1)` and the DOM label projection uses
 *     `(-pos.y * 0.5 + 0.5)`, so normalized v = 0.5 - ndc.y * 0.5.
 *   - Recorded hit positions are Three.js WORLD space, verified by reading
 *     Spark's SplatMesh.raycast source — but the spaceHypothesis test below
 *     checks that empirically per point instead of assuming it.
 */

/** Default tolerance for "consistent" verdicts, in normalized screen units. */
export const DEFAULT_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Snapshot capture (Feature A)
// ---------------------------------------------------------------------------

/**
 * Freeze the full camera state. Calls `updateWorldMatrix(true, false)` —
 * exactly what `getWorldPosition`/`getWorldQuaternion` (used by the Task 1
 * click probe) do internally — so the captured matrix matches the pose the
 * click handler observed. The projection matrix is captured verbatim
 * (not recomputed from fov/aspect) because it is what the renderer used.
 */
export function captureCameraState(camera: THREE.Camera): CameraStateRecord {
  camera.updateWorldMatrix(true, false);
  const perspective = camera as THREE.PerspectiveCamera;
  const orthographic = camera as THREE.OrthographicCamera;
  const isPerspective = perspective.isPerspectiveCamera === true;
  const isOrthographic = orthographic.isOrthographicCamera === true;
  const orthographicAspect =
    isOrthographic && orthographic.top - orthographic.bottom !== 0
      ? (orthographic.right - orthographic.left) / (orthographic.top - orthographic.bottom)
      : null;
  return {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    quaternion: {
      x: camera.quaternion.x,
      y: camera.quaternion.y,
      z: camera.quaternion.z,
      w: camera.quaternion.w,
    },
    worldMatrix: [...camera.matrixWorld.elements] as const,
    inverseWorldMatrix: [...camera.matrixWorld.clone().invert().elements] as const,
    projectionMatrix: [...camera.projectionMatrix.elements] as const,
    fov: isPerspective ? perspective.fov : null,
    aspect: isPerspective ? perspective.aspect : orthographicAspect,
    near: isPerspective ? perspective.near : isOrthographic ? orthographic.near : null,
    far: isPerspective ? perspective.far : isOrthographic ? orthographic.far : null,
    cameraType: isPerspective
      ? "PerspectiveCamera"
      : isOrthographic
        ? "OrthographicCamera"
        : camera.constructor.name,
    isPerspective,
  };
}

/** Freeze the canvas/viewport geometry the normalized coordinates refer to. */
export function captureViewport(canvas: HTMLCanvasElement): ViewportRecord {
  const rect = canvas.getBoundingClientRect();
  return {
    rectLeft: rect.left,
    rectTop: rect.top,
    rectWidth: rect.width,
    rectHeight: rect.height,
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    bufferWidth: canvas.width,
    bufferHeight: canvas.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/** Freeze the splat world transform (its matrixWorld decomposes into these). */
export function captureSplatTransform(splat: THREE.Object3D | null): SplatTransformRecord | null {
  if (!splat) return null;
  splat.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  splat.matrixWorld.decompose(position, quaternion, scale);
  return {
    position: { x: position.x, y: position.y, z: position.z },
    quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
    scale: { x: scale.x, y: scale.y, z: scale.z },
    worldMatrix: [...splat.matrixWorld.elements] as const,
  };
}

/** Full snapshot at one moment; the pieces are always captured together. */
export function captureSnapshot(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  splat: THREE.Object3D | null,
): ClickCameraSnapshot {
  return {
    camera: captureCameraState(camera),
    viewport: captureViewport(canvas),
    splat: captureSplatTransform(splat),
  };
}

// ---------------------------------------------------------------------------
// Projection math (Feature B steps 5-8)
// ---------------------------------------------------------------------------

export interface ProjectionOutcome {
  /** Clip-space homogeneous coordinates after projectionMatrix * viewMatrix. */
  readonly clip: readonly [number, number, number, number];
  /** NDC after perspective division; null when the point is behind the camera. */
  readonly ndc: { readonly x: number; readonly y: number; readonly z: number } | null;
  /**
   * Normalized 0..1 screen coordinates (u left→right, v top→bottom, relative
   * to the canvas rect); null when the point is behind the camera.
   */
  readonly normalized: { readonly u: number; readonly v: number } | null;
  /** True when w <= 0: the point is at or behind the camera plane. */
  readonly behindCamera: boolean;
  /** True when the point falls outside the clip volume (incl. behind). */
  readonly outsideClipVolume: boolean;
  /** Camera-space z (negative in front of the camera); equals clip.z before division. */
  readonly viewZ: number;
}

/** Column-major 4x4 times homogeneous vec4, with explicit w (no hidden divide). */
function multiplyMatrix4Vec4(m: readonly number[], v: readonly number[]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/**
 * Project a world-space point through a recorded camera state:
 * world --inverseWorldMatrix--> view --projectionMatrix--> clip -->
 * perspective division --> NDC --> normalized screen coordinates.
 *
 * The homogeneous w is handled explicitly (never divided implicitly) so
 * behind-camera points are reported, not silently mirrored.
 */
export function projectPoint(point: Vec3Record, camera: CameraStateRecord): ProjectionOutcome {
  const view = multiplyMatrix4Vec4(camera.inverseWorldMatrix, [point.x, point.y, point.z, 1]);
  const clip = multiplyMatrix4Vec4(camera.projectionMatrix, view);
  const w = clip[3];
  const behindCamera = !(w > 0);
  if (behindCamera) {
    return {
      clip: [clip[0], clip[1], clip[2], clip[3]],
      ndc: null,
      normalized: null,
      behindCamera: true,
      outsideClipVolume: true,
      viewZ: view[2],
    };
  }
  const ndc = { x: clip[0] / w, y: clip[1] / w, z: clip[2] / w };
  const outsideClipVolume =
    Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1;
  return {
    clip: [clip[0], clip[1], clip[2], clip[3]],
    ndc,
    // Normalized v is top-down; NDC y is bottom-up (see file header).
    normalized: { u: 0.5 + ndc.x * 0.5, v: 0.5 - ndc.y * 0.5 },
    behindCamera: false,
    outsideClipVolume,
    viewZ: view[2],
  };
}

/** Pixel-space reprojection error using the click-time viewport dimensions. */
export function pixelError(
  normalizedErrorDx: number,
  normalizedErrorDy: number,
  viewport: ViewportRecord,
): number {
  return Math.hypot(normalizedErrorDx * viewport.rectWidth, normalizedErrorDy * viewport.rectHeight);
}

// ---------------------------------------------------------------------------
// Camera-state diff (Feature A)
// ---------------------------------------------------------------------------

export interface CameraStateDiff {
  readonly positionDelta: Vec3Record;
  readonly positionDeltaMagnitude: number;
  /** Rotation between the two poses in radians (0 = identical orientation). */
  readonly rotationDeltaRad: number;
  readonly worldMatrixMaxAbsDelta: number;
  readonly projectionMatrixMaxAbsDelta: number;
  readonly fovDelta: number | null;
  readonly aspectDelta: number | null;
  readonly nearDelta: number | null;
  readonly farDelta: number | null;
  readonly viewportWidthDelta: number;
  readonly viewportHeightDelta: number;
  readonly devicePixelRatioDelta: number;
  readonly cameraMoved: boolean;
}

function maxAbsElementDelta(a: readonly number[], b: readonly number[]): number {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

/** Diff a click-time snapshot against a validation-time capture. */
export function diffCameraStates(
  clickSnapshot: ClickCameraSnapshot,
  live: ClickCameraSnapshot,
): CameraStateDiff {
  const a = clickSnapshot.camera;
  const b = live.camera;
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const dz = b.position.z - a.position.z;
  const qa = new THREE.Quaternion(a.quaternion.x, a.quaternion.y, a.quaternion.z, a.quaternion.w);
  const qb = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  const fovDelta = a.fov !== null && b.fov !== null ? b.fov - a.fov : null;
  const aspectDelta = a.aspect !== null && b.aspect !== null ? b.aspect - a.aspect : null;
  const nearDelta = a.near !== null && b.near !== null ? b.near - a.near : null;
  const farDelta = a.far !== null && b.far !== null ? b.far - a.far : null;
  return {
    positionDelta: { x: dx, y: dy, z: dz },
    positionDeltaMagnitude: Math.hypot(dx, dy, dz),
    rotationDeltaRad: qa.angleTo(qb),
    worldMatrixMaxAbsDelta: maxAbsElementDelta(a.worldMatrix, b.worldMatrix),
    projectionMatrixMaxAbsDelta: maxAbsElementDelta(a.projectionMatrix, b.projectionMatrix),
    fovDelta,
    aspectDelta,
    nearDelta,
    farDelta,
    viewportWidthDelta: live.viewport.rectWidth - clickSnapshot.viewport.rectWidth,
    viewportHeightDelta: live.viewport.rectHeight - clickSnapshot.viewport.rectHeight,
    devicePixelRatioDelta:
      live.viewport.devicePixelRatio - clickSnapshot.viewport.devicePixelRatio,
    cameraMoved:
      Math.hypot(dx, dy, dz) > 1e-9 ||
      qa.angleTo(qb) > 1e-9 ||
      maxAbsElementDelta(a.projectionMatrix, b.projectionMatrix) > 1e-9,
  };
}

// ---------------------------------------------------------------------------
// Ray + space consistency (Feature E)
// ---------------------------------------------------------------------------

export interface RayConsistency {
  /** Point reconstructed as rayOrigin + rayDirection * distance. */
  readonly expectedPoint: Vec3Record;
  /** Distance between the recorded hit and that reconstruction, world units. */
  readonly offset: number;
}

/**
 * Check a recorded hit against its own ray: the hit must lie at
 * `origin + direction * distance` when the hit position, ray, and distance
 * share one coordinate space. A non-zero offset is direct evidence of a
 * coordinate-space mismatch between the ray and the returned hit.
 */
export function checkRayConsistency(
  rayOrigin: Vec3Record | null,
  rayDirection: Vec3Record | null,
  distance: number | null,
  hit: Vec3Record | null,
): RayConsistency | null {
  if (!rayOrigin || !rayDirection || distance === null || !hit) return null;
  const expected = {
    x: rayOrigin.x + rayDirection.x * distance,
    y: rayOrigin.y + rayDirection.y * distance,
    z: rayOrigin.z + rayDirection.z * distance,
  };
  return {
    expectedPoint: expected,
    offset: Math.hypot(hit.x - expected.x, hit.y - expected.y, hit.z - expected.z),
  };
}

export type SpaceVerdict =
  | "consistent-with-world"
  | "consistent-with-splat-local"
  | "ambiguous-both-consistent"
  | "inconsistent-with-both";

export interface SpaceHypothesis {
  /** Reprojection error when the point is treated as Three.js world space. */
  readonly worldError: number | null;
  /**
   * Reprojection error when the point is treated as splat-local space and
   * transformed by the recorded splat matrixWorld. Null when no splat
   * transform was recorded or the local point is behind the camera.
   */
  readonly splatLocalError: number | null;
  readonly verdict: SpaceVerdict;
  readonly tolerance: number;
}

/**
 * Test which coordinate space a recorded position lives in, empirically:
 * project it under the world-space hypothesis and under the splat-local
 * hypothesis (transform by the *recorded* splat matrixWorld — the actual
 * transform, never an invented correction) and compare reprojection errors.
 * A point that only reprojects correctly as splat-local is direct evidence
 * of a SparkJS/Three.js space mismatch.
 */
export function testSpaceHypothesis(
  point: Vec3Record,
  originalU: number,
  originalV: number,
  camera: CameraStateRecord,
  splat: SplatTransformRecord | null,
  tolerance: number,
): SpaceHypothesis {
  const worldProjection = projectPoint(point, camera);
  const worldError = worldProjection.normalized
    ? Math.hypot(worldProjection.normalized.u - originalU, worldProjection.normalized.v - originalV)
    : null;
  let splatLocalError: number | null = null;
  if (splat) {
    const local = multiplyMatrix4Vec4(splat.worldMatrix, [point.x, point.y, point.z, 1]);
    const localProjection = projectPoint({ x: local[0] / local[3], y: local[1] / local[3], z: local[2] / local[3] }, camera);
    splatLocalError = localProjection.normalized
      ? Math.hypot(localProjection.normalized.u - originalU, localProjection.normalized.v - originalV)
      : null;
  }
  const worldOk = worldError !== null && worldError <= tolerance;
  const localOk = splatLocalError !== null && splatLocalError <= tolerance;
  let verdict: SpaceVerdict;
  if (worldOk && localOk) verdict = "ambiguous-both-consistent";
  else if (worldOk) verdict = "consistent-with-world";
  else if (localOk) verdict = "consistent-with-splat-local";
  else verdict = "inconsistent-with-both";
  return { worldError, splatLocalError, verdict, tolerance };
}

export interface SplatRaycastSpaceAnalysis {
  readonly scaleIsUnit: boolean;
  readonly rotationIsRigid: boolean;
  /**
   * True when Spark's raycast construction (worldRay.origin +
   * worldRay.direction * local-distance, verified from Spark source) yields
   * valid world-space points for this transform — i.e. the transform is
   * rigid (rotation + translation, unit scale).
   */
  readonly sparkRaycastWorldSpaceSafe: boolean;
  readonly note: string;
}

/**
 * Analyse the splat transform for the SparkJS raycast quirk: Spark casts in
 * mesh-local space but reconstructs the returned point on the *world* ray
 * with the *local* distance parameter (see
 * node_modules/@sparkjsdev/spark/dist/spark.module.js SplatMesh.raycast).
 * That reconstruction is only world-correct for rigid transforms; under
 * non-unit scale the recorded hit positions (and distances) are suspect.
 */
export function analyseSplatRaycastSpace(splat: SplatTransformRecord | null): SplatRaycastSpaceAnalysis {
  if (!splat) {
    return {
      scaleIsUnit: false,
      rotationIsRigid: false,
      sparkRaycastWorldSpaceSafe: false,
      note: "no splat transform recorded (no splat loaded at capture time)",
    };
  }
  const scaleIsUnit =
    Math.abs(splat.scale.x - 1) < 1e-6 &&
    Math.abs(splat.scale.y - 1) < 1e-6 &&
    Math.abs(splat.scale.z - 1) < 1e-6;
  const q = splat.quaternion;
  const rotationIsRigid = Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-6;
  const safe = scaleIsUnit && rotationIsRigid;
  return {
    scaleIsUnit,
    rotationIsRigid,
    sparkRaycastWorldSpaceSafe: safe,
    note: safe
      ? "splat transform is rigid (rotation+translation, unit scale): Spark raycast hit points are valid Three.js world space"
      : "splat transform is NOT rigid: Spark raycast reconstructs hit points on the world ray with a local-space distance — hit positions/distances may be inconsistent with world space",
  };
}

// ---------------------------------------------------------------------------
// Click-hit validation (Feature B)
// ---------------------------------------------------------------------------

export type CameraStateSource = "click-snapshot";

export interface ClickValidationResult {
  readonly requestIndex: number;
  readonly status: "ok" | "unavailable";
  readonly reason: string | null;
  readonly cameraSource: CameraStateSource | null;
  readonly original: { readonly u: number; readonly v: number; readonly clientX: number; readonly clientY: number } | null;
  readonly hit: { readonly position: Vec3Record; readonly distance: number } | null;
  readonly rayConsistency: RayConsistency | null;
  readonly projected: ProjectionOutcome | null;
  readonly errors: {
    readonly dx: number;
    readonly dy: number;
    readonly normalized: number;
    readonly pixels: number;
  } | null;
  readonly spaceHypothesis: SpaceHypothesis | null;
}

/**
 * Replay the recorded click hit through the click-time camera and measure
 * the reprojection error against the original click coordinates. Uses only
 * frozen click-time state — never the live camera: if the snapshot is
 * missing, the limitation is reported instead of substituted.
 */
export function validateClickReprojection(
  request: AnnotationRequestDiagnostics,
  options: { tolerance?: number } = {},
): ClickValidationResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const click = request.click;
  const base = { requestIndex: request.index } as const;
  if (!click) {
    return {
      ...base,
      status: "unavailable",
      reason: "no click record on this request (inject seam or pre-click request)",
      cameraSource: null,
      original: null,
      hit: null,
      rayConsistency: null,
      projected: null,
      errors: null,
      spaceHypothesis: null,
    };
  }
  const snapshot = click.cameraSnapshot ?? null;
  if (!snapshot) {
    return {
      ...base,
      status: "unavailable",
      reason:
        "no click-time camera snapshot on this record (created before Task 2.1C, or camera/canvas unavailable at click time); the projection matrix was never recorded, so the click-time projection cannot be replayed",
      cameraSource: null,
      original: { u: click.normalizedX, v: click.normalizedY, clientX: click.clientX, clientY: click.clientY },
      hit: click.hit,
      rayConsistency: checkRayConsistency(click.rayOrigin, click.rayDirection, click.hit?.distance ?? null, click.hit?.position ?? null),
      projected: null,
      errors: null,
      spaceHypothesis: null,
    };
  }
  if (!click.hit) {
    return {
      ...base,
      status: "unavailable",
      reason: "the click ray did not intersect the splat (no hit to reproject)",
      cameraSource: "click-snapshot",
      original: { u: click.normalizedX, v: click.normalizedY, clientX: click.clientX, clientY: click.clientY },
      hit: null,
      rayConsistency: checkRayConsistency(click.rayOrigin, click.rayDirection, null, null),
      projected: null,
      errors: null,
      spaceHypothesis: null,
    };
  }
  const projected = projectPoint(click.hit.position, snapshot.camera);
  const dx = projected.normalized ? projected.normalized.u - click.normalizedX : 0;
  const dy = projected.normalized ? projected.normalized.v - click.normalizedY : 0;
  const errors = projected.normalized
    ? {
        dx,
        dy,
        normalized: Math.hypot(dx, dy),
        pixels: pixelError(dx, dy, snapshot.viewport),
      }
    : null;
  return {
    ...base,
    status: "ok",
    reason: null,
    cameraSource: "click-snapshot",
    original: { u: click.normalizedX, v: click.normalizedY, clientX: click.clientX, clientY: click.clientY },
    hit: click.hit,
    rayConsistency: checkRayConsistency(
      click.rayOrigin,
      click.rayDirection,
      click.hit.distance,
      click.hit.position,
    ),
    projected,
    errors,
    spaceHypothesis: testSpaceHypothesis(
      click.hit.position,
      click.normalizedX,
      click.normalizedY,
      snapshot.camera,
      snapshot.splat,
      tolerance,
    ),
  };
}

// ---------------------------------------------------------------------------
// Sampling-hit validation (Feature C)
// ---------------------------------------------------------------------------

export type SampleRowStatus =
  | "ok"
  | "outside-clip"
  | "behind-camera"
  | "camera-unavailable"
  | "ray-inconsistent"
  /** The cell's ray did not intersect the splat (no hit to reproject). */
  | "miss";

export interface SampleValidationRow {
  readonly detectionIndex: number;
  readonly row: number;
  readonly col: number;
  readonly originalU: number;
  readonly originalV: number;
  readonly projectedU: number | null;
  readonly projectedV: number | null;
  readonly normalizedError: number | null;
  readonly pixelError: number | null;
  readonly viewZ: number | null;
  readonly behindCamera: boolean;
  readonly outsideClipVolume: boolean;
  readonly rayConsistencyOffset: number | null;
  readonly status: SampleRowStatus;
}

export interface AggregateStats {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly max: number;
  /** Nearest-rank 95th percentile (ceil(0.95*n)-th value, 1-based). */
  readonly p95: number;
}

export interface SamplesValidationResult {
  readonly requestIndex: number;
  readonly cameraSource: CameraStateSource | null;
  readonly status: "ok" | "unavailable";
  readonly reason: string | null;
  /** All grid cells examined (hits and misses) — misses are not silently dropped. */
  readonly totalCells: number;
  readonly hitCells: number;
  readonly missCells: number;
  /** Hit cells whose position was projected (status ok/outside-clip). */
  readonly projectedCells: number;
  /** Hit cells behind the camera (projection undefined). */
  readonly behindCameraCells: number;
  /** Hit cells skipped because no click-time camera snapshot exists. */
  readonly cameraUnavailableCells: number;
  /** Hit cells whose recorded position is off their own recorded ray. */
  readonly rayInconsistentCells: number;
  /** Normalized-error stats over successfully projected cells only. */
  readonly normalizedErrorStats: AggregateStats | null;
  /** Pixel-error stats over successfully projected cells only. */
  readonly pixelErrorStats: AggregateStats | null;
  readonly rows: readonly SampleValidationRow[];
}

/**
 * Error statistics over a set of values (the successfully projected points).
 * p95 is nearest-rank: the ceil(0.95·n)-th value of the ascending sort.
 * Exported for tests and for consumers that aggregate custom error sets.
 */
export function aggregateStats(values: readonly number[]): AggregateStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    median,
    max: sorted[sorted.length - 1],
    p95: sorted[p95Index],
  };
}

function validateDetectionSamples(
  detection: DetectionDiagnostics,
  detectionIndex: number,
  snapshot: ClickCameraSnapshot | null,
): SampleValidationRow[] {
  const sampling = detection.sampling;
  if (!sampling) return [];
  const rows: SampleValidationRow[] = [];
  for (const cell of sampling.cells) {
    const missRow: SampleValidationRow = {
      detectionIndex,
      row: cell.row,
      col: cell.col,
      originalU: cell.normalizedX,
      originalV: cell.normalizedY,
      projectedU: null,
      projectedV: null,
      normalizedError: null,
      pixelError: null,
      viewZ: null,
      behindCamera: false,
      outsideClipVolume: false,
      rayConsistencyOffset: null,
      status: "camera-unavailable",
    };
    if (!cell.hit || !cell.position) {
      // Misses are reported as rows (counted as missCells), never projected.
      rows.push({ ...missRow, status: "miss" });
      continue;
    }
    const rayConsistency = checkRayConsistency(
      cell.rayOrigin,
      cell.rayDirection,
      cell.distance,
      cell.position,
    );
    if (!snapshot) {
      rows.push({
        ...missRow,
        rayConsistencyOffset: rayConsistency?.offset ?? null,
        status: "camera-unavailable",
      });
      continue;
    }
    const projected = projectPoint(cell.position, snapshot.camera);
    if (projected.behindCamera) {
      rows.push({
        detectionIndex,
        row: cell.row,
        col: cell.col,
        originalU: cell.normalizedX,
        originalV: cell.normalizedY,
        projectedU: null,
        projectedV: null,
        normalizedError: null,
        pixelError: null,
        viewZ: projected.viewZ,
        behindCamera: true,
        outsideClipVolume: true,
        rayConsistencyOffset: rayConsistency?.offset ?? null,
        status: "behind-camera",
      });
      continue;
    }
    const dx = projected.normalized!.u - cell.normalizedX;
    const dy = projected.normalized!.v - cell.normalizedY;
    const normalizedError = Math.hypot(dx, dy);
    const status: SampleRowStatus =
      cell.hit && rayConsistency && rayConsistency.offset > 1e-4
        ? "ray-inconsistent"
        : projected.outsideClipVolume
          ? "outside-clip"
          : "ok";
    rows.push({
      detectionIndex,
      row: cell.row,
      col: cell.col,
      originalU: cell.normalizedX,
      originalV: cell.normalizedY,
      projectedU: projected.normalized!.u,
      projectedV: projected.normalized!.v,
      normalizedError,
      pixelError: pixelError(dx, dy, snapshot.viewport),
      viewZ: projected.viewZ,
      behindCamera: false,
      outsideClipVolume: projected.outsideClipVolume,
      rayConsistencyOffset: rayConsistency?.offset ?? null,
      status,
    });
  }
  return rows;
}

/**
 * Reproject every valid sampling hit of a request (all detections) through
 * the click-time camera. Misses, behind-camera hits, and hits without a
 * camera snapshot all stay in the result — nothing is silently excluded;
 * each appears in the counts and the table with its status.
 */
export function validateSampleReprojections(
  request: AnnotationRequestDiagnostics,
  options: { detectionIndex?: number } = {},
): SamplesValidationResult {
  const click = request.click;
  const snapshot = click?.cameraSnapshot ?? null;
  const detections = options.detectionIndex === undefined
    ? request.detections
    : [request.detections[options.detectionIndex]].filter(Boolean);
  const rows = detections.flatMap((detection, index) =>
    validateDetectionSamples(detection, options.detectionIndex ?? index, snapshot),
  );
  // Recompute counts from cell-level truth (misses are cells with no hit).
  const allCells = detections.flatMap((detection) => detection.sampling?.cells ?? []);
  const hitCells = allCells.filter((cell) => cell.hit && cell.position).length;
  const missCells = allCells.length - hitCells;
  const projectedRows = rows.filter((row) => row.normalizedError !== null);
  const behindCameraCells = rows.filter((row) => row.status === "behind-camera").length;
  // Hit cells that could not be projected because no click-time camera
  // snapshot exists (misses are counted separately as missCells).
  const cameraUnavailableCells = snapshot === null ? hitCells : 0;
  const rayInconsistentCells = rows.filter((row) => row.status === "ray-inconsistent").length;
  const normalizedErrors = projectedRows
    .map((row) => row.normalizedError)
    .filter((value): value is number => value !== null);
  const pixelErrors = projectedRows
    .map((row) => row.pixelError)
    .filter((value): value is number => value !== null);
  const unavailable = !click
    ? "no click record on this request (inject seam): there is no click-time camera state to project with"
    : !snapshot
      ? "no click-time camera snapshot on this record (created before Task 2.1C): hit cells are checked for ray consistency only"
      : null;
  return {
    requestIndex: request.index,
    cameraSource: snapshot ? "click-snapshot" : null,
    status: unavailable ? "unavailable" : "ok",
    reason: unavailable,
    totalCells: allCells.length,
    hitCells,
    missCells,
    projectedCells: projectedRows.length,
    behindCameraCells,
    cameraUnavailableCells,
    rayInconsistentCells,
    normalizedErrorStats: aggregateStats(normalizedErrors),
    pixelErrorStats: aggregateStats(pixelErrors),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Full report (Features A+E+F)
// ---------------------------------------------------------------------------

export interface LiveCapture {
  readonly capturedAt: string;
  readonly camera: CameraStateRecord;
  readonly viewport: ViewportRecord;
  readonly splat: SplatTransformRecord | null;
}

export interface ValidationReport {
  readonly generatedAt: string;
  readonly requestIndex: number;
  readonly requestSource: string;
  readonly clickValidation: ClickValidationResult;
  readonly samplesValidation: SamplesValidationResult;
  readonly cameraDiff: CameraStateDiff | null;
  readonly clickTimeCamera: CameraStateRecord | null;
  readonly validationTimeCamera: CameraStateRecord | null;
  readonly splatAnalysis: SplatRaycastSpaceAnalysis;
  readonly coordinateSpaces: CoordinateSpaceDoc;
}

/**
 * Feature E: the coordinate spaces of every stage, as verified from the
 * production source (see docs/annotation-diagnostics-task2-1c.md for the
 * file/line evidence). Displayed verbatim in the panel and exported so a
 * report is self-describing.
 */
export interface CoordinateSpaceDoc {
  readonly threeCamera: string;
  readonly sparkRaycast: string;
  readonly splatScene: string;
  readonly hitPositions: string;
  readonly diagnosticMarkers: string;
  readonly clusterCentroids: string;
  readonly annotationAnchors: string;
  readonly domProjection: string;
}

export const COORDINATE_SPACES: CoordinateSpaceDoc = {
  threeCamera:
    "Three.js right-handed world space; the camera looks down its local -Z; worldMatrix maps camera-local to world, projectionMatrix maps camera-local to clip space.",
  sparkRaycast:
    "SparkJS SplatMesh.raycast transforms the world ray into mesh-local space (inverse matrixWorld), casts there, and reconstructs each hit as worldRay.origin + worldRay.direction * localDistance — world-correct only for rigid splat transforms (verified against Spark 2.0.0 source).",
  splatScene:
    "The .sog SplatMesh is a scene child with a non-identity world transform (script.ts loadWorld sets position (0, -1.5, 0)); splat data itself is in mesh-local space.",
  hitPositions:
    "Raycast hit positions recorded by the pipeline are world space under the rigid-transform condition above; testSpaceHypothesis checks this empirically per point instead of assuming it.",
  diagnosticMarkers:
    "Diagnostic 3D markers are added directly to a scene-root group (no splat transform), so they interpret recorded positions as world space — a splat-local hit would visibly misplace its marker.",
  clusterCentroids:
    "DBSCAN operates on the recorded hit positions; cluster centroids/AABB centres are means of those points and share whatever space the hits are in.",
  annotationAnchors:
    "The production anchor is the AABB centre of the largest cluster (GeometricContextManager), in the same space as the hits.",
  domProjection:
    "DOM annotation tags project anchors with anchor.clone().project(camera) (world→NDC) and map NDC to window pixels; the click path normalizes by the canvas rect — identical only while the canvas fills the window.",
};

/** Assemble the complete, JSON-serializable validation report for one request. */
export function buildValidationReport(
  request: AnnotationRequestDiagnostics,
  live: LiveCapture | null,
  options: { tolerance?: number } = {},
): ValidationReport {
  const clickSnapshot = request.click?.cameraSnapshot ?? null;
  const splatAnalysis = analyseSplatRaycastSpace(clickSnapshot?.splat ?? live?.splat ?? null);
  return {
    generatedAt: new Date().toISOString(),
    requestIndex: request.index,
    requestSource: request.source,
    clickValidation: validateClickReprojection(request, options),
    samplesValidation: validateSampleReprojections(request),
    cameraDiff:
      clickSnapshot && live
        ? diffCameraStates(
            clickSnapshot,
            { camera: live.camera, viewport: live.viewport, splat: live.splat },
          )
        : null,
    clickTimeCamera: clickSnapshot?.camera ?? null,
    validationTimeCamera: live?.camera ?? null,
    splatAnalysis,
    coordinateSpaces: COORDINATE_SPACES,
  };
}

/** Serialize the report for export (pretty JSON, stable key order). */
export function serializeReport(report: ValidationReport): string {
  return JSON.stringify(report, null, 2);
}
