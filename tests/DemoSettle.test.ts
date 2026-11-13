import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTLE_CONFIG,
  INITIAL_SETTLE_STATE,
  SettleDetector,
  poseChange,
  quaternionAngle,
  stepSettle,
  type CameraSample,
} from "../src/demo/settle.ts";
import { SettledMeasurer, type CastResult } from "../src/demo/settledMeasurement.ts";
import { splatRaycastReadiness } from "../src/demo/readiness.ts";

const IDENTITY: CameraSample["quaternion"] = [0, 0, 0, 1];
const pose = (over: Partial<CameraSample> = {}): CameraSample => ({
  position: [0, 0, -3],
  quaternion: IDENTITY,
  fov: 60,
  aspect: 1.5,
  zoom: 1,
  near: 0.01,
  far: 1000,
  ...over,
});
const yaw = (rad: number): CameraSample["quaternion"] => [0, Math.sin(rad / 2), 0, Math.cos(rad / 2)];

describe("settle detection (pure)", () => {
  test("first sample only anchors; a stable camera settles exactly once after 300 ms", () => {
    const d = new SettleDetector();
    const events: string[] = [];
    for (let t = 0; t <= 1000; t += 16) events.push(d.update(pose(), t));
    assert.equal(events.filter((e) => e === "settled").length, 1);
    assert.equal(events.filter((e) => e === "moved").length, 0);
    // Not before the stability duration.
    const first = events.indexOf("settled");
    assert.ok(first * 16 >= 300 && (first - 1) * 16 < 300);
    assert.equal(d.isSettled(), true);
  });

  test("position change is movement and restarts the stability window", () => {
    const d = new SettleDetector();
    d.update(pose(), 0);
    assert.equal(d.update(pose({ position: [0.01, 0, -3] }), 100), "moved");
    assert.equal(d.isSettled(), false);
    assert.equal(d.update(pose({ position: [0.01, 0, -3] }), 350), "none"); // only 250 ms stable
    assert.equal(d.update(pose({ position: [0.01, 0, -3] }), 400), "settled");
  });

  test("orientation change is movement", () => {
    const d = new SettleDetector();
    d.update(pose(), 0);
    assert.equal(d.update(pose({ quaternion: yaw(0.01) }), 16), "moved");
  });

  test("q and -q are the same orientation (no spurious movement)", () => {
    const q = yaw(0.3);
    const neg: CameraSample["quaternion"] = [-q[0], -q[1], -q[2], -q[3]];
    assert.ok(quaternionAngle(q, neg) < 1e-9);
    const d = new SettleDetector();
    d.update(pose({ quaternion: q }), 0);
    assert.equal(d.update(pose({ quaternion: neg }), 16), "none");
  });

  test("camera configuration (fov / aspect / zoom) counts as movement", () => {
    for (const change of [{ fov: 61 }, { aspect: 1.6 }, { zoom: 1.2 }, { near: 0.02 }]) {
      const d = new SettleDetector();
      d.update(pose(), 0);
      assert.equal(d.update(pose(change), 16), "moved", JSON.stringify(change));
    }
  });

  test("sub-threshold float jitter never counts as movement", () => {
    const d = new SettleDetector();
    d.update(pose(), 0);
    let moved = 0;
    let settled = 0;
    for (let t = 16; t <= 2000; t += 16) {
      const e = (Math.sin(t) * 0.5) * 1e-6;
      const ev = d.update(pose({ position: [e, -e, -3 + e], quaternion: yaw(e), fov: 60 + e * 1e-3 }), t);
      if (ev === "moved") moved++;
      if (ev === "settled") settled++;
    }
    assert.equal(moved, 0);
    assert.equal(settled, 1);
  });

  test("slow drift is measured against the anchor, so it accumulates into movement", () => {
    const d = new SettleDetector();
    d.update(pose(), 0);
    let moved = false;
    // 2e-5 m per frame is below the 1e-4 tolerance per frame, but not cumulatively.
    for (let i = 1; i <= 20; i++) {
      if (d.update(pose({ position: [i * 2e-5, 0, -3] }), i * 16) === "moved") moved = true;
    }
    assert.equal(moved, true);
  });

  test("NaN samples are treated as movement, never as stable", () => {
    const d = new SettleDetector();
    d.update(pose(), 0);
    assert.equal(d.update(pose({ position: [Number.NaN, 0, 0] }), 16), "moved");
  });

  test("reset forgets the anchor; repeated settle cycles each fire once", () => {
    const d = new SettleDetector();
    let settles = 0;
    let t = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      const at = pose({ position: [cycle, 0, -3] });
      for (let i = 0; i < 40; i++, t += 16) if (d.update(at, t) === "settled") settles++;
    }
    assert.equal(settles, 5);
    d.reset();
    assert.equal(d.isSettled(), false);
    assert.equal(d.update(pose(), t), "none"); // first sample after reset only anchors
  });

  test("stepSettle is pure: it never mutates its input state", () => {
    const state = Object.freeze({ ...INITIAL_SETTLE_STATE });
    const a = stepSettle(state, pose(), 0);
    assert.equal(state.anchor, null);
    const frozen = Object.freeze({ ...a.state });
    stepSettle(frozen, pose({ position: [5, 0, 0] }), 10);
    assert.equal(frozen.fired, false);
    assert.equal(poseChange(pose(), pose()).position, 0);
    assert.equal(DEFAULT_SETTLE_CONFIG.stableMs, 300);
  });
});

/** Drives a SettledMeasurer with a fake clock/camera and counts splat casts. */
function harness(options: { ready?: boolean; helpers?: number } = {}) {
  const state = { t: 0, pose: pose(), ready: options.ready ?? true, helpers: options.helpers ?? 0, casts: 0, castCost: 35 };
  const measurer = new SettledMeasurer({
    sample: () => state.pose,
    isReady: () => state.ready,
    cast: (x, y): CastResult => {
      state.casts++;
      state.t += state.castCost; // each cast "costs" 35 ms on the fake clock
      return { origin: [0, 0, -3], direction: [x, y, -1], hit: [x, y, -5] };
    },
    nowMs: () => state.t,
    wallClockIso: () => new Date(1_700_000_000_000 + state.t).toISOString(),
    helperCount: () => state.helpers,
  });
  const cells = Array.from({ length: 9 }, (_, i) => ({ x: 0.3 + (i % 3) * 0.1, y: 0.3 + Math.floor(i / 3) * 0.1 }));
  const frame = (ms = 16) => {
    state.t += ms;
    measurer.tick();
  };
  const move = (x: number) => {
    state.pose = pose({ position: [x, 0, -3] });
  };
  const run = (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 16) frame();
  };
  return { state, measurer, cells, frame, move, run };
}

describe("settled nine-ray measurement: cast counts", () => {
  test("zero casts while the camera keeps moving", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    for (let i = 0; i < 300; i++) {
      h.move(i * 0.01);
      h.frame();
    }
    assert.equal(h.state.casts, 0);
    assert.equal(h.measurer.latest(), null);
    assert.equal(h.measurer.status(), "waiting-for-camera");
  });

  test("exactly nine casts after settling, none while stationary, nine more after the next settle", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    h.run(200);
    assert.equal(h.state.casts, 0, "still inside the 300 ms window");
    h.run(300);
    assert.equal(h.state.casts, 9);
    h.run(5000);
    assert.equal(h.state.casts, 9, "no repeats while stationary");

    h.move(1);
    for (let i = 0; i < 30; i++) {
      h.move(1 + i * 0.01);
      h.frame();
    }
    assert.equal(h.state.casts, 9, "moving again: still nothing new");
    h.run(600);
    assert.equal(h.state.casts, 18, "one new set of nine");
    h.run(3000);
    assert.equal(h.state.casts, 18);
    assert.equal(h.measurer.castCount(), 18);
  });

  test("each of the nine cells is cast once, in order", () => {
    const h = harness();
    const seen: Array<[number, number]> = [];
    const measurer = new SettledMeasurer({
      sample: () => h.state.pose,
      isReady: () => true,
      cast: (x, y) => {
        seen.push([x, y]);
        return null;
      },
      nowMs: () => h.state.t,
      wallClockIso: () => "t",
      helperCount: () => 0,
    });
    measurer.setCells(h.cells);
    for (let i = 0; i < 40; i++) {
      h.state.t += 16;
      measurer.tick();
    }
    assert.deepEqual(seen, h.cells.map((c) => [c.x, c.y]));
  });
});

describe("settled measurement lifecycle", () => {
  test("records pose, timestamp, cost and hits at measurement time", () => {
    const h = harness({ helpers: 2 });
    h.move(0.5);
    h.measurer.setCells(h.cells);
    h.run(600);
    const m = h.measurer.latest()!;
    assert.equal(m.status, "current");
    assert.deepEqual(m.pose.position, [0.5, 0, -3]);
    assert.equal(m.hits.length, 9);
    assert.ok(m.hits.every(Boolean));
    assert.equal(m.durationMs, 9 * 35);
    assert.match(m.measuredAtIso, /^2023-11-14T/);
    assert.equal(m.helperCountAtMeasurement, 2);
    assert.equal(h.measurer.status(), "measured");
  });

  test("moving invalidates the measurement as STALE and preserves its timestamp and data", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    h.run(600);
    const before = h.measurer.latest()!;
    h.move(2);
    h.frame();
    const after = h.measurer.latest()!;
    assert.equal(after.status, "stale");
    assert.equal(after.staleReason, "camera moved");
    assert.equal(after.measuredAtIso, before.measuredAtIso);
    assert.equal(after.measuredAtMs, before.measuredAtMs);
    assert.deepEqual(after.hits, before.hits);
    assert.deepEqual(after.pose, before.pose);
    assert.equal(h.measurer.status(), "waiting-for-camera", "a stale result is not 'measured'");
  });

  test("a fresh settle replaces the stale result with a new sequence number", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    h.run(600);
    const first = h.measurer.latest()!;
    h.move(3);
    h.run(600);
    const second = h.measurer.latest()!;
    assert.equal(second.status, "current");
    assert.equal(second.sequence, first.sequence + 1);
    assert.ok(second.measuredAtMs > first.measuredAtMs);
  });

  test("splat not ready: no casts, status says so, and exactly one set once it becomes ready", () => {
    const h = harness({ ready: false });
    h.measurer.setCells(h.cells);
    h.run(2000);
    assert.equal(h.state.casts, 0);
    assert.equal(h.measurer.status(), "waiting-for-splat");
    assert.equal(h.measurer.latest(), null);
    h.state.ready = true;
    h.run(200);
    assert.equal(h.state.casts, 9);
    assert.equal(h.measurer.status(), "measured");
    h.run(2000);
    assert.equal(h.state.casts, 9);
  });

  test("moving while waiting for the splat cancels the pending measurement", () => {
    const h = harness({ ready: false });
    h.measurer.setCells(h.cells);
    h.run(600);
    h.move(4);
    h.frame();
    h.state.ready = true;
    h.run(100); // ready now, but the camera has not re-settled yet
    assert.equal(h.state.casts, 0);
    h.run(500);
    assert.equal(h.state.casts, 9);
  });

  test("no snapshot cells: never casts", () => {
    const h = harness();
    h.run(3000);
    assert.equal(h.state.casts, 0);
    assert.equal(h.measurer.status(), "no-snapshot");
  });

  test("new cells while stationary: previous result goes STALE, one fresh set is taken", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    h.run(600);
    assert.equal(h.state.casts, 9);
    h.measurer.setCells(h.cells.slice().reverse());
    assert.equal(h.measurer.latest()!.status, "stale");
    assert.equal(h.measurer.latest()!.staleReason, "sampling cells changed");
    h.run(100);
    assert.equal(h.state.casts, 18);
    assert.equal(h.measurer.latest()!.status, "current");
  });

  test("reset clears the measurement and casts nothing", () => {
    const h = harness();
    h.measurer.setCells(h.cells);
    h.run(600);
    const casts = h.state.casts;
    h.measurer.reset();
    assert.equal(h.measurer.latest(), null);
    h.run(3000);
    assert.equal(h.state.casts, casts);
  });
});

describe("splat raycast readiness", () => {
  const ok = { raycastable: true, isInitialized: true, packedSplats: {}, context: { numSplats: { value: 10 } } };
  test("ready only when every raycast input exists", () => {
    assert.equal(splatRaycastReadiness(ok, true, true).ready, true);
    assert.equal(splatRaycastReadiness(null, true, true).waitingFor, "no splat object");
    assert.equal(splatRaycastReadiness(ok, false, true).waitingFor, "world load");
    assert.equal(splatRaycastReadiness(ok, true, false).waitingFor, "Spark wasm init");
    assert.equal(splatRaycastReadiness({ ...ok, isInitialized: false }, true, true).ready, false);
    assert.equal(splatRaycastReadiness({ ...ok, raycastable: false }, true, true).ready, false);
    assert.equal(splatRaycastReadiness({ ...ok, packedSplats: undefined }, true, true).waitingFor, "splat data");
    assert.equal(splatRaycastReadiness({ ...ok, context: { numSplats: { value: 0 } } }, true, true).ready, false);
    assert.equal(splatRaycastReadiness({ ...ok, context: undefined }, true, true).ready, false);
  });
});
