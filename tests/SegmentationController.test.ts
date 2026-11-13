import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { SegmentationController, type SegmentationHost } from "../src/segmentation/SegmentationController.ts";
import type { CastFn } from "../src/segmentation/geometry.ts";
import type { SegmentRequest } from "../src/segmentation/contract.ts";
import { encodeRle } from "../src/segmentation/maskAnalysis.ts";
import { captureViewSnapshot, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

// Minimal window: the controller only adds/removes a capture-phase click listener.
type Listener = (event: unknown) => void;
const listeners: Listener[] = [];
const g = globalThis as unknown as { window?: unknown };
let savedWindow: unknown;
beforeEach(() => {
  savedWindow = g.window;
  listeners.length = 0;
  g.window = {
    addEventListener: (_t: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_t: string, fn: Listener) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
});
afterEach(() => { g.window = savedWindow; });

const W = 800, H = 600;
const canvas = {
  width: W, height: H, clientWidth: W / 2, clientHeight: H / 2,
  getBoundingClientRect: () => ({ left: 10, top: 20, width: W / 2, height: H / 2 }),
  toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
};

function makeHost() {
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);
  const scene = new THREE.Scene();
  scene.add(camera);
  const renderer = {
    domElement: canvas,
    render: () => { scene.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); },
  } as unknown as THREE.WebGLRenderer;
  const splat = new THREE.Object3D();
  const state = { worldGeneration: 1 };
  const host: SegmentationHost = {
    camera, renderer, currentSplat: splat, splatLoaded: true,
    liveWorldState: () => ({ worldGeneration: state.worldGeneration, splat, splatLoaded: true }),
  };
  const snap = (): ViewSnapshot => ({
    ...captureViewSnapshot(renderer, scene, camera, null, 1),
    splat: { matrixWorld: Array.from(splat.matrixWorld.elements) },
  }) as ViewSnapshot;
  return { host, snap, state };
}

/** Sphere of radius 0.3 at the origin, nearest hit only needed. */
const sphere: CastFn = (origin, direction) => {
  const o = new THREE.Vector3(origin.x, origin.y, origin.z);
  const d = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
  const b = o.dot(d), c = o.lengthSq() - 0.09, disc = b * b - c;
  if (disc < 0) return [];
  const t = -b - Math.sqrt(disc);
  return t > 0 ? [{ distance: t, point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t } }] : [];
};

const segment = async (r: SegmentRequest) => ({
  provider: "fake", mock: true,
  masks: [{ mask: encodeRle(r.imageWidth, r.imageHeight, new Uint8Array(r.imageWidth * r.imageHeight)), score: 0.5 }],
});

function make(captures: () => { slot: string; snapshot: ViewSnapshot }[], host: SegmentationHost) {
  return new SegmentationController({ host, getCaptures: captures, segment, detectBox: async () => null, makeCaster: () => sphere });
}

describe("SegmentationController", () => {
  test("pickAt finds a stable anchor on the surface through the real camera", () => {
    const { host } = makeHost();
    const c = make(() => [], host);
    const pick = c.pickAt(0.5, 0.5, { width: W / 2, height: H / 2 })!;
    assert.ok(pick);
    const a = pick.refinement.anchor;
    assert.ok(Math.abs(a.x) < 0.01 && Math.abs(a.y) < 0.01 && Math.abs(a.z - 0.3) < 0.01, `anchor ${JSON.stringify(a)}`);
    assert.equal(pick.refinement.stable, true);
    assert.equal(c.state().picking, false);
  });

  test("a pick on empty space reports it instead of inventing an anchor", () => {
    const { host } = makeHost();
    const c = make(() => [], host);
    assert.equal(c.pickAt(0.02, 0.02, { width: W / 2, height: H / 2 }), null);
    assert.match(c.state().status, /No splat hit/);
    assert.equal(c.state().anchor, null);
  });

  test("armed click on the canvas is consumed (production handler never sees it); other targets are ignored", () => {
    const { host } = makeHost();
    const c = make(() => [], host);
    c.setPicking(true);
    const consumed: string[] = [];
    const event = (target: unknown) => ({
      target, clientX: 10 + W / 4, clientY: 20 + H / 4,
      stopImmediatePropagation: () => consumed.push("stop"), preventDefault: () => consumed.push("prevent"),
    });
    for (const l of listeners) l(event({}));
    assert.deepEqual(consumed, [], "click on another element is left alone");
    assert.equal(c.state().picking, true);
    for (const l of listeners) l(event(canvas));
    assert.deepEqual(consumed, ["stop", "prevent"]);
    assert.ok(c.state().anchor, "anchor derived from the click position relative to the canvas rect");
    // Not armed any more: the next click passes through.
    consumed.length = 0;
    for (const l of listeners) l(event(canvas));
    assert.deepEqual(consumed, []);
  });

  test("run needs an anchor and captures, then produces a result; an anchor from a replaced world is dropped", async () => {
    const { host, snap, state } = makeHost();
    const views = [{ slot: "front", snapshot: snap() }];
    const c = make(() => views, host);
    assert.equal(await c.run(), null);
    assert.match(c.state().status, /anchor first/);

    c.pickAt(0.5, 0.5, { width: W / 2, height: H / 2 });
    c.configure({ text: "pillow", variants: ["point"] });
    const result = await c.run();
    assert.ok(result);
    assert.equal(result!.views[0].variants[0].variant, "point");
    assert.match(c.state().status, /MOCK/);
    assert.equal(c.state().running, false);

    state.worldGeneration = 2; // world reloaded
    assert.equal(c.state().anchor, null);
    assert.equal(c.state().result, null);
    assert.match(c.state().status, /World changed/);
  });

  test("dispose removes the click listener", () => {
    const { host } = makeHost();
    const c = make(() => [], host);
    assert.equal(listeners.length, 1);
    c.dispose();
    assert.equal(listeners.length, 0);
  });
});
