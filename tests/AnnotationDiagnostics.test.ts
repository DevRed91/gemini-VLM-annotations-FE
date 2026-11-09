import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Box3, Vector3, Quaternion } from "three";
import type { Intersection, Object3D } from "three";

import GeometricContextManager from "../src/GeometricContextManager/GeometricContextManager.ts";
import type { DBSCANClusterReport } from "../src/GeometricContextManager/GeometricContextManager.ts";
import { OBB } from "../src/utils/obb.ts";
import { clusterColors } from "../src/diagnostics/clusterPalette.ts";
import {
  applyAnchor,
  applyClustering,
  applyFailure,
  applyLift,
  applyMeasurement,
  applyObb,
  applySampling,
  applySanitize,
  createDetectionDiagnostics,
  largestClusterIndex,
  sanitizeRejectionReason,
  summarizeDetection,
  type SampleCellProbe,
} from "../src/diagnostics/records.ts";
import type { AnnotationRequestDiagnostics, DetectionDiagnostics } from "../src/diagnostics/types.ts";

function points(...coords: Array<[number, number, number]>): Vector3[] {
  return coords.map(([x, y, z]) => new Vector3(x, y, z));
}

function makeRequest(): AnnotationRequestDiagnostics {
  return {
    index: 1,
    startedAt: "2026-11-09T00:00:00.000Z",
    source: "inject",
    worldGeneration: 0,
    click: null,
    snapshotDataUrl: null,
    response: null,
    detections: [],
  };
}

function makeProbe(
  row: number,
  col: number,
  hit: boolean,
  position?: Vector3,
): SampleCellProbe {
  return {
    row,
    col,
    normalizedX: col / 10,
    normalizedY: row / 10,
    rayOrigin: new Vector3(0, 0, -5),
    rayDirection: new Vector3(0, 0, 1),
    intersection: hit
      ? ({ distance: 5, point: position ?? new Vector3(0, 0, 0) } as Intersection<Object3D>)
      : null,
  };
}

/** Captures collector reports without TS closure-narrowing getting in the way. */
function reportSink(): {
  reports: DBSCANClusterReport[];
  onClusters: (report: DBSCANClusterReport) => void;
} {
  const reports: DBSCANClusterReport[] = [];
  return { reports, onClusters: (report) => { reports.push(report); } };
}

describe("GeometricContextManager diagnostics collector", () => {
  test("collector does not change clustering, selection, or measurement", () => {
    const manager = new GeometricContextManager();
    const raw = points(
      [0, 0, 0], [0.1, 0, 0], [0.2, 0, 0],   // cluster A (3 points)
      [5, 0, 0], [5.1, 0, 0],                 // cluster B (2 points)
      [2.5, 0, 0],                            // noise
    );
    const without = manager.registerAndMeasureObject("rug", raw, { eps: 0.3, minPts: 2 });
    const sink = reportSink();
    const withCollector = manager.registerAndMeasureObject("rug", raw, {
      eps: 0.3,
      minPts: 2,
      onClusters: sink.onClusters,
    });

    assert.ok(without && withCollector, "both calls must measure a cluster");
    assert.deepEqual(withCollector.dimensions, without.dimensions);
    assert.deepEqual(withCollector.centroid.toArray(), without.centroid.toArray());
    assert.deepEqual(
      withCollector.points.map((p) => p.toArray()),
      without.points.map((p) => p.toArray()),
    );
    assert.equal(withCollector.points.length, 3, "largest cluster A must be selected");
    assert.deepEqual(without.points.map((p) => p.toArray()), [
      [0, 0, 0], [0.1, 0, 0], [0.2, 0, 0],
    ]);
  });

  test("collector reports all clusters plus true noise", () => {
    const manager = new GeometricContextManager();
    const raw = points(
      [0, 0, 0], [0.1, 0, 0], [0.2, 0, 0],
      [5, 0, 0], [5.1, 0, 0],
      [2.5, 0, 0],
    );
    const sink = reportSink();
    manager.registerAndMeasureObject("rug", raw, {
      eps: 0.3,
      minPts: 2,
      onClusters: sink.onClusters,
    });
    const report = sink.reports[0];
    assert.ok(report, "collector must fire");
    assert.deepEqual(
      report.clusters.map((cluster) => [...cluster]),
      [[0, 1, 2], [3, 4]],
    );
    assert.deepEqual([...report.noise], [5]);
    assert.ok(report.libraryNoise.includes(5), "library noise must contain the outlier");
  });

  test("library noise can include points a cluster later adopted", () => {
    // With eps=1, minPts=3: point 0 is first marked noise (2 neighbors < 3),
    // then adopted by the cluster seeded at point 1. It stays in DBSCAN#noise.
    const manager = new GeometricContextManager();
    const raw = points([0, 0, 0], [0.9, 0, 0], [1.7, 0, 0]);
    const sink = reportSink();
    const measured = manager.registerAndMeasureObject("rug", raw, {
      eps: 1,
      minPts: 3,
      onClusters: sink.onClusters,
    });
    const report = sink.reports[0];
    assert.ok(report && measured);
    assert.deepEqual(report.clusters.map((cluster) => [...cluster]), [[1, 0, 2]]);
    assert.deepEqual([...report.noise], [], "no point is truly unassigned");
    assert.deepEqual([...report.libraryNoise], [0], "raw library noise list retains point 0");
  });

  test("collector never fires when DBSCAN does not run (too few points)", () => {
    const manager = new GeometricContextManager();
    let fired = false;
    const measured = manager.registerAndMeasureObject("rug", points([0, 0, 0], [1, 0, 0]), {
      eps: 0.3,
      minPts: 10,
      onClusters: () => {
        fired = true;
      },
    });
    assert.equal(measured, null);
    assert.equal(fired, false);
  });
});

describe("cluster palette", () => {
  test("cluster colours are pairwise distinct and deterministic", () => {
    const first = clusterColors(16);
    const second = clusterColors(16);
    assert.deepEqual(first, second);
    assert.equal(new Set(first).size, 16, "expected 16 distinct colours");
    assert.ok(first.every((hex) => Number.isInteger(hex) && hex >= 0 && hex <= 0xffffff));
  });
});

describe("detection records", () => {
  test("sanitizeRejectionReason mirrors the production thresholds", () => {
    assert.equal(sanitizeRejectionReason("nope"), "invalid");
    assert.equal(sanitizeRejectionReason([0, 0.1, 0.4]), "invalid");
    assert.equal(sanitizeRejectionReason([0.5, 0.1, 0.505, 0.2]), "too-small");
    assert.equal(sanitizeRejectionReason([0.5, 0.1, 0.6, 0.2]), null);
  });

  test("createDetectionDiagnostics clamps the raw box into range", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0.4, -0.2, 1.4, 0.6] });
    assert.equal(record.label, "rug");
    assert.deepEqual(record.rawBox, [0.4, 0, 1, 0.6]);
    assert.equal(record.sanitizedBox, null);
    assert.deepEqual(record.failures, []);
  });

  test("applySampling counts hits, misses, and hit ordinals", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    applySanitize(record, [0, 0, 1, 1]);
    applySampling(record, 2, [
      makeProbe(0, 0, true, new Vector3(1, 1, 1)),
      makeProbe(0, 1, false),
      makeProbe(1, 0, true, new Vector3(2, 2, 2)),
      makeProbe(1, 1, true, new Vector3(3, 3, 3)),
    ]);
    const sampling = record.sampling!;
    assert.equal(sampling.gridSize, 2);
    assert.equal(sampling.hitCount, 3);
    assert.equal(sampling.missCount, 1);
    assert.deepEqual(
      sampling.cells.filter((cell) => cell.hit).map((cell) => cell.hitOrdinal),
      [0, 1, 2],
    );
    assert.equal(sampling.cells[1].distance, null);
    assert.deepEqual(sampling.cells[0].position, { x: 1, y: 1, z: 1 });
  });

  test("applyClustering tags the largest cluster as selected and keeps noise", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    const sampled = points(
      [0, 0, 0], [0.1, 0, 0],   // cluster 0 (largest)
      [9, 9, 9],                 // cluster 1
      [50, 50, 50],              // noise
    );
    const report: DBSCANClusterReport = {
      clusters: [[0, 1], [2]],
      noise: [3],
      libraryNoise: [3],
    };
    applyClustering(record, sampled, report, { eps: 0.3, minPts: 2 });
    const clustering = record.clustering!;
    assert.equal(clustering.sampledCount, 4);
    assert.equal(clustering.selectedClusterIndex, 0);
    assert.equal(clustering.clusters[0].isSelected, true);
    assert.equal(clustering.clusters[1].isSelected, false);
    assert.deepEqual(clustering.clusters[0].centroid, { x: 0.05, y: 0, z: 0 });
    assert.deepEqual(clustering.clusters[0].pointIndices, [0, 1]);
    assert.deepEqual([...clustering.noiseIndices], [3]);
    assert.deepEqual(record.failures, []);
  });

  test("largestClusterIndex keeps the earliest cluster on ties", () => {
    assert.equal(largestClusterIndex([[0, 1], [2, 3]]), 0);
    assert.equal(largestClusterIndex([[0], [2, 3]]), 1);
    assert.equal(largestClusterIndex([]), null);
  });

  test("applyClustering records a failure when DBSCAN never ran", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    applyClustering(record, points([0, 0, 0], [1, 1, 1]), null, { eps: 0.3, minPts: 10 });
    const clustering = record.clustering!;
    assert.equal(clustering.clusters.length, 0);
    assert.deepEqual([...clustering.noiseIndices], [0, 1]);
    assert.equal(record.failures[0]?.stage, "clustering");
    assert.match(record.failures[0]?.reason ?? "", /minPts 10/);
  });

  test("applyClustering records a failure when every point is noise", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    applyClustering(record, points([0, 0, 0], [9, 9, 9]), { clusters: [], noise: [0, 1], libraryNoise: [0, 1] }, { eps: 0.3, minPts: 2 });
    assert.equal(record.clustering!.clusters.length, 0);
    assert.equal(record.clustering!.selectedClusterIndex, null);
    assert.equal(record.failures[0]?.stage, "clustering");
    assert.match(record.failures[0]?.reason ?? "", /0 clusters/);
  });

  test("full happy path: measurement, OBB, lift note, anchor, JSON roundtrip", () => {
    const record = createDetectionDiagnostics({ label: "rug", box: [0.1, 0.1, 0.4, 0.4] });
    applySanitize(record, [0.1, 0.1, 0.4, 0.4]);
    applyMeasurement(record, {
      label: "rug",
      dimensions: { width: 2, height: 0.04, depth: 1.4 },
      centroid: new Vector3(1.02, -1.4, 0.87),
      points: [new Vector3(0, 0, 0)],
      box: new Box3(new Vector3(0.02, -1.42, 0.17), new Vector3(2.02, -1.38, 1.57)),
    });
    applyObb(record, {
      obb: new OBB({
        position: new Vector3(1.02, -1.4, 0.87),
        quaternion: new Quaternion(),
        size: new Vector3(2.1, 0.06, 1.5),
      }),
      method: "pca",
      eigenvalues: [3, 1, 0.01],
    });
    applyLift(record, null, "Gaussian highlighter disabled");
    applyAnchor(record, new Vector3(1.02, -1.4, 0.87), "cluster-centroid");
    record.annotationId = "annotation-1";

    assert.deepEqual(record.measurement!.centroid, { x: 1.02, y: -1.4, z: 0.87 });
    assert.equal(record.obb!.method, "pca");
    assert.deepEqual(record.obb!.size, { x: 2.1, y: 0.06, z: 1.5 });
    assert.equal(record.lift, null);
    assert.equal(record.liftNote, "Gaussian highlighter disabled");
    assert.equal(record.anchor!.source, "cluster-centroid");
    assert.deepEqual(record.failures, []);

    // The record contract is plain JSON (no THREE objects, no cycles).
    const parsed = JSON.parse(JSON.stringify(record)) as DetectionDiagnostics;
    assert.deepEqual(parsed.anchor, record.anchor);
    assert.deepEqual(parsed.measurement, record.measurement);
    assert.deepEqual(parsed.obb, record.obb);
  });

  test("applyFailure and summarizeDetection expose the failing stage", () => {
    const request = makeRequest();
    const record = createDetectionDiagnostics({ label: "rug", box: [0.1, 0.1, 0.4, 0.4] });
    applySanitize(record, [0.1, 0.1, 0.4, 0.4]);
    applySampling(record, 6, Array.from({ length: 8 }, (_, i) => makeProbe(Math.floor(i / 6), i % 6, i < 5)));
    applyClustering(record, points([0, 0, 0], [1, 1, 1]), { clusters: [], noise: [0, 1], libraryNoise: [0, 1] }, { eps: 0.3, minPts: 10 });
    applyFailure(record, "anchor", "no fallback position");
    const summary = summarizeDetection(request, record);
    assert.match(summary, /failures=\[clustering, anchor\]/);
    assert.match(summary, /FAILED clustering: DBSCAN found 0 clusters/);
    assert.match(summary, /FAILED anchor: no fallback position/);
    assert.match(summary, /hits 5, misses 3/);
  });

  test("summarizeDetection reports the success path with cluster sizes", () => {
    const request = makeRequest();
    const record = createDetectionDiagnostics({ label: "rug", box: [0.1, 0.1, 0.4, 0.4] });
    applySanitize(record, [0.1, 0.1, 0.4, 0.4]);
    applyClustering(
      record,
      points([0, 0, 0], [0.1, 0, 0], [9, 9, 9], [50, 50, 50]),
      { clusters: [[0, 1], [2]], noise: [3], libraryNoise: [3] },
      { eps: 0.3, minPts: 2 },
    );
    applyAnchor(record, new Vector3(0.05, 0, 0), "cluster-centroid");
    const summary = summarizeDetection(request, record);
    assert.match(summary, /anchor=cluster-centroid/);
    assert.match(summary, /clusters \[0:2 1:1\] noise=1/);
    assert.match(summary, /selected #0/);
  });
});
