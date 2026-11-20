import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { buildLifterViewsFromSelection, buildPeerLifterViewsFromSelection } from "../src/demo/multiViewToLifterViews.ts";
import type { SelectedMultiViewObject } from "../src/demo/multiViewDetection.ts";
import type { PresentationCapture } from "../src/demo/presentationCaptures.ts";
import { obbTopSurfaceCenter } from "../src/utils/obbFit.ts";
import { OBB } from "../src/utils/obb.ts";

function selection(): SelectedMultiViewObject {
  const captures = (["front", "side", "top"] as const).map((slot) => ({
    id: `capture-${slot}`,
    slot,
    capturedAtMs: 1,
    capturedAtIso: new Date(1).toISOString(),
    snapshot: { id: `snapshot-${slot}`, worldGeneration: 3 },
  })) as unknown as PresentationCapture[];
  return {
    objectId: "main-table",
    label: "Main table",
    description: "The table",
    observations: [
      { view: "front", visible: true, box: { xMin: 0.1, yMin: 0.2, xMax: 0.7, yMax: 0.8 } },
      { view: "side", visible: false, box: null },
      { view: "top", visible: true, box: { xMin: 0.25, yMin: 0.3, xMax: 0.6, yMax: 0.9 } },
    ],
    peerDetections: [{
      id: "chair-1",
      label: "Chair",
      description: "A chair beside the table.",
      observations: [
        { view: "front", visible: true, box: { xMin: 0.4, yMin: 0.3, xMax: 0.55, yMax: 0.65 } },
        { view: "top", visible: true, box: { xMin: 0.42, yMin: 0.38, xMax: 0.57, yMax: 0.7 } },
      ],
    }],
    captures,
    confirmedAtIso: new Date(2).toISOString(),
  };
}

describe("multi-view selection to Gaussian lifter mapping", () => {
  test("pairs each frozen snapshot with its box and converts to [ymin, xmin, ymax, xmax]", () => {
    const selected = selection();
    const views = buildLifterViewsFromSelection(selected);
    assert.deepEqual(views.map((view) => view.view), ["front", "side", "top"]);
    assert.deepEqual(views.map((view) => view.visible), [true, false, true]);
    assert.deepEqual(views[0].bboxNormalized, [0.2, 0.1, 0.8, 0.7]);
    assert.equal(views[1].bboxNormalized, undefined);
    assert.deepEqual(views[2].bboxNormalized, [0.3, 0.25, 0.9, 0.6]);
    assert.equal(views[0].snapshot, selected.captures[0].snapshot);
    assert.equal(views[2].snapshot, selected.captures[2].snapshot);
  });

  test("maps peer boxes to the same frozen capture slots without changing target views", () => {
    const selected = selection();
    const target = buildLifterViewsFromSelection(selected);
    const peers = buildPeerLifterViewsFromSelection(selected);
    assert.deepEqual(peers.map(({ objectId, view, visible, bboxNormalized }) => ({ objectId, view, visible, bboxNormalized })), [
      { objectId: "chair-1", view: "front", visible: true, bboxNormalized: [0.3, 0.4, 0.65, 0.55] },
      { objectId: "chair-1", view: "side", visible: false, bboxNormalized: undefined },
      { objectId: "chair-1", view: "top", visible: true, bboxNormalized: [0.38, 0.42, 0.7, 0.57] },
    ]);
    assert.deepEqual(peers.map((peer) => peer.snapshot), selected.captures.map((capture) => capture.snapshot));
    assert.deepEqual(buildLifterViewsFromSelection(selected), target);
  });

  test("places an annotation anchor on the upper OBB face", () => {
    const obb = new OBB({
      position: new THREE.Vector3(2, 3, 4),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
      size: new THREE.Vector3(2, 1.5, 3),
    });
    const anchor = obbTopSurfaceCenter(obb);
    const local = anchor.clone().sub(obb.position).applyQuaternion(obb.quaternion.clone().invert());
    assert.ok(Math.abs(local.y - obb.size.y / 2) < 1e-6);
    assert.ok(Math.abs(local.x) < 1e-6 && Math.abs(local.z) < 1e-6);
  });
});
