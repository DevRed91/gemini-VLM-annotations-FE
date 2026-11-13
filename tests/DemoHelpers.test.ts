import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { HELPER_WARNING, detectAnnotationHelpers } from "../src/demo/helperDetection.ts";
import { ConfirmGate, DiagnosticsGuard } from "../src/demo/guards.ts";
import { SCENE_F_BADGE, SCENE_F_HEADLINE, SCENE_F_SLOTS, SceneFCaptions, poseMatches } from "../src/demo/sceneCaptions.ts";

const lines = () => ({ isLineSegments: true as const });

describe("annotation helper detection", () => {
  test("clean scene: no warning", () => {
    const d = detectAnnotationHelpers({ splatChildren: [], annotations: [], storedRecords: [] });
    assert.equal(d.warn, false);
    assert.equal(d.annotationCount, 0);
    assert.equal(d.helperCount, 0);
  });

  test("no splat at all is not an error", () => {
    assert.equal(detectAnnotationHelpers({ splatChildren: null, annotations: [], storedRecords: [] }).warn, false);
  });

  test("one helper on a live annotation", () => {
    const helper = lines();
    const d = detectAnnotationHelpers({
      splatChildren: [helper],
      annotations: [{ apartmentId: "annotation-1", helper }],
      storedRecords: [],
    });
    assert.equal(d.warn, true);
    assert.equal(d.helperCount, 1);
    assert.equal(d.annotationCount, 1);
    assert.equal(d.unattributedHelpers, 0);
  });

  test("multiple helpers", () => {
    const hs = [lines(), lines(), lines()];
    const d = detectAnnotationHelpers({
      splatChildren: hs,
      annotations: hs.map((helper, i) => ({ apartmentId: `annotation-${i + 1}`, helper })),
      storedRecords: [],
    });
    assert.equal(d.helperCount, 3);
    assert.equal(d.annotationCount, 3);
  });

  test("stored records alone still warn", () => {
    const d = detectAnnotationHelpers({
      splatChildren: [],
      annotations: [],
      storedRecords: [{ annotationId: "annotation-7" }],
    });
    assert.equal(d.warn, true);
    assert.equal(d.helperCount, 0);
    assert.equal(d.annotationCount, 1);
    assert.equal(d.storedAnnotations, 1);
  });

  test("the same annotation as helper + live record + stored record counts once", () => {
    const helper = lines();
    const d = detectAnnotationHelpers({
      splatChildren: [helper],
      annotations: [{ apartmentId: "annotation-1", helper }],
      storedRecords: [{ annotationId: "annotation-1" }],
    });
    assert.equal(d.annotationCount, 1);
    assert.equal(d.helperCount, 1);
    assert.equal(d.liveAnnotations, 1);
    assert.equal(d.storedAnnotations, 1);
  });

  test("a helper listed both as a splat child and on its annotation is one helper", () => {
    const helper = lines();
    const d = detectAnnotationHelpers({
      splatChildren: [helper, { isLineSegments: false }],
      annotations: [{ apartmentId: "annotation-1", helper }],
      storedRecords: [],
    });
    assert.equal(d.helperCount, 1);
  });

  test("an orphan LineSegments child still counts (it is raycast-visible)", () => {
    const d = detectAnnotationHelpers({ splatChildren: [lines()], annotations: [], storedRecords: [] });
    assert.equal(d.helperCount, 1);
    assert.equal(d.unattributedHelpers, 1);
    assert.equal(d.annotationCount, 1);
    assert.equal(d.warn, true);
  });

  test("signature changes when annotation state changes, so the warning can refresh", () => {
    const a = detectAnnotationHelpers({ splatChildren: [], annotations: [], storedRecords: [] });
    const h = lines();
    const b = detectAnnotationHelpers({ splatChildren: [h], annotations: [{ apartmentId: "annotation-1", helper: h }], storedRecords: [] });
    assert.notEqual(a.signature, b.signature);
  });

  test("warning text states the contamination risk and does not claim a fix", () => {
    assert.match(HELPER_WARNING, /may intersect helper geometry/);
    assert.match(HELPER_WARNING, /Start with a clean scene/);
    assert.doesNotMatch(HELPER_WARNING, /fixed/i);
  });

  test("detection is read-only: inputs are not mutated", () => {
    const helper = Object.freeze({ isLineSegments: true as const, visible: false });
    const children = Object.freeze([helper]);
    const annotations = Object.freeze([Object.freeze({ apartmentId: "annotation-1", helper })]);
    detectAnnotationHelpers({ splatChildren: children, annotations, storedRecords: Object.freeze([]) });
    assert.equal(helper.visible, false);
  });
});

describe("clear confirmation gate", () => {
  test("cannot confirm without arming", () => {
    let now = 0;
    const gate = new ConfirmGate(() => now);
    assert.equal(gate.confirm(), false);
    assert.equal(gate.isArmed(), false);
  });

  test("arm then confirm succeeds once; the arm is consumed", () => {
    let now = 0;
    const gate = new ConfirmGate(() => now, 1000);
    gate.arm();
    assert.equal(gate.isArmed(), true);
    assert.equal(gate.confirm(), true);
    assert.equal(gate.confirm(), false);
  });

  test("cancel and timeout both disarm", () => {
    let now = 0;
    const gate = new ConfirmGate(() => now, 1000);
    gate.arm();
    gate.cancel();
    assert.equal(gate.confirm(), false);
    gate.arm();
    now = 1001;
    assert.equal(gate.isArmed(), false);
    assert.equal(gate.confirm(), false);
  });
});

describe("diagnostics guard", () => {
  const fake = (enabled: boolean) => {
    const calls: boolean[] = [];
    return {
      calls,
      target: {
        isEnabled: enabled,
        setEnabled(value: boolean) {
          this.isEnabled = value;
          calls.push(value);
        },
      },
    };
  };

  test("turns markers off on install and restores the previous state (was on)", () => {
    const f = fake(true);
    const guard = new DiagnosticsGuard(f.target);
    guard.install();
    assert.equal(f.target.isEnabled, false);
    f.target.isEnabled = true; // user pressed D during the demo
    guard.restore();
    assert.equal(f.target.isEnabled, true);
  });

  test("restores 'off' when it was off; install/restore are idempotent", () => {
    const f = fake(false);
    const guard = new DiagnosticsGuard(f.target);
    guard.install();
    guard.install();
    guard.restore();
    guard.restore();
    assert.equal(f.target.isEnabled, false);
    assert.deepEqual(f.calls, [false, false]);
  });

  test("null diagnostics (production) is a no-op", () => {
    const guard = new DiagnosticsGuard(null);
    guard.install();
    guard.restore();
  });
});

describe("Scene F captions", () => {
  const logged = { position: [1, 2, 3] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fov: 60 };

  test("carries the required headline and NOT YET IMPLEMENTED label; three view slots", () => {
    assert.equal(SCENE_F_HEADLINE, "Next research phase: Multi-view Object Association");
    assert.equal(SCENE_F_BADGE, "NOT YET IMPLEMENTED");
    assert.deepEqual(SCENE_F_SLOTS.map((s) => s.id), ["front", "side", "top"]);
    for (const slot of SCENE_F_SLOTS) assert.ok(slot.demonstrates.length > 20);
  });

  test("no camera positions are invented: every slot starts unbound", () => {
    const c = new SceneFCaptions(null);
    assert.equal(c.boundCount(), 0);
    assert.equal(c.match(logged), null);
  });

  test("a bound logged pose matches the live camera within tolerance only", () => {
    const c = new SceneFCaptions(null);
    c.bind("side", logged);
    assert.equal(c.match(logged)?.id, "side");
    assert.equal(c.match({ ...logged, position: [1.05, 2, 3] })?.id, "side");
    assert.equal(c.match({ ...logged, position: [2, 2, 3] }), null);
    assert.equal(poseMatches(logged, { ...logged, quaternion: [0, 0.2, 0, 0.98] }), false);
  });

  test("rejects malformed poses and unknown slots", () => {
    const c = new SceneFCaptions(null);
    assert.throws(() => c.bind("front", { position: [1, 2], quaternion: [0, 0, 0, 1] } as never), TypeError);
    assert.throws(() => c.bind("bottom" as never, logged), RangeError);
  });

  test("bindings persist through storage and survive corrupt storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    new SceneFCaptions(storage).bind("top", logged);
    assert.equal(new SceneFCaptions(storage).get("top")?.position[0], 1);
    store.set([...store.keys()][0], "{not json");
    assert.equal(new SceneFCaptions(storage).boundCount(), 0);
  });
});
