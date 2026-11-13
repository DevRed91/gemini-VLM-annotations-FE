import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { RayOverlay, type RayEntry } from "../src/demo/RayOverlay.ts";
import { StageOverlay, recordAtStage } from "../src/demo/StageOverlay.ts";
import { createDetectionDiagnostics } from "../src/diagnostics/records.ts";
import type { DetectionDiagnostics } from "../src/diagnostics/types.ts";

/** Minimal 2D-canvas stand-in so makeTextLabel (browser-only) runs under Node. */
function installFakeDocument(): () => void {
  const context = new Proxy(
    { measureText: (t: string) => ({ width: t.length * 12 }) } as Record<string, unknown>,
    {
      get: (target, key) => (key in target ? target[key as string] : () => {}),
      set: (target, key, value) => {
        target[key as string] = value;
        return true;
      },
    },
  );
  const previous = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  return () => {
    (globalThis as { document?: unknown }).document = previous;
  };
}

/** Track every geometry/material/texture that ever existed under a root, and every dispose() call. */
function trackDisposal() {
  const seen = new Map<string, string>();
  const disposed = new Set<string>();
  const patch = (proto: { dispose: () => void }) => {
    const original = proto.dispose;
    proto.dispose = function (this: { uuid: string }) {
      disposed.add(this.uuid);
      return original.call(this);
    };
    return () => {
      proto.dispose = original;
    };
  };
  const restores = [
    patch(THREE.BufferGeometry.prototype),
    patch(THREE.Material.prototype),
    patch(THREE.Texture.prototype),
  ];
  const sweep = (root: THREE.Object3D) => {
    root.traverse((object) => {
      const item = object as THREE.Mesh;
      if (item.geometry) seen.set(item.geometry.uuid, "geometry");
      const materials = Array.isArray(item.material) ? item.material : item.material ? [item.material] : [];
      for (const material of materials) {
        seen.set(material.uuid, "material");
        const map = (material as THREE.SpriteMaterial).map;
        if (map) seen.set(map.uuid, "texture");
      }
    });
  };
  return {
    sweep,
    leaked: () => [...seen].filter(([uuid]) => !disposed.has(uuid)).map(([uuid, kind]) => `${kind}:${uuid}`),
    seenCount: () => seen.size,
    restore: () => restores.forEach((r) => r()),
  };
}

const entries = (n: number): RayEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    origin: new THREE.Vector3(0, 0, 0),
    direction: new THREE.Vector3(0, 0, -1),
    hit: i % 3 === 0 ? null : new THREE.Vector3(i, 0, -5),
  }));

function fullRecord(): DetectionDiagnostics {
  const record = createDetectionDiagnostics({ label: "rug", box: [0.2, 0.2, 0.6, 0.6] });
  const cell = (row: number, col: number, hitOrdinal: number | null) => ({
    row, col, normalizedX: 0.3 + col * 0.1, normalizedY: 0.3 + row * 0.1, hit: hitOrdinal !== null, hitOrdinal,
    distance: 3, position: hitOrdinal !== null ? { x: col, y: row, z: -3 } : null,
    rayOrigin: { x: 0, y: 0, z: 0 }, rayDirection: { x: 0, y: 0, z: -1 },
  });
  record.sampling = { gridSize: 2, area: 0.16, hitCount: 3, missCount: 1, cells: [cell(0, 0, 0), cell(0, 1, 1), cell(1, 0, 2), cell(1, 1, null)] };
  record.clustering = {
    algorithm: "dbscan", eps: 0.3, minPts: 2, sampledCount: 3,
    clusters: [{ index: 0, size: 3, centroid: { x: 0.3, y: 0.3, z: -3 }, bounds: { min: { x: 0, y: 0, z: -3 }, max: { x: 1, y: 1, z: -3 } }, extent: { x: 1, y: 1, z: 0 }, pointIndices: [0, 1, 2], colorHex: 0x44aaff, isSelected: true }],
    noiseIndices: [], libraryNoiseIndices: [], selectedClusterIndex: 0, selectionRule: "largest",
  };
  record.measurement = { centroid: { x: 0.5, y: 0.5, z: -3 }, dimensions: { width: 1, height: 1, depth: 0.1 }, bounds: { min: { x: 0, y: 0, z: -3 }, max: { x: 1, y: 1, z: -3 } } };
  record.obb = { method: "pca", position: { x: 0.5, y: 0.5, z: -3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, size: { x: 1, y: 1, z: 0.1 }, eigenvalues: [1, 0.5, 0.1] };
  record.lift = { selectedSplats: 42, numSplats: 1000, candidates: 60, opacityRejected: 3, scanDurationMs: 1 };
  record.anchor = { position: { x: 0.5, y: 0.5, z: -3 }, source: "cluster-centroid" };
  return record;
}

describe("demo overlays: resource cleanup", () => {
  let restoreDocument: () => void;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  test("recordAtStage strips later stages without mutating the source", () => {
    const record = fullRecord();
    const s1 = recordAtStage(record, 1);
    assert.ok(s1.sampling && !s1.clustering && !s1.obb && !s1.measurement && !s1.anchor && !s1.lift);
    const s2 = recordAtStage(record, 2);
    assert.ok(s2.clustering && !s2.obb && !s2.measurement);
    const s3 = recordAtStage(record, 3);
    assert.ok(s3.clustering && s3.obb && s3.measurement && !s3.anchor);
    assert.ok(record.obb && record.anchor && record.lift, "source untouched");
  });

  test("50 capture/reset cycles dispose every snapshot-ray resource", () => {
    const tracker = trackDisposal();
    try {
      const scene = new THREE.Scene();
      const overlay = new RayOverlay(9, () => {});
      scene.add(overlay.group);
      tracker.sweep(overlay.group);
      for (let cycle = 0; cycle < 50; cycle++) {
        overlay.setSnapshotRays(entries(9), new THREE.Vector3(cycle, 0, 0)); // "capture"
        tracker.sweep(overlay.group);
        overlay.updateLive(entries(9));
        overlay.clearSnapshotRays(); // "reset"
        overlay.updateLive([]);
        assert.equal(overlay.hasSnapshotRays(), false);
      }
      // Only the long-lived live objects remain in the group.
      assert.equal(overlay.group.children.length, 4);
      overlay.dispose();
      assert.equal(scene.children.length, 0, "group removed from scene");
      assert.deepEqual(tracker.leaked(), []);
      assert.ok(tracker.seenCount() > 100, "the test actually exercised many resources");
    } finally {
      tracker.restore();
    }
  });

  test("replacing snapshot rays disposes the previous set immediately", () => {
    const tracker = trackDisposal();
    try {
      const overlay = new RayOverlay(9, () => {});
      overlay.setSnapshotRays(entries(9), new THREE.Vector3());
      tracker.sweep(overlay.group);
      const firstCount = tracker.seenCount();
      overlay.setSnapshotRays(entries(9), new THREE.Vector3(1, 0, 0));
      // The first snapshot-ray set is gone; only the four long-lived live
      // objects (segments, points, label, tick) may still be undisposed. The
      // second set was never swept, so it is not counted here.
      const undisposed = tracker.leaked();
      assert.ok(firstCount > 0);
      assert.ok(undisposed.length <= 9, `only long-lived live resources may remain, got ${undisposed.length}`);
      overlay.dispose();
      assert.deepEqual(tracker.leaked(), []);
    } finally {
      tracker.restore();
    }
  });

  test("live buffers are updated in place (no reallocation per frame)", () => {
    const overlay = new RayOverlay(9, () => {});
    const segments = overlay.group.children.find((c) => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments;
    const attribute = segments.geometry.getAttribute("position");
    const array = attribute.array;
    for (let frame = 0; frame < 200; frame++) overlay.updateLive(entries(9));
    assert.equal(segments.geometry.getAttribute("position"), attribute);
    assert.equal(segments.geometry.getAttribute("position").array, array);
    overlay.dispose();
  });

  test("stage overlay: cycling and re-recording 50 times leaves nothing undisposed", () => {
    const tracker = trackDisposal();
    try {
      const stages = new StageOverlay();
      const record = fullRecord();
      for (let i = 0; i < 50; i++) {
        stages.setRecordIfChanged(record);
        for (let step = 0; step < 4; step++) {
          stages.cycle();
          tracker.sweep(stages.group);
        }
        stages.clear(); // "reset"
        assert.equal(stages.group.children.length, 0);
      }
      assert.equal(stages.stage(), 0);
      stages.dispose();
      assert.deepEqual(tracker.leaked(), []);
      assert.ok(tracker.seenCount() > 100);
    } finally {
      tracker.restore();
    }
  });

  test("setRecordIfChanged does not rebuild when nothing changed", () => {
    const stages = new StageOverlay();
    const record = fullRecord();
    stages.setRecord(record);
    stages.setStage(3);
    const built = stages.group.children[0];
    stages.setRecordIfChanged(record);
    stages.setRecordIfChanged(record);
    assert.equal(stages.group.children[0], built);
    stages.dispose();
  });

  test("tick callback fires from onBeforeRender and stops after dispose", () => {
    let ticks = 0;
    const overlay = new RayOverlay(9, () => { ticks++; });
    // The live-hit Points object is also Points; exactly one carries the tick hook.
    const hooked = overlay.group.children.filter((c) => (c as THREE.Points).isPoints) as THREE.Points[];
    for (const item of hooked) (item.onBeforeRender as unknown as () => void)();
    assert.equal(ticks, 1, "exactly one Points object carries the tick");
    overlay.dispose();
    for (const item of hooked) (item.onBeforeRender as unknown as () => void)();
    assert.equal(ticks, 1, "no ticks after dispose");
  });
});
