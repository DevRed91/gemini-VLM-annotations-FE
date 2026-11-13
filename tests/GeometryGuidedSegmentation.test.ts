import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { captureViewSnapshot, generateSnapshotRay, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";
import type { LiveWorldState } from "../src/viewer/SnapshotBinding.ts";
import {
  classifyVisibility,
  createSplatCaster,
  probeOffsets,
  projectAnchorToImage,
  refineAnchor,
  type CastFn,
} from "../src/segmentation/geometry.ts";
import {
  decodeRle,
  encodeRle,
  maskContains,
  maskIou,
  maskStats,
} from "../src/segmentation/maskAnalysis.ts";
import {
  validateRleMask,
  validateSegmentRequest,
  validateSegmentResponse,
  type SegmentRequest,
  type SegmentResponse,
} from "../src/segmentation/contract.ts";
import {
  choosePrimary,
  exportExperiment,
  runExperiment,
  type ExperimentConfig,
} from "../src/segmentation/experiment.ts";

// ------------------------------------------------------------ synthetic scene

const W = 800;
const H = 600;
const GEN = 4;

/** Analytic sphere "pillow" at the origin. Returns BOTH entry and exit hits, like Spark returns every splat on the ray. */
function sphereCaster(radius = 0.3, centre = new THREE.Vector3()): CastFn {
  return (origin, direction) => {
    const o = new THREE.Vector3(origin.x, origin.y, origin.z).sub(centre);
    const d = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    const b = o.dot(d);
    const c = o.lengthSq() - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return [];
    const s = Math.sqrt(disc);
    return [-b - s, -b + s]
      .filter((t) => t > 0)
      .map((t) => ({ distance: t, point: { x: origin.x + d.x * t, y: origin.y + d.y * t, z: origin.z + d.z * t } }));
  };
}

function capture(position: [number, number, number], generation = GEN): ViewSnapshot {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(...position);
  camera.lookAt(0, 0, 0);
  scene.add(camera);
  const canvas = {
    width: W, height: H, clientWidth: W / 2, clientHeight: H / 2,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W / 2, height: H / 2 }),
    toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
  };
  const renderer = {
    domElement: canvas,
    render: () => {
      scene.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    },
  } as unknown as THREE.WebGLRenderer;
  return captureViewSnapshot(renderer, scene, camera, null, generation);
}

const live: LiveWorldState = { worldGeneration: GEN, splat: new THREE.Object3D(), splatLoaded: true };

// The captured splat matrix must equal the live splat's: both identity here.
function captureWithSplat(position: [number, number, number]): ViewSnapshot {
  const snap = capture(position);
  return { ...snap, splat: { matrixWorld: Array.from(live.splat!.matrixWorld.elements) } } as ViewSnapshot;
}

const front = captureWithSplat([0, 0, 2]);
const side = captureWithSplat([2, 0, 0]);
const top = captureWithSplat([0, 2, 0]);

// Anchor on the +x/+z diagonal of the sphere: front and side can see it, top cannot.
const r = 0.3 / Math.SQRT2;
const anchor = { x: r, y: 0, z: r };

// ------------------------------------------------------------------ geometry

describe("anchor projection", () => {
  test("round-trips: the projected pixel's own ray passes through the anchor", () => {
    for (const snap of [front, side]) {
      const p = projectAnchorToImage(snap, anchor, GEN);
      assert.equal(p.status, "in-view");
      const ray = generateSnapshotRay(snap, p.image!.x / W, p.image!.y / H, GEN);
      const t = (anchor.x - ray.origin.x) * ray.direction.x + (anchor.y - ray.origin.y) * ray.direction.y + (anchor.z - ray.origin.z) * ray.direction.z;
      const closest = {
        x: ray.origin.x + ray.direction.x * t,
        y: ray.origin.y + ray.direction.y * t,
        z: ray.origin.z + ray.direction.z * t,
      };
      assert.ok(Math.hypot(closest.x - anchor.x, closest.y - anchor.y, closest.z - anchor.z) < 1e-6);
      assert.ok(Math.abs(t - p.cameraDistance) < 1e-6);
    }
  });

  test("uses image-pixel convention: top-left origin, y down", () => {
    const up = projectAnchorToImage(front, { x: 0, y: 0.2, z: 0 }, GEN);
    const centre = projectAnchorToImage(front, { x: 0, y: 0, z: 0 }, GEN);
    assert.ok(Math.abs(centre.image!.x - W / 2) < 1e-6 && Math.abs(centre.image!.y - H / 2) < 1e-6);
    assert.ok(up.image!.y < centre.image!.y, "a point above the centre has a smaller pixel y");
  });

  test("reports behind-camera and outside-frame instead of inventing a pixel", () => {
    assert.equal(projectAnchorToImage(front, { x: 0, y: 0, z: 5 }, GEN).status, "behind-camera");
    assert.equal(projectAnchorToImage(front, { x: 0, y: 0, z: 5 }, GEN).image, null);
    assert.equal(projectAnchorToImage(front, { x: 50, y: 0, z: 0 }, GEN).status, "outside-frame");
  });

  test("rejects a stale capture (different world generation)", () => {
    assert.throws(() => projectAnchorToImage(front, anchor, GEN + 1), /Stale/);
  });
});

describe("visibility", () => {
  const cast = sphereCaster();
  const check = (snap: ViewSnapshot) => {
    const p = projectAnchorToImage(snap, anchor, GEN);
    const o = snap.camera.position;
    const d = { x: anchor.x - o.x, y: anchor.y - o.y, z: anchor.z - o.z };
    const len = Math.hypot(d.x, d.y, d.z);
    return classifyVisibility(cast(o, { x: d.x / len, y: d.y / len, z: d.z / len }), p.cameraDistance);
  };

  test("front and side see the anchor; top is blocked by the object's own near side", () => {
    assert.equal(check(front).visibility, "visible");
    assert.equal(check(side).visibility, "visible");
    const topCheck = check(top);
    assert.equal(topCheck.visibility, "occluded");
    // Straight down onto an equator anchor is a near-grazing line, so the blocking chord is short.
    assert.ok(topCheck.frontDistance! > topCheck.tolerance);
  });

  test("no hit at all is 'unverified', never 'visible'", () => {
    assert.equal(classifyVisibility([], 3).visibility, "unverified");
  });
});

describe("anchor refinement", () => {
  test("the medoid outvotes a floater hit", () => {
    const surface = Array.from({ length: 8 }, (_, i) => ({ x: i * 0.002, y: 0, z: 0 }));
    const floater = { x: 0, y: 0, z: -1.5 };
    const refined = refineAnchor([floater, ...surface], 9)!;
    assert.ok(refined.anchor.z === 0, "anchor is a surface sample, not the floater");
    assert.equal(refined.stable, true);
  });

  test("scattered hits are not 'stable'; a lone hit is not trusted either", () => {
    const scattered = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }, { x: 3, y: 0, z: 0 }];
    assert.equal(refineAnchor(scattered, 9)!.stable, false);
    assert.equal(refineAnchor([{ x: 0, y: 0, z: 0 }], 9)!.stable, false);
    assert.equal(refineAnchor([], 9), null);
  });

  test("probe pattern is the centre plus a ring of eight", () => {
    const offsets = probeOffsets(0.01, 0.02);
    assert.equal(offsets.length, 9);
    assert.deepEqual(offsets[0], [0, 0]);
    assert.ok(offsets.slice(1).every(([u, v]) => Math.abs(Math.hypot(u / 0.01, v / 0.02) - 1) < 1e-9));
  });
});

describe("direct splat caster", () => {
  test("calls splat.raycast and never reaches annotation-helper children", () => {
    const splat = new THREE.Object3D();
    let direct = 0;
    splat.raycast = (_rc, hits) => {
      direct++;
      hits.push({ distance: 3, point: new THREE.Vector3(0, 0, 3), object: splat } as THREE.Intersection);
      hits.push({ distance: 2, point: new THREE.Vector3(0, 0, 2), object: splat } as THREE.Intersection);
    };
    // A helper child that would hijack Raycaster.intersectObject(splat) (recursive):
    const helper = new THREE.Object3D();
    let helperCalls = 0;
    helper.raycast = () => { helperCalls++; };
    splat.add(helper);
    const hits = createSplatCaster(splat)({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    assert.equal(direct, 1);
    assert.equal(helperCalls, 0);
    assert.deepEqual(hits.map((h) => h.distance), [2, 3], "sorted nearest first");
  });
});

// --------------------------------------------------------------------- masks

describe("mask analysis", () => {
  const w = 10, h = 8;
  const rect = new Uint8Array(w * h);
  for (let y = 2; y < 5; y++) for (let x = 3; x < 7; x++) rect[y * w + x] = 1;
  const mask = encodeRle(w, h, rect);

  test("RLE round-trips and validates", () => {
    assert.deepEqual(Array.from(decodeRle(mask)), Array.from(rect));
    assert.doesNotThrow(() => validateRleMask(mask, w, h));
    assert.throws(() => validateRleMask({ ...mask, counts: [1, 2] }, w, h), /sum/);
    assert.throws(() => validateRleMask(mask, 11, h), /expected/);
  });

  test("stats: area, bbox, centroid, border", () => {
    const s = maskStats(mask);
    assert.equal(s.area, 12);
    assert.deepEqual(s.bbox, { xmin: 3, ymin: 2, xmax: 6, ymax: 4 });
    assert.deepEqual(s.centroid, { x: 4.5, y: 3 });
    assert.equal(s.touchesBorder, false);
    assert.equal(maskStats(encodeRle(w, h, new Uint8Array(w * h))).area, 0);
    assert.equal(maskStats(encodeRle(w, h, new Uint8Array(w * h).fill(1))).touchesBorder, true);
  });

  test("a run that wraps rows is counted per row", () => {
    const px = new Uint8Array(w * h);
    for (let i = 8; i < 13; i++) px[i] = 1; // x 8..9 of row 0, x 0..2 of row 1
    const s = maskStats(encodeRle(w, h, px));
    assert.equal(s.area, 5);
    assert.deepEqual(s.bbox, { xmin: 0, ymin: 0, xmax: 9, ymax: 1 });
  });

  test("contains / IoU", () => {
    assert.equal(maskContains(mask, 3.4, 2.9), true);
    assert.equal(maskContains(mask, 0, 0), false);
    assert.equal(maskContains(mask, -1, 3), false);
    assert.equal(maskIou(mask, mask), 1);
    const shifted = new Uint8Array(w * h);
    for (let y = 2; y < 5; y++) for (let x = 5; x < 9; x++) shifted[y * w + x] = 1;
    // Both are 4x3 = 12 px, overlapping on x=5..6 (2x3 = 6 px): 6 / (12 + 12 - 6).
    assert.equal(maskIou(mask, encodeRle(w, h, shifted)), 6 / 18);
    assert.equal(maskIou(mask, encodeRle(5, 5, new Uint8Array(25))), null);
  });
});

describe("contract validation", () => {
  const base: SegmentRequest = {
    image: "data:image/jpeg;base64,ZmFrZQ==",
    imageWidth: W,
    imageHeight: H,
    prompts: { points: [{ x: 10, y: 10, label: 1 }] },
  };
  test("accepts a well-formed request; rejects empty prompts, off-image points, inverted boxes", () => {
    assert.doesNotThrow(() => validateSegmentRequest(base));
    assert.throws(() => validateSegmentRequest({ ...base, prompts: {} }), /at least one/);
    assert.throws(() => validateSegmentRequest({ ...base, prompts: { points: [{ x: W + 1, y: 0, label: 1 }] } }), /outside/);
    assert.throws(() => validateSegmentRequest({ ...base, prompts: { boxes: [{ xmin: 5, ymin: 5, xmax: 4, ymax: 9 }] } }), /box/);
    assert.throws(() => validateSegmentRequest({ ...base, image: "http://x/y.png" }), /data URL/);
  });
  test("response masks must match the request image size", () => {
    const wrong = { provider: "p", mock: false, masks: [{ mask: encodeRle(4, 4, new Uint8Array(16)), score: 0.9 }] };
    assert.throws(() => validateSegmentResponse(wrong, base), /expected/);
  });
});

// ---------------------------------------------------------------- experiment

function discMask(cx: number, cy: number, radius: number) {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) px[y * W + x] = 1;
  return encodeRle(W, H, px);
}

/** Fake SAM: a point prompt yields a disc on the point; text alone yields a disc on the far corner (the "wrong object"). */
function fakeSegment(log: SegmentRequest[]) {
  return async (request: SegmentRequest): Promise<SegmentResponse> => {
    log.push(request);
    const point = request.prompts.points?.[0];
    const mask = point ? discMask(point.x, point.y, 40) : discMask(60, 60, 40);
    return { provider: "fake", mock: true, masks: [{ mask, score: 0.9 }] };
  };
}

const config: ExperimentConfig = {
  anchor,
  text: "pillow",
  variants: ["text", "point", "point+text"],
  occlusionPolicy: "send",
};

describe("experiment orchestration", () => {
  const views = [
    { slot: "front", snapshot: front },
    { slot: "side", snapshot: side },
    { slot: "top", snapshot: top },
  ];

  test("projects one anchor into every view, prompts in pixel space, records visibility", async () => {
    const log: SegmentRequest[] = [];
    const result = await runExperiment(views, config, { live, cast: sphereCaster(), segment: fakeSegment(log) });

    assert.deepEqual(result.views.map((v) => v.visibility?.visibility), ["visible", "visible", "occluded"]);
    // 3 views x 3 variants, "send" policy: the occluded view is still prompted.
    assert.equal(log.length, 9);
    for (const request of log) assert.doesNotThrow(() => validateSegmentRequest(request));

    const frontPoint = result.views[0].variants.find((v) => v.variant === "point")!;
    const projected = projectAnchorToImage(front, anchor, GEN).image!;
    assert.deepEqual(frontPoint.prompts?.points, [{ x: projected.x, y: projected.y, label: 1 }]);
    assert.equal(frontPoint.masks[0].containsAnchor, true);

    // Text-only prompt landed on the wrong object: it does NOT contain the anchor.
    const frontText = result.views[0].variants.find((v) => v.variant === "text")!;
    assert.equal(frontText.masks[0].containsAnchor, false);
    assert.equal(frontText.prompts?.points, undefined);
  });

  test("occlusionPolicy 'skip' does not prompt an occluded view and says why", async () => {
    const log: SegmentRequest[] = [];
    const result = await runExperiment(views, { ...config, occlusionPolicy: "skip" }, { live, cast: sphereCaster(), segment: fakeSegment(log) });
    assert.equal(log.length, 6);
    const topResult = result.views[2];
    assert.ok(topResult.variants.every((v) => v.status === "skipped" && /occluded/.test(v.reason!)));
  });

  test("agreement and cross-view consistency are computed from real geometry", async () => {
    const result = await runExperiment(views.slice(0, 2), { ...config, variants: ["point"] }, { live, cast: sphereCaster(), segment: fakeSegment([]) });
    // Point masks are centred on the projected anchor, so their centroid rays re-hit the anchor.
    const probes = result.centroidProbes.filter((p) => p.variant === "point");
    assert.equal(probes.length, 2);
    for (const probe of probes) assert.ok(probe.distanceToAnchor! < 0.01, `distance ${probe.distanceToAnchor}`);
    assert.ok(result.crossViewSpread[0].spread! < 0.01);

    const withText = await runExperiment(views.slice(0, 1), config, { live, cast: sphereCaster(), segment: fakeSegment([]) });
    const textVsPoint = withText.agreement.find((a) => a.a === "text" && a.b === "point");
    assert.equal(textVsPoint?.iou, 0, "disjoint masks have zero IoU");
  });

  test("a failing provider call is recorded per variant and does not abort the run", async () => {
    let n = 0;
    const flaky = async (request: SegmentRequest) => {
      if (++n === 1) throw new Error("provider 502");
      return fakeSegment([])(request);
    };
    const result = await runExperiment(views.slice(0, 1), config, { live, cast: sphereCaster(), segment: flaky });
    assert.equal(result.views[0].variants[0].status, "error");
    assert.match(result.views[0].variants[0].reason!, /502/);
    assert.equal(result.views[0].variants[1].status, "ok");
  });

  test("out-of-frame anchors skip every variant for that view without calling the provider", async () => {
    const log: SegmentRequest[] = [];
    const far = { x: 50, y: 0, z: 0 };
    const result = await runExperiment(views.slice(0, 1), { ...config, anchor: far }, { live, cast: sphereCaster(), segment: fakeSegment(log) });
    assert.equal(log.length, 0);
    assert.ok(result.views[0].variants.every((v) => v.status === "skipped"));
  });

  test("stale captures (other world / moved splat) are rejected, not projected", async () => {
    const stale = { ...front, worldGeneration: GEN - 1 } as ViewSnapshot;
    const log: SegmentRequest[] = [];
    const result = await runExperiment([{ slot: "front", snapshot: stale }], config, { live, cast: sphereCaster(), segment: fakeSegment(log) });
    assert.match(result.views[0].stale!, /stale/i);
    assert.equal(log.length, 0);
  });

  test("box variants require a box source and carry its box into the request", async () => {
    const log: SegmentRequest[] = [];
    const noSource = await runExperiment(views.slice(0, 1), { ...config, variants: ["box"] }, { live, cast: sphereCaster(), segment: fakeSegment(log) });
    assert.equal(noSource.views[0].variants[0].status, "skipped");
    const withSource = await runExperiment(views.slice(0, 1), { ...config, variants: ["point+box"] }, {
      live, cast: sphereCaster(), segment: fakeSegment(log),
      detectBox: async () => ({ xmin: 100, ymin: 100, xmax: 300, ymax: 300 }),
    });
    assert.equal(withSource.views[0].variants[0].status, "ok");
    assert.deepEqual(log.at(-1)!.prompts.boxes, [{ xmin: 100, ymin: 100, xmax: 300, ymax: 300 }]);
    assert.equal(log.at(-1)!.prompts.points?.length, 1);
  });

  test("export drops mask run data but keeps statistics", async () => {
    const result = await runExperiment(views.slice(0, 1), { ...config, variants: ["point"] }, { live, cast: sphereCaster(), segment: fakeSegment([]) });
    const exported = JSON.stringify(exportExperiment(result));
    assert.ok(!exported.includes("primaryMask"));
    assert.ok(exported.includes("areaFraction"));
  });

  test("primary mask prefers one containing the anchor over a higher-scoring one that does not", () => {
    const stats = maskStats(discMask(10, 10, 3));
    assert.equal(choosePrimary([
      { score: 0.99, stats, containsAnchor: false },
      { score: 0.6, stats, containsAnchor: true },
    ]), 1);
    assert.equal(choosePrimary([]), null);
  });
});
