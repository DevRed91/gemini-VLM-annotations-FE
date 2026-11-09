/**
 * Structured per-request diagnostic data (Task 1 instrumentation).
 *
 * One `AnnotationRequestDiagnostics` is produced per annotation request (one
 * click → one Gemini call → N detections). Records are plain JSON-friendly
 * data: `window.__sl.diagnostics.list()` returns them verbatim, so they can be
 * attached to bug reports without post-processing. Production never creates
 * them; see `src/diagnostics/AnnotationDiagnostics.ts` for the dev-only gate.
 */

export interface Vec3Record {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface QuatRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Column-major 4x4 matrix as 16 numbers, exactly `THREE.Matrix4.elements`
 * order. Recorded verbatim so validation can replay the transform the
 * renderer actually used, without reconstructing it from parameters.
 */
export type Matrix4Record = readonly number[];

/** Full camera state frozen at one moment (click time or validation time). */
export interface CameraStateRecord {
  readonly position: Vec3Record;
  readonly quaternion: QuatRecord;
  readonly worldMatrix: Matrix4Record;
  readonly inverseWorldMatrix: Matrix4Record;
  readonly projectionMatrix: Matrix4Record;
  /** Vertical field of view in degrees; null when the camera is not perspective. */
  readonly fov: number | null;
  readonly aspect: number | null;
  readonly near: number | null;
  readonly far: number | null;
  readonly cameraType: string;
  readonly isPerspective: boolean;
}

/**
 * Canvas/viewport geometry frozen alongside the camera state. Normalized
 * click coordinates are relative to this rect, so pixel errors must be
 * computed with these dimensions (not the current ones).
 */
export interface ViewportRecord {
  /** Canvas bounding rect in CSS pixels (viewport coordinates). */
  readonly rectLeft: number;
  readonly rectTop: number;
  readonly rectWidth: number;
  readonly rectHeight: number;
  /** Canvas layout size in CSS pixels. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** Drawing-buffer size in device pixels. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  readonly devicePixelRatio: number;
}

/** Splat world transform frozen at the same moment as the camera state. */
export interface SplatTransformRecord {
  readonly position: Vec3Record;
  readonly quaternion: QuatRecord;
  readonly scale: Vec3Record;
  readonly worldMatrix: Matrix4Record;
}

/**
 * Everything needed to replay a projection exactly as the renderer would
 * have done it at click time. Null on requests that predate Task 2.1C and
 * on inject requests (no click).
 */
export interface ClickCameraSnapshot {
  readonly camera: CameraStateRecord;
  readonly viewport: ViewportRecord;
  readonly splat: SplatTransformRecord | null;
}

/** Normalized detection box, ordered [ymin, xmin, ymax, xmax]. */
export type NormalizedBox = [number, number, number, number];

export type SanitizeRejection = "invalid" | "too-small";

export type AnchorSource =
  /** Success path: AABB centroid of the largest DBSCAN cluster. */
  | "cluster-centroid"
  /** Fallback path: the user's original click hit. */
  | "click-hit"
  /** Fallback path: raycast at the sanitized box centre. */
  | "box-centre-raycast";

/** One screen-space sample-grid cell and its raycast outcome. */
export interface SampleCellRecord {
  readonly row: number;
  readonly col: number;
  readonly normalizedX: number;
  readonly normalizedY: number;
  /** True when the cell's ray intersected the splat. */
  readonly hit: boolean;
  /** Index into the sampled-points array handed to DBSCAN (hits only). */
  readonly hitOrdinal: number | null;
  /** Raycast hit distance in world units. */
  readonly distance: number | null;
  /** World-space hit point. */
  readonly position: Vec3Record | null;
  /** Ray origin at sampling time (camera position). */
  readonly rayOrigin: Vec3Record | null;
  /** Unit ray direction at sampling time. */
  readonly rayDirection: Vec3Record | null;
}

export interface SamplingRecord {
  readonly gridSize: number;
  /** Sanitized box area in normalized image units. */
  readonly area: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly cells: SampleCellRecord[];
}

export interface ClusterRecord {
  /** DBSCAN output order (0-based). */
  readonly index: number;
  readonly size: number;
  /** Mean of the member points (display only — production uses AABB centre). */
  readonly centroid: Vec3Record;
  /** Axis-aligned bounds of the member points. */
  readonly bounds: { readonly min: Vec3Record; readonly max: Vec3Record };
  /** Extent (max - min) per axis; useful as a compact spread measure. */
  readonly extent: Vec3Record;
  /** Indices into the sampled-points array passed to DBSCAN. */
  readonly pointIndices: readonly number[];
  readonly colorHex: number;
  readonly isSelected: boolean;
}

export interface ClusteringRecord {
  readonly algorithm: "dbscan";
  readonly eps: number;
  readonly minPts: number;
  /** Number of sample hits handed to DBSCAN. */
  readonly sampledCount: number;
  readonly clusters: readonly ClusterRecord[];
  /** Sampled-point indices assigned to no cluster (true DBSCAN noise). */
  readonly noiseIndices: readonly number[];
  /**
   * Raw `DBSCAN#noise` list. Can include border points that a later cluster
   * expansion adopted, so it may overlap cluster membership.
   */
  readonly libraryNoiseIndices: readonly number[];
  /** Index into `clusters` of the production-selected cluster. */
  readonly selectedClusterIndex: number | null;
  /** The unchanged production rule. */
  readonly selectionRule: "largest";
}

export interface MeasurementRecord {
  /** AABB centre of the selected cluster — the production anchor candidate. */
  readonly centroid: Vec3Record;
  readonly dimensions: { readonly width: number; readonly height: number; readonly depth: number };
  readonly bounds: { readonly min: Vec3Record; readonly max: Vec3Record };
}

export interface ObbRecord {
  readonly method: "pca" | "aabb-fallback";
  readonly position: Vec3Record;
  readonly quaternion: QuatRecord;
  readonly size: Vec3Record;
  readonly eigenvalues: readonly [number, number, number];
}

export interface LiftRecord {
  readonly selectedSplats: number;
  readonly numSplats: number;
  readonly candidates: number;
  readonly opacityRejected: number;
  readonly scanDurationMs: number;
}

/** Per-diagnostics failure note; a record with a failure still keeps prior stages. */
export interface FailureRecord {
  readonly stage: string;
  readonly reason: string;
}

/** Everything the pipeline did with one Gemini detection. */
export interface DetectionDiagnostics {
  readonly label: string;
  /** Box exactly as received from /api/annotate (already backend-normalized). */
  readonly rawBox: NormalizedBox | null;
  /** Box after frontend sanitizeDetectionBox (clamp + minimum size). */
  sanitizedBox: NormalizedBox | null;
  sanitizeRejection: SanitizeRejection | null;
  sampling: SamplingRecord | null;
  clustering: ClusteringRecord | null;
  measurement: MeasurementRecord | null;
  obb: ObbRecord | null;
  lift: LiftRecord | null;
  /** Why no lift record exists, e.g. "highlighter disabled". */
  liftNote: string | null;
  anchor: { readonly position: Vec3Record; readonly source: AnchorSource } | null;
  annotationId: string | null;
  /** Every pipeline stage that failed, in order (a fallback can follow a failure). */
  failures: FailureRecord[];
}

/** The user's click, frozen at click time (camera can move during the request). */
export interface RequestClickRecord {
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly cameraPosition: Vec3Record;
  readonly cameraQuaternion: QuatRecord;
  readonly rayOrigin: Vec3Record | null;
  readonly rayDirection: Vec3Record | null;
  readonly hit: { readonly position: Vec3Record; readonly distance: number } | null;
  /**
   * Full click-time camera/viewport/splat state (Task 2.1C). Optional so
   * records created before Task 2.1C remain valid; null when the viewer
   * could not capture it. Never mutated after the click.
   */
  readonly cameraSnapshot?: ClickCameraSnapshot | null;
}

/** One annotation request: click + Gemini response + per-detection records. */
export interface AnnotationRequestDiagnostics {
  readonly index: number;
  readonly startedAt: string;
  readonly source: "click" | "inject";
  readonly worldGeneration: number;
  click: RequestClickRecord | null;
  /** Captured frame sent to Gemini; retained only on the latest request. */
  snapshotDataUrl: string | null;
  /** Raw parsed /api/annotate response body. */
  response: unknown;
  detections: DetectionDiagnostics[];
}
