import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildEndpoint, makeBoxDetector, makeSegmentFetcher, pickBoxAroundPoint } from "../src/segmentation/client.ts";
import { encodeRle } from "../src/segmentation/maskAnalysis.ts";
import type { SegmentRequest } from "../src/segmentation/contract.ts";
import type { ViewInput } from "../src/segmentation/experiment.ts";

const request: SegmentRequest = {
  image: "data:image/jpeg;base64,ZmFrZQ==",
  imageWidth: 4,
  imageHeight: 2,
  prompts: { points: [{ x: 1, y: 1, label: 1 }] },
};

type Init = { method: string; headers: Record<string, string>; body: string };

describe("buildEndpoint", () => {
  test("follows the production annotate endpoint rules", () => {
    assert.equal(buildEndpoint("/api", "segment"), "/api/segment");
    assert.equal(buildEndpoint("/api/", "annotate"), "/api/annotate");
    assert.equal(buildEndpoint("https://be.example.com", "segment"), "https://be.example.com/api/segment");
    assert.equal(buildEndpoint("https://be.example.com/api/annotate", "segment"), "https://be.example.com/api/segment");
    assert.equal(buildEndpoint("http://localhost:3000/api", "annotate"), "http://localhost:3000/api/annotate");
  });
});

describe("makeSegmentFetcher", () => {
  test("posts the validated request and validates the response", async () => {
    let seen: { url: string; init: Init } | null = null;
    const good = { provider: "p", mock: false, masks: [{ mask: encodeRle(4, 2, new Uint8Array([0, 0, 1, 1, 0, 0, 0, 0])), score: 0.8 }] };
    const fetcher = makeSegmentFetcher("/api/segment", async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => good };
    }, true);
    const response = await fetcher(request);
    assert.equal(response.masks.length, 1);
    assert.equal(seen!.url, "/api/segment");
    assert.equal(seen!.init.headers["bypass-tunnel-reminder"], "true");
    assert.deepEqual(JSON.parse(seen!.init.body), request);
  });

  test("surfaces backend errors with status and message; rejects mis-sized masks; never sends an invalid request", async () => {
    const failing = makeSegmentFetcher("/api/segment", async () => ({ ok: false, status: 501, json: async () => ({ error: "no provider" }) }));
    await assert.rejects(failing(request), /501: no provider/);

    const wrongSize = makeSegmentFetcher("/api/segment", async () => ({
      ok: true, status: 200, json: async () => ({ provider: "p", mock: false, masks: [{ mask: encodeRle(2, 2, new Uint8Array(4)), score: null }] }),
    }));
    await assert.rejects(wrongSize(request), /expected/);

    let called = 0;
    const guarded = makeSegmentFetcher("/api/segment", async () => { called++; return { ok: true, status: 200, json: async () => ({}) }; });
    await assert.rejects(guarded({ ...request, prompts: {} }), /at least one/);
    assert.equal(called, 0);
  });
});

describe("box source", () => {
  test("picks the smallest containing box and converts [ymin,xmin,ymax,xmax] fractions to pixels", () => {
    const box = pickBoxAroundPoint(
      [
        { label: "sofa", box: [0.1, 0.1, 0.9, 0.9] },
        { label: "pillow", box: [0.4, 0.4, 0.6, 0.6] },
        { label: "lamp", box: [0, 0.8, 0.2, 1] },
        { label: "junk", box: [0.5, 0.5] },
      ],
      0.5, 0.5, 1000, 500,
    );
    assert.deepEqual(box, { xmin: 400, ymin: 200, xmax: 600, ymax: 300 });
    assert.equal(pickBoxAroundPoint([{ box: [0, 0, 0.1, 0.1] }], 0.5, 0.5, 10, 10), null);
  });

  test("makeBoxDetector sends the projected anchor as a click and returns the pixel box", async () => {
    let body: Record<string, unknown> = {};
    const detect = makeBoxDetector("/api/annotate", async (_url, init: Init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ objects: [{ label: "pillow", box: [0.4, 0.4, 0.6, 0.6] }] }) };
    });
    const view = { slot: "front", snapshot: { image: { dataUrl: "data:image/jpeg;base64,ZmFrZQ==", width: 1000, height: 500 } } } as unknown as ViewInput;
    const box = await detect(view, { x: 500, y: 250 });
    assert.equal(body.clickX, 0.5);
    assert.equal(body.clickY, 0.5);
    assert.deepEqual(box, { xmin: 400, ymin: 200, xmax: 600, ymax: 300 });
  });
});
