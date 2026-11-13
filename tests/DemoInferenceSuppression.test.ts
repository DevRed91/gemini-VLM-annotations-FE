import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  dispatchGeminiInference,
  isDemoInferenceSuppressed,
} from "../src/utils/inferenceSuppression.ts";
import { createInferenceSeam } from "../src/demo/inferenceSeam.ts";

function makeRequestHarness() {
  let backendRequests = 0;
  const seam = createInferenceSeam({
    fetch: (async () => {
      backendRequests++;
      return new Response(JSON.stringify({ objects: [] }), { status: 200 });
    }) as typeof fetch,
    setTimeout: () => 0,
    clearTimeout: () => {},
    now: () => 0,
    onEvent: () => {},
  });
  return { seam, backendRequestCount: () => backendRequests };
}

describe("demo inference suppression", () => {
  test("requires development demo mode and the explicit inference=off setting", () => {
    assert.equal(isDemoInferenceSuppressed("?demo=1&inference=off", true), true);
    assert.equal(isDemoInferenceSuppressed("?demo=1", true), false);
    assert.equal(isDemoInferenceSuppressed("?inference=off", true), false);
    assert.equal(isDemoInferenceSuppressed("?demo=0&inference=off", true), false);
    assert.equal(isDemoInferenceSuppressed("?demo=1&inference=off", false), false);
  });

  test("a scene click with suppression enabled never starts the Gemini request", async () => {
    const harness = makeRequestHarness();
    const enabled = !isDemoInferenceSuppressed("?demo=1&inference=off", true);
    const sceneClick = () => dispatchGeminiInference(enabled, async () => {
      await harness.seam.fetch("/api/annotate", { method: "POST" });
    });

    await sceneClick();
    await Promise.resolve();
    assert.equal(harness.backendRequestCount(), 0);
    assert.equal(harness.seam.pendingCount(), 0);
  });

  test("demo inference enabled and production URLs retain the existing request path", async () => {
    const harness = makeRequestHarness();
    const enabledByDemo = !isDemoInferenceSuppressed("?demo=1", true);
    const enabledInProduction = !isDemoInferenceSuppressed("", false);
    assert.equal(enabledByDemo, true);
    assert.equal(enabledInProduction, true);

    await dispatchGeminiInference(enabledByDemo, async () => {
      await harness.seam.fetch("/api/annotate", { method: "POST" });
    });
    await dispatchGeminiInference(enabledInProduction, async () => {
      await harness.seam.fetch("/api/annotate", { method: "POST" });
    });
    assert.equal(harness.backendRequestCount(), 2);
  });
});
