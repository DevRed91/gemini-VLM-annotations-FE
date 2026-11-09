import * as THREE from "three";
import type { OBBFitResult } from "../utils/obbFit.ts";
import type { MeasuredObjectCluster } from "../GeometricContextManager/GeometricContextManager.ts";
import type { DBSCANClusterReport } from "../GeometricContextManager/GeometricContextManager.ts";
import type { GaussianObjectSelectionResult } from "../utils/gaussianObjectHighlighter.ts";
import type {
  AnchorSource,
  AnnotationRequestDiagnostics,
  DetectionDiagnostics,
  LiftRecord,
  MeasurementRecord,
  NormalizedBox,
  ObbRecord,
  QuatRecord,
  SampleCellRecord,
  SamplingRecord,
  SanitizeRejection,
  Vec3Record,
} from "./types.ts";
import { clusterColor } from "./clusterPalette.ts";

/** Screen-space probe collected by the viewer while sampling a box. */
export interface SampleCellProbe {
  readonly row: number;
  readonly col: number;
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly rayOrigin: THREE.Vector3 | null;
  readonly rayDirection: THREE.Vector3 | null;
  readonly intersection: THREE.Intersection | null;
}

export function vec3(v: THREE.Vector3): Vec3Record {
  return { x: v.x, y: v.y, z: v.z };
}

function quat(q: THREE.Quaternion): QuatRecord {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * Classify a raw detection box the same way the production sanitize step does,
 * for display only. Must stay in sync with `sanitizeDetectionBox`.
 */
export function sanitizeRejectionReason(box: unknown): SanitizeRejection | null {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return "invalid";
  const [ymin, xmin, ymax, xmax] = box.map((value) => Math.min(1, Math.max(0, value)));
  if (xmax - xmin < 0.02 || ymax - ymin < 0.02) return "too-small";
  return null;
}

export function createDetectionDiagnostics(detection: {
  label: string;
  box: unknown;
}): DetectionDiagnostics {
  const rawBox =
    Array.isArray(detection.box) && detection.box.length === 4 &&
    detection.box.every(Number.isFinite)
      ? (detection.box.map((value) => Math.min(1, Math.max(0, value))) as NormalizedBox)
      : null;
  return {
    label: detection.label,
    rawBox,
    sanitizedBox: null,
    sanitizeRejection: null,
    sampling: null,
    clustering: null,
    measurement: null,
    obb: null,
    lift: null,
    liftNote: null,
    anchor: null,
    annotationId: null,
    failures: [],
  };
}

export function applySanitize(
  record: DetectionDiagnostics,
  sanitizedBox: NormalizedBox | null,
): void {
  record.sanitizedBox = sanitizedBox;
  record.sanitizeRejection = sanitizedBox === null
    ? sanitizeRejectionReason(record.rawBox) ?? "invalid"
    : null;
  if (sanitizedBox === null) {
    record.failures.push({ stage: "sanitize", reason: "detection box rejected" });
  }
}

export function applySampling(
  record: DetectionDiagnostics,
  gridSize: number,
  probes: readonly SampleCellProbe[],
): void {
  let hitOrdinal = 0;
  const cells: SampleCellRecord[] = probes.map((probe) => {
    const hit = probe.intersection !== null;
    const ordinal = hit ? hitOrdinal++ : null;
    return {
      row: probe.row,
      col: probe.col,
      normalizedX: probe.normalizedX,
      normalizedY: probe.normalizedY,
      hit,
      hitOrdinal: ordinal,
      distance: probe.intersection?.distance ?? null,
      position: probe.intersection ? vec3(probe.intersection.point) : null,
      rayOrigin: probe.rayOrigin ? vec3(probe.rayOrigin) : null,
      rayDirection: probe.rayDirection ? vec3(probe.rayDirection) : null,
    };
  });
  const hits = cells.filter((cell) => cell.hit).length;
  const sampling: SamplingRecord = {
    gridSize,
    area: sanitizedArea(record.sanitizedBox),
    hitCount: hits,
    missCount: cells.length - hits,
    cells,
  };
  record.sampling = sampling;
}

function sanitizedArea(box: NormalizedBox | null): number {
  if (!box) return 0;
  return (box[3] - box[1]) * (box[2] - box[0]);
}

/**
 * Mirror of the production largest-cluster rule (earliest cluster wins ties),
 * used only to tag which cluster the viewer will select.
 */
export function largestClusterIndex(clusters: readonly (readonly number[])[]): number | null {
  if (clusters.length === 0) return null;
  return clusters.reduce(
    (best, cluster, index) => (cluster.length > clusters[best].length ? index : best),
    0,
  );
}

export function applyClustering(
  record: DetectionDiagnostics,
  sampledPoints: readonly THREE.Vector3[],
  report: DBSCANClusterReport | null,
  params: { eps: number; minPts: number },
): void {
  const sampledCount = sampledPoints.length;
  if (!report) {
    // DBSCAN never ran: fewer sample hits than minPts.
    record.clustering = {
      algorithm: "dbscan",
      eps: params.eps,
      minPts: params.minPts,
      sampledCount,
      clusters: [],
      noiseIndices: sampledPoints.map((_, index) => index),
      libraryNoiseIndices: [],
      selectedClusterIndex: null,
      selectionRule: "largest",
    };
    record.failures.push({
      stage: "clustering",
      reason: `only ${sampledCount} sample hits (< minPts ${params.minPts}); DBSCAN did not run`,
    });
    return;
  }

  const selectedIndex = largestClusterIndex(report.clusters);
  const clusters = report.clusters.map((members, index) => {
    const centroid = new THREE.Vector3();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const member of members) {
      const point = sampledPoints[member];
      centroid.add(point);
      min.min(point);
      max.max(point);
    }
    centroid.divideScalar(Math.max(1, members.length));
    return {
      index,
      size: members.length,
      centroid: vec3(centroid),
      bounds: { min: vec3(min), max: vec3(max) },
      extent: vec3(max.clone().sub(min)),
      pointIndices: [...members],
      colorHex: clusterColor(index),
      isSelected: index === selectedIndex,
    };
  });
  record.clustering = {
    algorithm: "dbscan",
    eps: params.eps,
    minPts: params.minPts,
    sampledCount,
    clusters,
    noiseIndices: [...report.noise],
    libraryNoiseIndices: [...report.libraryNoise],
    selectedClusterIndex: selectedIndex,
    selectionRule: "largest",
  };
  if (selectedIndex === null) {
    record.failures.push({
      stage: "clustering",
      reason: `DBSCAN found 0 clusters; all ${report.noise.length} sample hits are noise`,
    });
  }
}

export function applyMeasurement(
  record: DetectionDiagnostics,
  measured: MeasuredObjectCluster,
): void {
  const bounds = measured.box;
  const measurement: MeasurementRecord = {
    centroid: vec3(measured.centroid),
    dimensions: { ...measured.dimensions },
    bounds: { min: vec3(bounds.min), max: vec3(bounds.max) },
  };
  record.measurement = measurement;
}

export function applyObb(record: DetectionDiagnostics, fit: OBBFitResult): void {
  const obb: ObbRecord = {
    method: fit.method,
    position: vec3(fit.obb.position),
    quaternion: quat(fit.obb.quaternion),
    size: vec3(fit.obb.size),
    eigenvalues: [fit.eigenvalues[0], fit.eigenvalues[1], fit.eigenvalues[2]],
  };
  record.obb = obb;
}

export function applyLift(
  record: DetectionDiagnostics,
  selection: GaussianObjectSelectionResult | null,
  note: string | null,
): void {
  if (!selection) {
    record.liftNote = note;
    return;
  }
  const lift: LiftRecord = {
    selectedSplats: selection.selectedIds.length,
    numSplats: selection.lift.numSplats,
    candidates: selection.lift.candidates,
    opacityRejected: selection.lift.opacityRejected,
    scanDurationMs: selection.lift.scanDurationMs,
  };
  record.lift = lift;
  record.liftNote = note;
}

export function applyAnchor(
  record: DetectionDiagnostics,
  position: THREE.Vector3,
  source: AnchorSource,
): void {
  record.anchor = { position: vec3(position), source };
}

export function applyFailure(record: DetectionDiagnostics, stage: string, reason: string): void {
  record.failures.push({ stage, reason });
}

const fmt = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "n/a";

function vecText(v: Vec3Record | null): string {
  if (!v) return "(none)";
  return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}

/** Compact per-detection console summary; full data via window.__sl.diagnostics. */
export function summarizeDetection(
  request: AnnotationRequestDiagnostics,
  record: DetectionDiagnostics,
): string {
  const lines: string[] = [];
  const head = `#${request.index} "${record.label}" (${request.source})`;
  const anchorText = record.anchor ? `anchor=${record.anchor.source}` : "no anchor";
  const failureStages = record.failures.map((failure) => failure.stage).join(", ");
  lines.push(`${head} ${anchorText}${failureStages ? ` failures=[${failureStages}]` : ""}`);
  for (const failure of record.failures) {
    lines.push(`  FAILED ${failure.stage}: ${failure.reason}`);
  }
  const raw = record.rawBox ? record.rawBox.map((v) => v.toFixed(3)).join(", ") : "n/a";
  const sanitized = record.sanitizedBox
    ? record.sanitizedBox.map((v) => v.toFixed(3)).join(", ")
    : "rejected";
  lines.push(`  box raw=[${raw}] sanitized=[${sanitized}]`);
  if (record.sampling) {
    const { gridSize, hitCount, missCount, area } = record.sampling;
    lines.push(`  grid: ${gridSize}x${gridSize} over area ${area.toFixed(4)} -> hits ${hitCount}, misses ${missCount}`);
  }
  if (record.clustering) {
    const c = record.clustering;
    const sizes = c.clusters.map((cluster) => `${cluster.index}:${cluster.size}`).join(" ");
    lines.push(
      `  dbscan(eps=${c.eps}, minPts=${c.minPts}): clusters [${sizes}] noise=${c.noiseIndices.length}` +
        (c.selectedClusterIndex === null ? "" : ` -> selected #${c.selectedClusterIndex} (largest)`),
    );
    for (const cluster of c.clusters) {
      lines.push(
        `    cluster#${cluster.index}${cluster.isSelected ? " (SELECTED)" : ""} ` +
        `size=${cluster.size} centroid(mean)=${vecText(cluster.centroid)} extent=${vecText(cluster.extent)}`,
      );
    }
  }
  if (record.measurement) {
    const m = record.measurement;
    lines.push(
      `  measured: centroid=${vecText(m.centroid)} dims=` +
      `${fmt(m.dimensions.width)}x${fmt(m.dimensions.height)}x${fmt(m.dimensions.depth)} (AABB)`,
    );
  }
  if (record.obb) {
    const o = record.obb;
    lines.push(
      `  obb: ${o.method} centre=${vecText(o.position)} size=${vecText(o.size)}`,
    );
  }
  if (record.lift) {
    lines.push(
      `  lift: ${record.lift.selectedSplats}/${record.lift.numSplats} splats selected ` +
      `(candidates ${record.lift.candidates}, opacityRejected ${record.lift.opacityRejected})`,
    );
  } else if (record.liftNote) {
    lines.push(`  lift: none (${record.liftNote})`);
  }
  if (record.anchor) {
    lines.push(`  anchor: ${vecText(record.anchor.position)} source=${record.anchor.source}`);
  }
  return lines.join("\n");
}
