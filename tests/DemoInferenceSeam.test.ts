import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createInferenceSeam,
  isAnnotateUrl,
  type InferenceEvent,
} from "../src/demo/inferenceSeam.ts";

/** Manual clock: timers fire only when the test advances time. */
function makeHarness(initial: Parameters<typeof createInferenceSeam>[1] = {}) {
  let clock = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const events: InferenceEvent[] = [];
  const calls: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ objects: [{ label: "lamp", box: [0.1, 0.2, 0.3, 0.4] }] }), { status: 200 });
  }) as typeof fetch;
  const seam = createInferenceSeam(
    {
      fetch: fakeFetch,
      setTimeout: (fn, ms) => {
        const handle = nextHandle++;
        timers.set(handle, { at: clock + ms, fn });
        return handle;
      },
      clearTimeout: (handle) => void timers.delete(handle as number),
      now: () => clock,
      onEvent: (event) => events.push(event),
    },
    initial,
  );
  const advance = (ms: number) => {
    clock += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(handle);
        timer.fn();
      }
    }
  };
  return { seam, events, calls, timers, advance };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("isAnnotateUrl", () => {
  test("matches /annotate only", () => {
    assert.ok(isAnnotateUrl("/api/annotate"));
    assert.ok(isAnnotateUrl("https://x.example/api/annotate?x=1"));
    assert.ok(isAnnotateUrl(new URL("https://x.example/api/annotate/")));
    assert.ok(!isAnnotateUrl("/api/annotate-other"));
    assert.ok(!isAnnotateUrl("/office_space.sog"));
    assert.ok(!isAnnotateUrl(42));
  });
});

describe("inference seam", () => {
  test("non-annotate requests pass through untouched and emit nothing", async () => {
    const h = makeHarness({ mode: 3 });
    await h.seam.fetch("/something/else");
    assert.deepEqual(h.calls, ["/something/else"]);
    assert.equal(h.events.length, 0);
  });

  test("mode 1 returns the real response immediately", async () => {
    const h = makeHarness({ mode: 1 });
    const response = await h.seam.fetch("/api/annotate", { method: "POST" });
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
    // The caller can still read the body even though the seam read a clone.
    assert.deepEqual(await response.json(), { objects: [{ label: "lamp", box: [0.1, 0.2, 0.3, 0.4] }] });
    const response1 = h.events.find((e) => e.type === "response");
    assert.ok(response1 && response1.type === "response" && !response1.synthetic);
    assert.deepEqual(response1.detections, [{ label: "lamp", box: [0.1, 0.2, 0.3, 0.4] }]);
  });

  test("mode 2 holds the real response until the delay elapses", async () => {
    const h = makeHarness({ mode: 2, delayMs: 4000 });
    let settled = false;
    const pending = h.seam.fetch("/api/annotate").then((r) => { settled = true; return r; });
    await flush();
    assert.equal(h.calls.length, 1, "real request is made");
    assert.equal(settled, false);
    assert.equal(h.seam.pendingCount(), 1);
    h.advance(3999);
    await flush();
    assert.equal(settled, false, "still held just before the deadline");
    h.advance(1);
    await pending;
    assert.equal(settled, true);
    assert.equal(h.seam.pendingCount(), 0);
    const released = h.events.find((e) => e.type === "released");
    assert.ok(released && released.type === "released" && released.heldMs === 4000);
  });

  test("mode 3 makes no network call and returns the scripted box", async () => {
    const h = makeHarness({ mode: 3, handBox: [0.35, 0.4, 0.65, 0.6], handLabel: "rug" });
    const response = await h.seam.fetch("/api/annotate");
    assert.equal(h.calls.length, 0);
    assert.deepEqual(await response.json(), {
      objects: [{ label: "rug", description: "hand-specified box (demo)", box: [0.35, 0.4, 0.65, 0.6] }],
    });
    const event = h.events.find((e) => e.type === "response");
    assert.ok(event && event.type === "response" && event.synthetic && event.latencyMs === 0);
  });

  test("cancelPending rejects held requests with AbortError and clears timers", async () => {
    const h = makeHarness({ mode: 2, delayMs: 10_000 });
    const pending = h.seam.fetch("/api/annotate");
    const outcome = pending.then(() => "resolved", (e: Error) => e.name);
    await flush();
    assert.equal(h.seam.cancelPending(), 1);
    assert.equal(await outcome, "AbortError");
    assert.equal(h.timers.size, 0);
    assert.equal(h.seam.pendingCount(), 0);
    assert.ok(h.events.some((e) => e.type === "cancelled"));
    assert.equal(h.seam.cancelPending(), 0, "idempotent");
  });

  test("repeated hold/cancel cycles leave no timers behind", async () => {
    const h = makeHarness({ mode: 2, delayMs: 5000 });
    for (let i = 0; i < 25; i++) {
      const outcome = h.seam.fetch("/api/annotate").then(() => "ok", () => "aborted");
      await flush();
      h.seam.cancelPending();
      assert.equal(await outcome, "aborted");
    }
    assert.equal(h.timers.size, 0);
    assert.equal(h.seam.pendingCount(), 0);
  });

  test("a failing network request surfaces as an error event and rethrows", async () => {
    const events: InferenceEvent[] = [];
    const seam = createInferenceSeam({
      fetch: (async () => { throw new TypeError("network down"); }) as typeof fetch,
      setTimeout: () => 0,
      clearTimeout: () => {},
      now: () => 0,
      onEvent: (e) => events.push(e),
    }, { mode: 1 });
    await assert.rejects(seam.fetch("/api/annotate"), /network down/);
    assert.ok(events.some((e) => e.type === "error" && e.message === "network down"));
  });

  test("update validates mode and delay; config() returns a copy", () => {
    const h = makeHarness();
    assert.throws(() => h.seam.update({ mode: 4 as never }), RangeError);
    assert.throws(() => h.seam.update({ delayMs: -1 }), RangeError);
    assert.throws(() => h.seam.update({ delayMs: Number.NaN }), RangeError);
    h.seam.update({ mode: 2, delayMs: 1500 });
    const cfg = h.seam.config();
    (cfg.handBox as unknown as number[])[0] = 0.99;
    assert.equal(h.seam.config().handBox[0], 0.35);
    assert.equal(h.seam.config().mode, 2);
  });
});
