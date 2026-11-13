import assert from "node:assert/strict";
import test from "node:test";
import {
  detectionBoxStyle,
  MultiViewDetectionWorkflow,
  observationForView,
  parseMultiViewDetectionResponse,
  requestMultiViewDetections,
} from "../src/demo/multiViewDetection.ts";
import type { PresentationCapture } from "../src/demo/presentationCaptures.ts";

const box = { xMin: 0.2, yMin: 0.1, xMax: 0.6, yMax: 0.8 };
const detection = {
  id: "object_01",
  label: "Patterned cushion",
  description: "Black and white cushion on the sofa.",
  observations: [
    { view: "front", visible: true, box },
    { view: "side", visible: false, box: null },
    { view: "top", visible: true, box: { xMin: 0.4, yMin: 0.2, xMax: 0.7, yMax: 0.5 } },
  ],
};

function capture(slot: "front" | "side" | "top", id = `capture-${slot}`): PresentationCapture {
  const snapshot = {
    id,
    worldGeneration: 3,
    image: { dataUrl: `data:image/jpeg;base64,${slot}`, mimeType: "image/jpeg", width: 800, height: 600 },
    camera: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, worldMatrix: [], inverseWorldMatrix: [], projectionMatrix: [], projectionKind: "perspective" as const },
    viewport: { rect: { left: 0, top: 0, width: 800, height: 600 }, cssWidth: 800, cssHeight: 600, drawingBufferWidth: 800, drawingBufferHeight: 600, devicePixelRatio: 1 },
    splat: null,
  };
  return { id, slot, capturedAtMs: 123, capturedAtIso: new Date(123).toISOString(), snapshot } as unknown as PresentationCapture;
}

test("parses valid detections, empty responses and explicit missing observations", () => {
  const result = parseMultiViewDetectionResponse({ objects: [detection] });
  assert.equal(result[0].id, "object_01");
  assert.equal(result[0].observations[1].visible, false);
  assert.equal(result[0].observations[1].box, null);
  assert.deepEqual(parseMultiViewDetectionResponse({ objects: [] }), []);
  assert.equal(parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [detection.observations[0]] }] }).length, 1);
});

test("rejects malformed boxes, duplicate IDs, duplicate views and invalid missing observations", () => {
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [{ view: "front", visible: true, box: { ...box, xMax: 1.2 } }] }] }), /bounding box/);
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [detection, detection] }), /duplicate object id/);
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [detection.observations[0], detection.observations[0]] }] }), /invalid observation/);
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [{ view: "side", visible: false, box }] }] }), /invisible observation/);
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [{ view: "front", visible: true, box: { ...box, xMin: 0.6 } }] }] }), /bounding box/);
  assert.throws(() => parseMultiViewDetectionResponse({ objects: [{ ...detection, observations: [{ view: "front", visible: false, box: null }] }] }), /no visible detection/);
});

test("maps normalized boxes to percentages of the original image element", () => {
  assert.deepEqual(detectionBoxStyle(box), { left: "20%", top: "10%", width: "40%", height: "70%" });
  assert.equal(observationForView(parseMultiViewDetectionResponse({ objects: [detection] })[0], "side")?.visible, false);
});

test("workflow gates sending, blocks duplicate submissions, and retries after failure without losing captures", () => {
  const workflow = new MultiViewDetectionWorkflow();
  const captures = [capture("front"), capture("side"), capture("top")];
  assert.equal(workflow.canSend([captures[0], null, captures[2]]), false);
  assert.equal(workflow.canSend(captures), true);
  const firstRequest = workflow.beginRequest();
  assert.notEqual(firstRequest, null);
  assert.equal(workflow.state().detectionLoading, true);
  assert.equal(workflow.beginRequest(), null);
  assert.equal(workflow.rejectRequest(firstRequest!, "Gemini unavailable"), true);
  assert.equal(workflow.state().detectionLoading, false);
  assert.equal(workflow.state().detectionError, "Gemini unavailable");
  assert.equal(captures.length, 3);
  const retry = workflow.beginRequest();
  assert.notEqual(retry, null);
  assert.equal(workflow.resolveRequest(retry!, []), true);
  assert.equal(workflow.state().reviewOpen, true);
  workflow.closeReview();
  assert.equal(workflow.state().reviewOpen, false);
  workflow.openReview();
  assert.equal(workflow.state().reviewOpen, true, "a successful empty result can be reopened without another request");
});

test("review requires explicit selection, supports switching, and preserves the selected captures on confirmation", () => {
  const workflow = new MultiViewDetectionWorkflow();
  const captures = [capture("front"), capture("side"), capture("top")];
  const objects = parseMultiViewDetectionResponse({ objects: [
    detection,
    { ...detection, id: "object_02", label: "Brown cushion", observations: [{ view: "front", visible: true, box }] },
  ] });
  const request = workflow.beginRequest()!;
  workflow.resolveRequest(request, objects);
  assert.equal(workflow.state().selectedObjectId, null, "the first object is not selected automatically");
  assert.equal(workflow.confirm(captures), null);
  assert.equal(workflow.select("object_01"), true);
  assert.equal(workflow.select("object_02"), true);
  const selected = workflow.confirm(captures, "2026-11-13T10:00:00.000Z");
  assert.equal(selected?.objectId, "object_02");
  assert.equal(selected?.captures.length, 3);
  assert.equal(selected?.captures[0].snapshot.id, captures[0].snapshot.id);
  assert.equal(selected?.captures[0].snapshot.camera.position.x, 1);
  assert.equal(selected?.captures[1].capturedAtIso, captures[1].capturedAtIso);
  assert.equal(workflow.state().selectionConfirmed, true);
});

test("recapturing invalidates stale in-flight detections", () => {
  const workflow = new MultiViewDetectionWorkflow();
  const request = workflow.beginRequest()!;
  workflow.invalidate();
  assert.equal(workflow.resolveRequest(request, parseMultiViewDetectionResponse({ objects: [detection] })), false);
  assert.equal(workflow.state().detections.length, 0);
  assert.equal(workflow.state().detectionLoading, false);
});

test("sends all views in fixed order with only useful capture metadata and parses the response", async () => {
  const payloads: unknown[] = [];
  const captures = [capture("front"), capture("side"), capture("top")];
  const result = await requestMultiViewDetections("/api/detect-multiview", captures, { "bypass-tunnel-reminder": "true" }, {
    fetch: (async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)?.["bypass-tunnel-reminder"], "true");
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ objects: [detection] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
  });
  const sent = payloads[0] as { views: Array<Record<string, unknown>> };
  assert.deepEqual(sent?.views.map((view) => view.view), ["front", "side", "top"]);
  assert.deepEqual(sent?.views.map((view) => view.snapshotId), captures.map((item) => item.snapshot.id));
  assert.equal(sent?.views[0].imageWidth, 800);
  assert.equal("camera" in (sent?.views[0] ?? {}), false);
  assert.equal(result[0].label, "Patterned cushion");
});

test("surfaces backend errors and permits a retry with the same preserved captures", async () => {
  const captures = [capture("front"), capture("side"), capture("top")];
  let attempt = 0;
  const fetchImpl = (async () => {
    attempt++;
    if (attempt === 1) return new Response(JSON.stringify({ error: "Gemini unavailable" }), { status: 502 });
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(requestMultiViewDetections("/api/detect-multiview", captures, {}, { fetch: fetchImpl }), /Gemini unavailable/);
  assert.equal((await requestMultiViewDetections("/api/detect-multiview", captures, {}, { fetch: fetchImpl })).length, 0);
  assert.equal(attempt, 2);
  assert.equal(captures.length, 3);
});
