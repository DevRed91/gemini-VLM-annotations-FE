import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import type {
  MultiViewObjectDetection,
  MultiViewObservation,
  NormalizedDetectionBox,
  SelectedMultiViewObject,
} from "../src/demo/multiViewDetection.ts";
import type { CaptureSlotId, PresentationCapture } from "../src/demo/presentationCaptures.ts";
import { SegmentationController, type SegmentationHost } from "../src/segmentation/SegmentationController.ts";
import { associateSemanticTarget, summarizeHandoff } from "../src/segmentation/semanticAnchor.ts";
import type { CastFn } from "../src/segmentation/geometry.ts";
import { projectAnchorToImage } from "../src/segmentation/geometry.ts";
import type { SegmentRequest } from "../src/segmentation/contract.ts";
import { encodeRle } from "../src/segmentation/maskAnalysis.ts";
import type { LiveWorldState } from "../src/viewer/SnapshotBinding.ts";
import { captureViewSnapshot, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

// ------------------------------------------------------------ synthetic scene

const W = 800;
const H = 600;
const GEN = 7;
const D = 4;
const S = D / Math.SQRT2;

interface Sphere { centre: THREE.Vector3; radius: number }
const sphere = (x: number, y: number, z: number, radius: number): Sphere => ({ centre: new THREE.Vector3(x, y, z), radius });

/** Every sphere entry/exit plus an optional wall at z = wallZ, sorted nearest first. */
function sceneCaster(spheres: Sphere[], wallZ: number | null = null): CastFn {
  return (origin, direction) => {
    const o = new THREE.Vector3(origin.x, origin.y, origin.z);
    const d = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    const ts: number[] = [];
    for (const { centre, radius } of spheres) {
      const rel = o.clone().sub(centre);
      const b = rel.dot(d);
      const disc = b * b - (rel.lengthSq() - radius * radius);
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      ts.push(-b - root, -b + root);
    }
    if (wallZ !== null && Math.abs(d.z) > 1e-9) ts.push((wallZ - o.z) / d.z);
    return ts.filter((t) => t > 0).sort((a, b) => a - b)
      .map((t) => ({ distance: t, point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t } }));
  };
}

const splat = new THREE.Object3D();
const live: LiveWorldState = { worldGeneration: GEN, splat, splatLoaded: true };

function snapshotAt(position: [number, number, number], lookAt: [number, number, number] = [0, 0, 0], generation = GEN): ViewSnapshot {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(...position);
  camera.lookAt(...lookAt);
  scene.add(camera);
  const canvas = {
    width: W, height: H, clientWidth: W / 2, clientHeight: H / 2,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W / 2, height: H / 2 }),
    toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
  };
  const renderer = {
    domElement: canvas,
    render: () => { scene.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); },
  } as unknown as THREE.WebGLRenderer;
  const snap = captureViewSnapshot(renderer, scene, camera, null, generation);
  return { ...snap, splat: { matrixWorld: Array.from(splat.matrixWorld.elements) } } as ViewSnapshot;
}

function captureFor(slot: CaptureSlotId, snapshot: ViewSnapshot): PresentationCapture {
  return { id: snapshot.id, slot, capturedAtMs: 1, capturedAtIso: new Date(1).toISOString(), snapshot } as PresentationCapture;
}

// All three cameras see the +z hemisphere, so one surface point is visible in every view.
const POSITIONS: Record<CaptureSlotId, [number, number, number]> = {
  front: [0, 0, D],
  side: [S, 0, S],
  top: [0, S, S],
};

function makeCaptures(overrides: Partial<Record<CaptureSlotId, ViewSnapshot>> = {}) {
  const snaps = {
    front: overrides.front ?? snapshotAt(POSITIONS.front),
    side: overrides.side ?? snapshotAt(POSITIONS.side),
    top: overrides.top ?? snapshotAt(POSITIONS.top),
  };
  return {
    snaps,
    captures: (["front", "side", "top"] as const).map((slot) => captureFor(slot, snaps[slot])),
  };
}

/** A deliberately loose Gemini-style box: bounds of the object's bounding cube as seen by this snapshot. */
function boxAround(snapshot: ViewSnapshot, centre: THREE.Vector3, half: number): NormalizedDetectionBox {
  const us: number[] = [];
  const vs: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = projectAnchorToImage(snapshot, { x: centre.x + sx * half, y: centre.y + sy * half, z: centre.z + sz * half }, GEN);
    assert.ok(p.normalized, "test geometry must stay in front of the camera");
    us.push(p.normalized.u);
    vs.push(p.normalized.v);
  }
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return { xMin: c(Math.min(...us)), xMax: c(Math.max(...us)), yMin: c(Math.min(...vs)), yMax: c(Math.max(...vs)) };
}

const obs = (view: CaptureSlotId, box: NormalizedDetectionBox | null): MultiViewObservation =>
  box ? { view, visible: true, box } : { view, visible: false, box: null };

function selection(
  objectId: string,
  label: string,
  observations: MultiViewObservation[],
  captures: PresentationCapture[],
): SelectedMultiViewObject {
  return Object.freeze({
    objectId, label, description: `${label} description`,
    observations, captures: Object.freeze([...captures]), confirmedAtIso: "2026-11-13T10:00:00.000Z",
  });
}

const detection = (selected: SelectedMultiViewObject): MultiViewObjectDetection =>
  ({ id: selected.objectId, label: selected.label, description: selected.description, observations: selected.observations });

const pillow = sphere(0, 0, 0, 0.3);
const origin = new THREE.Vector3();
const fixedNow = () => "2026-11-13T10:00:01.000Z";

function pillowObservations(snaps: Record<CaptureSlotId, ViewSnapshot>, which: CaptureSlotId[] = ["front", "side", "top"]) {
  return which.map((slot) => obs(slot, boxAround(snaps[slot], origin, 0.3)));
}

// ------------------------------------------------------------------- valid

describe("valid anchors", () => {
  test("derives a real surface point from the box, corroborates it in the other views, and preserves every original", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), captures);
    const cast = sceneCaster([pillow]);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast }, { now: fixedNow });

    assert.equal(outcome.status, "verified");
    if (outcome.status !== "verified") return;
    const { anchor, semantic, views } = outcome.handoff;

    // A genuine splat hit on the pillow surface, not the box centre (which would be the sphere's centre, radius 0 from origin).
    const r = Math.hypot(anchor.point.x, anchor.point.y, anchor.point.z);
    assert.ok(Math.abs(r - 0.3) < 0.01, `anchor must lie on the surface (|p| = ${r})`);
    assert.ok(anchor.refinement.stable);
    assert.equal(anchor.derivation.kind, "gemini-box-probe");
    assert.equal(anchor.derivation.sourceView, "front");
    assert.equal(anchor.derivation.sourceCaptureId, captures[0].id);
    assert.equal(anchor.derivation.sourceSnapshotId, snaps.front.id);
    assert.equal(anchor.derivation.box, selected.observations[0].box);
    assert.deepEqual(anchor.verification.corroboratingViews, ["side", "top"]);
    assert.equal(anchor.verification.checkedAtIso, "2026-11-13T10:00:01.000Z");
    assert.equal(anchor.worldGeneration, GEN);

    // The anchor reprojects inside each retained view's box.
    for (const check of anchor.verification.views) {
      assert.ok(check.projected);
      const box = check.observation!.box!;
      assert.ok(check.projected.u >= box.xMin && check.projected.u <= box.xMax && check.projected.v >= box.yMin && check.projected.v <= box.yMax);
    }

    // Identification is passed through untouched; the very same frozen snapshots feed segmentation.
    assert.equal(semantic, selected);
    assert.deepEqual(views.map((v) => v.slot), ["front", "side", "top"]);
    views.forEach((view, i) => assert.equal(view.snapshot, captures[i].snapshot));
  });

  test("a view where Gemini reports the object absent and the anchor really is out of view is consistent, not a contradiction", () => {
    const away = snapshotAt(POSITIONS.top, [20, S, S]); // top camera looking away from the object
    const { snaps, captures } = makeCaptures({ top: away });
    const selected = selection("object_01", "Pillow", [...pillowObservations(snaps, ["front", "side"]), obs("top", null)], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "verified");
    if (outcome.status !== "verified") return;
    const top = outcome.handoff.anchor.verification.views.find((v) => v.slot === "top")!;
    assert.equal(top.verdict, "neutral");
    assert.equal(top.reason, "gemini-not-visible-consistent");
  });

  test("the summary used for export contains ids and boxes but no image data", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "verified");
    if (outcome.status !== "verified") return;
    const json = JSON.stringify(summarizeHandoff(outcome.handoff));
    assert.ok(!json.includes("data:image"));
    assert.ok(json.includes(captures[1].id));
  });
});

// -------------------------------------------------- incorrect association

describe("incorrect object association", () => {
  test("a box in another view that does not contain the anchor rejects it instead of trusting the labels", () => {
    const { snaps, captures } = makeCaptures();
    // Gemini's side/top boxes are over a different spot (a different cushion, say).
    const elsewhere: NormalizedDetectionBox = { xMin: 0.02, yMin: 0.02, xMax: 0.2, yMax: 0.2 };
    const selected = selection("object_01", "Pillow", [
      obs("front", boxAround(snaps.front, origin, 0.3)), obs("side", elsewhere), obs("top", elsewhere),
    ], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.equal(outcome.reason, "contradicted");
    assert.equal(outcome.fallback, "user-click");
    const front = outcome.candidates.find((c) => c.sourceView === "front")!;
    assert.equal(front.outcome, "contradicted");
    assert.ok(front.views.some((v) => v.reason === "outside-box"));
  });

  test("Gemini saying the object is invisible where the anchor is plainly visible is a contradiction", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", [obs("front", boxAround(snaps.front, origin, 0.3)), obs("side", null), obs("top", null)], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.equal(outcome.reason, "contradicted");
    assert.ok(outcome.candidates[0].views.some((v) => v.reason === "gemini-not-visible-geometry-visible"));
  });

  test("a box over empty space produces no anchor at all", () => {
    const { captures } = makeCaptures();
    const empty: NormalizedDetectionBox = { xMin: 0.01, yMin: 0.01, xMax: 0.1, yMax: 0.1 };
    const selected = selection("object_01", "Ghost", [obs("front", empty)], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, "no-surface-hit");
  });
});

// ------------------------------------------------------ missing observations

describe("missing observations", () => {
  test("an object seen in only one view is not corroborated and is not handed off by default", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps, ["front"]), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.equal(outcome.reason, "uncorroborated");
    assert.deepEqual(outcome.candidates[0].views.filter((v) => v.reason === "no-observation").map((v) => v.slot), ["side", "top"]);
  });

  test("single-view handoff exists only as an explicit opt-in and is still a geometric hit", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps, ["front"]), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) }, { minCorroboratingViews: 0 });
    assert.equal(outcome.status, "verified");
    if (outcome.status === "verified") assert.deepEqual(outcome.handoff.anchor.verification.corroboratingViews, []);
  });

  test("a missing capture is recorded as no-capture, never inferred", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), [captures[0]]);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.equal(outcome.reason, "uncorroborated");
    assert.deepEqual(outcome.candidates[0].views.filter((v) => v.reason === "no-capture").map((v) => v.slot), ["side", "top"]);
  });

  test("no visible observation anywhere is rejected up front", () => {
    const { captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", [obs("front", null), obs("side", null)], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") {
      assert.equal(outcome.reason, "no-usable-observation");
      assert.equal(outcome.candidates.length, 0);
    }
  });

  test("malformed selections throw instead of being guessed at", () => {
    const { snaps, captures } = makeCaptures();
    const twice = selection("object_01", "Pillow", pillowObservations(snaps), [captures[0], captures[0]]);
    assert.throws(() => associateSemanticTarget(twice, [], { live, cast: sceneCaster([pillow]) }), /two captures/);
  });
});

// ----------------------------------------------------------- stale snapshots

describe("stale snapshots", () => {
  test("every capture from another world generation is rejected as stale", () => {
    const old = { front: snapshotAt(POSITIONS.front, [0, 0, 0], GEN - 1), side: snapshotAt(POSITIONS.side, [0, 0, 0], GEN - 1), top: snapshotAt(POSITIONS.top, [0, 0, 0], GEN - 1) };
    const { captures } = makeCaptures(old);
    const staleSelected = selection("object_01", "Pillow", [obs("front", { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 })], captures);
    const outcome = associateSemanticTarget(staleSelected, [], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, "stale-snapshot");
  });

  test("a stale source falls to another view; a stale corroborator is neutral rather than silently counted", () => {
    const stale = snapshotAt(POSITIONS.front, [0, 0, 0], GEN - 1);
    const { snaps, captures } = makeCaptures({ front: stale });
    const boxes = {
      front: { xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 },
      side: boxAround(snaps.side, origin, 0.3),
      top: boxAround(snaps.top, origin, 0.3),
    };
    const selected = selection("object_01", "Pillow", (["front", "side", "top"] as const).map((v) => obs(v, boxes[v])), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "verified");
    if (outcome.status !== "verified") return;
    const { anchor } = outcome.handoff;
    assert.notEqual(anchor.derivation.sourceView, "front");
    assert.equal(anchor.verification.views.find((v) => v.slot === "front")!.reason, "stale-snapshot");
    assert.ok(!anchor.verification.corroboratingViews.includes("front"));
    assert.equal(anchor.verification.alternates.find((c) => c.sourceView === "front")!.outcome, "stale-snapshot");
  });

  test("a splat that moved since the capture makes the capture stale", () => {
    const { snaps, captures } = makeCaptures();
    const moved = new THREE.Object3D();
    moved.position.x = 1;
    moved.updateMatrixWorld(true);
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live: { worldGeneration: GEN, splat: moved, splatLoaded: true }, cast: sceneCaster([pillow]) });
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, "stale-snapshot");
  });
});

// --------------------------------------------------------- ambiguous targets

describe("ambiguous targets", () => {
  test("the centre ray of a sofa box lands on the pillow resting on it: that candidate is ambiguous, not adopted", () => {
    const sofa = sphere(0, 0, 0, 0.8);
    const cushion = sphere(0, 0, 0.9, 0.3);
    const { snaps, captures } = makeCaptures();
    const sofaObs = (["front", "side", "top"] as const).map((v) => obs(v, boxAround(snaps[v], sofa.centre, 0.8)));
    const cushionObs = (["front", "side", "top"] as const).map((v) => obs(v, boxAround(snaps[v], cushion.centre, 0.3)));
    const selectedSofa = selection("sofa", "Sofa", sofaObs, captures);
    const peers = [detection(selectedSofa), { id: "cushion", label: "Cushion", description: "on the sofa", observations: cushionObs }];
    const cast = sceneCaster([sofa, cushion]);

    // Front alone: its only candidate sits on the cushion.
    const frontOnly = selection("sofa", "Sofa", sofaObs.slice(0, 1), captures);
    const rejected = associateSemanticTarget(frontOnly, peers, { live, cast }, { minCorroboratingViews: 0 });
    assert.equal(rejected.status, "rejected");
    if (rejected.status !== "rejected") return;
    assert.equal(rejected.reason, "ambiguous-object");
    assert.ok(rejected.candidates[0].views.some((v) => v.moreSpecificObjectIds.includes("cushion")));

    // All views: the Front candidate is still recorded as ambiguous, and whatever is handed off is NOT on the cushion.
    const full = associateSemanticTarget(selectedSofa, peers, { live, cast });
    assert.equal(full.status, "verified");
    if (full.status !== "verified") return;
    const { anchor } = full.handoff;
    assert.notEqual(anchor.derivation.sourceView, "front");
    assert.equal(anchor.verification.alternates.find((c) => c.sourceView === "front")!.outcome, "ambiguous-object");
    const toCushion = Math.hypot(anchor.point.x - cushion.centre.x, anchor.point.y - cushion.centre.y, anchor.point.z - cushion.centre.z);
    assert.ok(toCushion > cushion.radius + 0.05, `anchor must not be on the cushion (distance ${toCushion})`);
  });

  test("selecting the more specific object is not ambiguous even though a larger box also contains the anchor", () => {
    const sofa = sphere(0, 0, 0, 0.8);
    const cushion = sphere(0, 0, 0.9, 0.3);
    const { snaps, captures } = makeCaptures();
    const sofaObs = (["front", "side", "top"] as const).map((v) => obs(v, boxAround(snaps[v], sofa.centre, 0.8)));
    const cushionObs = (["front", "side", "top"] as const).map((v) => obs(v, boxAround(snaps[v], cushion.centre, 0.3)));
    const selectedCushion = selection("cushion", "Cushion", cushionObs, captures);
    const peers = [detection(selectedCushion), { id: "sofa", label: "Sofa", description: "", observations: sofaObs }];
    const outcome = associateSemanticTarget(selectedCushion, peers, { live, cast: sceneCaster([sofa, cushion]) });
    assert.equal(outcome.status, "verified");
  });

  test("a box that straddles the object and the wall behind it yields scattered depths and no anchor", () => {
    const { captures } = makeCaptures();
    // Centre of this box sits on the sphere's silhouette: some probe rays hit the pillow, others the wall far behind it.
    const straddle: NormalizedDetectionBox = { xMin: 0.44, yMin: 0.3, xMax: 0.68, yMax: 0.7 };
    const selected = selection("object_01", "Pillow", [obs("front", straddle)], captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([pillow], -2) }, { minCorroboratingViews: 0 });
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") return;
    assert.equal(outcome.reason, "unstable-depth");
    assert.ok(outcome.candidates[0].refinement && !outcome.candidates[0].refinement.stable);
  });

  test("stability scales with the box: a large smooth object is not rejected for having a wide probe patch", () => {
    const sofa = sphere(0, 0, 0, 0.8);
    const { snaps, captures } = makeCaptures();
    const selected = selection("sofa", "Sofa", (["front", "side", "top"] as const).map((v) => obs(v, boxAround(snaps[v], sofa.centre, 0.8))), captures);
    const outcome = associateSemanticTarget(selected, [detection(selected)], { live, cast: sceneCaster([sofa]) });
    assert.equal(outcome.status, "verified");
  });
});

// ------------------------------------------- controller: handoff + fallback

type Listener = (event: unknown) => void;
const g = globalThis as unknown as { window?: unknown };
let savedWindow: unknown;
beforeEach(() => {
  savedWindow = g.window;
  g.window = { addEventListener: (_t: string, _fn: Listener) => undefined, removeEventListener: (_t: string, _fn: Listener) => undefined };
});
afterEach(() => { g.window = savedWindow; });

function makeController(selectionProvider: () => { selected: SelectedMultiViewObject | null; detections: readonly MultiViewObjectDetection[] }, cast: CastFn) {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(0, 0, D);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const state = { worldGeneration: GEN };
  const host: SegmentationHost = {
    camera,
    renderer: { domElement: { clientWidth: W / 2, clientHeight: H / 2, getBoundingClientRect: () => ({ left: 0, top: 0, width: W / 2, height: H / 2 }) } } as unknown as THREE.WebGLRenderer,
    currentSplat: splat,
    splatLoaded: true,
    liveWorldState: () => ({ worldGeneration: state.worldGeneration, splat, splatLoaded: true }),
  };
  const requests: SegmentRequest[] = [];
  const controller = new SegmentationController({
    host,
    getCaptures: () => [],
    getSemanticSelection: selectionProvider,
    segment: async (r) => {
      requests.push(r);
      return { provider: "fake", mock: true, masks: [{ mask: encodeRle(r.imageWidth, r.imageHeight, new Uint8Array(r.imageWidth * r.imageHeight)), score: 0.5 }] };
    },
    detectBox: async () => null,
    makeCaster: () => cast,
  });
  return { controller, requests, state };
}

describe("SegmentationController handoff", () => {
  test("a verified selection becomes the anchor, runs on the retained captures, and the export carries no images", async () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), captures);
    const { controller, requests } = makeController(() => ({ selected, detections: [detection(selected)] }), sceneCaster([pillow]));
    const outcome = controller.adoptSelectedObject();
    assert.equal(outcome?.status, "verified");
    const anchor = controller.state().anchor!;
    assert.equal(anchor.source, "semantic-verified");
    assert.equal(controller.state().text, "Pillow");

    controller.configure({ variants: ["point"] });
    const result = await controller.run();
    assert.ok(result);
    // getCaptures() returned nothing: the views came from the handoff, i.e. the captures Gemini actually saw.
    assert.deepEqual(result!.views.map((v) => v.snapshotId), captures.map((c) => c.id));
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(controller.exportResult()).includes("data:image"));
  });

  test("a rejected selection adopts nothing and leaves the click workflow available", () => {
    const { captures } = makeCaptures();
    const selected = selection("object_01", "Ghost", [obs("front", { xMin: 0.01, yMin: 0.01, xMax: 0.1, yMax: 0.1 })], captures);
    const { controller } = makeController(() => ({ selected, detections: [detection(selected)] }), sceneCaster([pillow]));
    assert.equal(controller.adoptSelectedObject()?.status, "rejected");
    assert.equal(controller.state().anchor, null, "no box-centre anchor is substituted");
    assert.match(controller.state().status, /not geometrically verified.*Pick an anchor by click/);

    const click = controller.pickAt(0.5, 0.5, { width: W / 2, height: H / 2 });
    assert.ok(click);
    assert.equal(controller.state().anchor!.source, "user-click");
    assert.equal(controller.state().anchor!.semantic, undefined);
  });

  test("no confirmed selection is reported, not invented", () => {
    const { controller } = makeController(() => ({ selected: null, detections: [] }), sceneCaster([pillow]));
    assert.equal(controller.adoptSelectedObject(), null);
    assert.equal(controller.state().anchor, null);
    assert.match(controller.state().status, /No confirmed Gemini object/);
  });

  test("a semantic anchor from a replaced world is discarded like a click anchor", () => {
    const { snaps, captures } = makeCaptures();
    const selected = selection("object_01", "Pillow", pillowObservations(snaps), captures);
    const { controller, state } = makeController(() => ({ selected, detections: [detection(selected)] }), sceneCaster([pillow]));
    controller.adoptSelectedObject();
    state.worldGeneration = GEN + 1;
    assert.equal(controller.state().anchor, null);
  });
});
