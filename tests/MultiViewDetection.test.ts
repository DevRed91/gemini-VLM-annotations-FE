import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBudgetedMultiViewBody,
  buildCameraPayload,
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

function capture(slot: "front" | "side" | "top", id = `capture-${slot}`, width = 800, height = 600): PresentationCapture {
  const snapshot = {
    id,
    worldGeneration: 3,
    image: { dataUrl: `data:image/jpeg;base64,${slot}`, mimeType: "image/jpeg", width, height },
    camera: { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, worldMatrix: [], inverseWorldMatrix: [], projectionMatrix: [], projectionKind: "perspective" as const },
    viewport: { rect: { left: 0, top: 0, width, height }, cssWidth: width, cssHeight: height, drawingBufferWidth: width, drawingBufferHeight: height, devicePixelRatio: 1 },
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
  assert.deepEqual(selected?.peerDetections.map((peer) => peer.id), ["object_01"]);
  assert.notEqual(selected?.peerDetections[0], undefined);
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

test("sends all views in fixed order with capture and camera metadata and parses the response", async () => {
  const payloads: unknown[] = [];
  const captures = [capture("front"), capture("side"), capture("top")];
  const result = await requestMultiViewDetections("/api/detect-multiview", captures, { "bypass-tunnel-reminder": "true" }, {
    fetch: (async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)?.["bypass-tunnel-reminder"], "true");
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ objects: [detection] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch,
    log: () => {},
  });
  const sent = payloads[0] as { views: Array<Record<string, unknown>> };
  assert.deepEqual(sent?.views.map((view) => view.view), ["front", "side", "top"]);
  assert.deepEqual(sent?.views.map((view) => view.snapshotId), captures.map((item) => item.snapshot.id));
  assert.equal(sent?.views[0].imageWidth, 800);
  assert.deepEqual((sent?.views[0].camera as { position: number[] }).position, [1, 2, 3]);
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
  await assert.rejects(requestMultiViewDetections("/api/detect-multiview", captures, {}, { fetch: fetchImpl, log: () => {} }), /Gemini unavailable/);
  assert.equal((await requestMultiViewDetections("/api/detect-multiview", captures, {}, { fetch: fetchImpl, log: () => {} })).length, 0);
  assert.equal(attempt, 2);
  assert.equal(captures.length, 3);
});

function perspectiveMatrix(fovYDeg: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const m = new Array<number>(16).fill(0);
  m[0] = f / aspect; m[5] = f; m[10] = -(far + near) / (far - near); m[11] = -1; m[14] = -(2 * far * near) / (far - near);
  return m;
}

test("builds compact camera metadata from the snapshot instead of raw matrices", () => {
  const item = capture("front");
  const snapshot = {
    ...item.snapshot,
    camera: { ...item.snapshot.camera, projectionMatrix: perspectiveMatrix(60, 4 / 3, 0.1, 1000) },
    splat: { matrixWorld: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, -1.5, 0, 1] },
  } as unknown as PresentationCapture["snapshot"];
  const camera = buildCameraPayload(snapshot);
  assert.deepEqual(camera.projection, { kind: "perspective", fovYDegrees: 60, aspect: 1.3333, near: 0.1, far: 1000 });
  assert.deepEqual(camera.splat?.position, [0, -1.5, 0]);
  assert.deepEqual(camera.splat?.scale, [1, 1, 1]);
  assert.equal(Math.abs(Math.abs(camera.splat!.orientation[0]) - 1) < 1e-4, true);
  assert.equal(JSON.stringify(camera).includes("worldMatrix"), false);
});

const fakeJpeg = (chars: number) => `data:image/jpeg;base64,${"A".repeat(chars)}`;

test("re-encodes bounded request copies, keeps aspect ratio and leaves the original snapshots untouched", async () => {
  const captures = [capture("front", "a", 2000, 1500), capture("side", "b", 2000, 1500), capture("top", "c", 2000, 1500)];
  const originals = captures.map((item) => item.snapshot.image.dataUrl);
  const calls: Array<[number, number, number]> = [];
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  let sentBody = "";
  await requestMultiViewDetections("/api/detect-multiview", captures, {}, {
    loadImage: async () => ({
      encodeJpeg: (w, h, q) => { calls.push([w, h, q]); return fakeJpeg(Math.floor(w * h * q)); },
      dispose() {},
    }),
    log: (message, details) => logs.push({ message, details }),
    fetch: (async (_input, init) => {
      sentBody = String(init?.body);
      return new Response(JSON.stringify({ objects: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual(calls[0], [2000, 1500, 0.85]);
  const sent = JSON.parse(sentBody) as { views: Array<{ imageWidth: number; imageHeight: number }> };
  assert.deepEqual([sent.views[0].imageWidth, sent.views[0].imageHeight], [1700, 1275]);
  assert.ok(new TextEncoder().encode(sentBody).byteLength <= 4_800_000);
  assert.deepEqual(captures.map((item) => item.snapshot.image.dataUrl), originals);
  assert.equal(captures[0].snapshot.image.width, 2000);
  const { details } = logs[0];
  assert.equal(details.bodyBytes, new TextEncoder().encode(sentBody).byteLength);
  assert.deepEqual(details.order, ["front", "side", "top"]);
  assert.deepEqual((details.views as Array<Record<string, unknown>>)[0], {
    view: "front", width: 1700, height: 1275, mimeType: "image/jpeg", base64Chars: 1700 * 1275 * 0.65, decodedImageBytes: Math.floor((1700 * 1275 * 0.65 * 3) / 4),
  });
  assert.equal(JSON.stringify(details).includes("AAAA"), false);
});

test("fails with a descriptive client-side error and never calls fetch when the payload cannot fit", async () => {
  const captures = [capture("front"), capture("side"), capture("top")];
  let fetched = false;
  await assert.rejects(requestMultiViewDetections("/api/detect-multiview", captures, {}, {
    loadImage: async () => ({ encodeJpeg: () => fakeJpeg(3_000_000), dispose() {} }),
    log: () => {},
    fetch: (async () => { fetched = true; return new Response("{}"); }) as typeof fetch,
  }), /still \d+\.\d+ MB after downscaling to \d+x\d+ at JPEG quality 0\.65; the limit is 4\.80 MB/);
  assert.equal(fetched, false);
});

test("without a canvas it sends the original images when they fit and rejects when they do not", async () => {
  const small = [capture("front"), capture("side"), capture("top")];
  const ok = await buildBudgetedMultiViewBody(small, { loadImage: null });
  assert.equal(ok.body.views[0].image, small[0].snapshot.image.dataUrl);
  const huge = small.map((item) => ({ ...item, snapshot: { ...item.snapshot, image: { ...item.snapshot.image, dataUrl: fakeJpeg(2_000_000) } } })) as PresentationCapture[];
  await assert.rejects(buildBudgetedMultiViewBody(huge, { loadImage: null }), /cannot be re-encoded/);
});
