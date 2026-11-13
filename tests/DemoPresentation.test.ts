import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { DemoController, type DemoHost } from "../src/demo/DemoController.ts";
import {
  CAPTURE_SLOTS,
  PresentationCaptureStore,
  sceneLabelFromUrl,
} from "../src/demo/presentationCaptures.ts";
import { captureViewSnapshot, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

// ---------------------------------------------------------------- fake DOM

class FakeEl {
  children: FakeEl[] = [];
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  src = "";
  alt = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  classList = { toggle() {}, add() {}, remove() {} };
  readonly tag: string;
  blurred = 0;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: FakeEl[]) { this.children.push(...nodes); }
  appendChild(node: FakeEl) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeEl[]) { this.children = [...nodes]; }
  remove() { removed.add(this); }
  blur() { this.blurred++; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(type: string, fn: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  click() { for (const fn of this.listeners.get("click") ?? []) fn({ stopPropagation() {} }); }
  dispatchEvent() { return true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  getContext() {
    return new Proxy({ measureText: (t: string) => ({ width: t.length * 12 }) } as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : () => {}),
      set: (target, key, value) => { target[key as string] = value; return true; },
    });
  }
}
const removed = new Set<FakeEl>();

function find(node: FakeEl, test: (n: FakeEl) => boolean): FakeEl[] {
  if (removed.has(node)) return [];
  return [...(test(node) ? [node] : []), ...node.children.flatMap((c) => find(c, test))];
}
function text(node: FakeEl): string {
  if (removed.has(node)) return "";
  return [node.textContent, ...node.children.map(text)].join("\n");
}

interface Listener { type: string; fn: (event: unknown) => void; capture: boolean }

function installEnv() {
  const listeners: Listener[] = [];
  const body = new FakeEl("body");
  const head = new FakeEl("head");
  const fakeWindow = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    fetch: async () => new Response("{}"),
    setTimeout, clearTimeout,
    addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean | { passive?: boolean }) =>
      listeners.push({ type, fn, capture: capture === true }),
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const g = globalThis as Record<string, unknown>;
  const previous = { window: g.window, document: g.document };
  g.window = fakeWindow;
  g.document = { createElement: (tag: string) => new FakeEl(tag), head, body };
  return {
    listeners, body,
    key(code: string) {
      const event = { code, key: code, shiftKey: true, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault() {}, stopImmediatePropagation() {} };
      for (const l of [...listeners]) if (l.type === "keydown" && l.capture) l.fn(event);
    },
    restore() { g.window = previous.window; g.document = previous.document; },
  };
}

// ---------------------------------------------------------------- fake host

class FakeSplat extends THREE.Object3D {
  isInitialized = true;
  packedSplats = {};
  context = { numSplats: { value: 1000 } };
}

function makeHost() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.01, 1000);
  const rig = new THREE.Group();
  rig.add(camera);
  rig.position.set(0, 0, -3);
  scene.add(new FakeSplat(), rig);
  const splat = scene.children[0] as FakeSplat;
  const canvas = new FakeEl("canvas");
  // The fake "image" encodes the camera pose at render time, so a test can tell
  // which pose a stored image really came from.
  let renderedPose = "";
  const log = { rendersWithOverlayVisible: 0, renders: 0, overlayRoot: null as THREE.Object3D | null };
  Object.assign(canvas, {
    clientWidth: 400, clientHeight: 300, width: 800, height: 600,
    toDataURL: () => `data:image/jpeg;base64,${Buffer.from(renderedPose).toString("base64")}`,
  });
  const renderer = {
    domElement: canvas,
    render: () => {
      log.renders++;
      if (log.overlayRoot?.visible) log.rendersWithOverlayVisible++;
      scene.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      renderedPose = camera.matrixWorld.elements.map((v) => v.toFixed(6)).join(",");
    },
  };
  const state = { generation: 1, loaded: true };
  const host = {
    camera, cameraRig: rig, cameraOrientTarget: null, scene,
    renderer, currentSplat: splat as FakeSplat | null, splatLoaded: true, isSelecting: true,
    currentWorldUrl: "/Apartment.sog",
    annotationDiagnostics: null, objectHighlighter: null, annotations: [],
    annotationMetadataStore: { list: () => [] },
    captureViewSnapshot() { return captureViewSnapshot(renderer as never, scene, camera, splat, state.generation); },
    splatRay: () => null,
    async clearAllSelections() {},
    liveWorldState: () => ({ worldGeneration: state.generation, splat, splatLoaded: state.loaded }),
  } as unknown as DemoHost & { currentSplat: FakeSplat | null };
  return { host, scene, camera, rig, canvas, state, log };
}

const poseOf = (snapshot: ViewSnapshot) => Buffer.from(snapshot.image.dataUrl.split(",")[1], "base64").toString();

// ------------------------------------------------------------------- tests

describe("presentation capture store", () => {
  test("slot assignment is manual, independent, and replaces only the chosen slot", () => {
    const env = installEnv();
    try {
      const h = makeHost();
      const store = new PresentationCaptureStore();
      const take = (x: number) => { h.rig.position.x = x; return h.host.captureViewSnapshot(); };

      const side = store.assign("side", take(1), 1_000);
      assert.equal(store.count(), 1);
      assert.deepEqual(store.slots().map((c) => c?.slot ?? null), [null, "side", null], "slot order is fixed, not pose-derived");
      const rear = store.assign("rear", take(2), 2_000);
      const front = store.assign("front", take(3), 3_000);
      assert.equal(store.count(), 3);
      assert.equal(new Set([front.id, side.id, rear.id]).size, 3, "unique capture IDs");
      assert.equal(front.capturedAtIso, new Date(3_000).toISOString());

      const sideAgain = store.assign("side", take(4), 4_000);
      assert.equal(store.count(), 3, "re-capturing a slot does not add a fourth");
      assert.notEqual(sideAgain.id, side.id);
      assert.equal(store.get("front"), front, "other slots untouched");
      assert.equal(store.get("rear"), rear);
    } finally { env.restore(); }
  });

  test("a stored capture is frozen and independent of later camera movement", () => {
    const env = installEnv();
    try {
      const h = makeHost();
      const store = new PresentationCaptureStore();
      const capture = store.assign("front", h.host.captureViewSnapshot(), 5);
      const before = JSON.stringify(capture);
      const beforePose = poseOf(capture.snapshot);

      h.rig.position.set(9, 9, 9);
      h.rig.rotateY(1);
      h.host.captureViewSnapshot(); // later frames render with the moved camera

      assert.equal(JSON.stringify(capture), before);
      assert.equal(poseOf(capture.snapshot), beforePose);
      assert.ok(Object.isFrozen(capture) && Object.isFrozen(capture.snapshot) && Object.isFrozen(capture.snapshot.camera));
      assert.deepEqual(capture.snapshot.camera.position, { x: 0, y: 0, z: -3 });
      assert.throws(() => { (capture as { slot: string }).slot = "rear"; }, TypeError);
    } finally { env.restore(); }
  });

  test("rejects unknown slots and malformed snapshots without disturbing existing captures", () => {
    const env = installEnv();
    try {
      const h = makeHost();
      const store = new PresentationCaptureStore();
      const good = store.assign("front", h.host.captureViewSnapshot(), 1);
      assert.throws(() => store.assign("top" as never, h.host.captureViewSnapshot(), 2), RangeError);
      assert.throws(() => store.assign("rear", { id: "x" } as never, 2), TypeError);
      assert.equal(store.count(), 1);
      assert.equal(store.get("front"), good);
    } finally { env.restore(); }
  });

  test("dropOtherWorlds removes only captures from a replaced world", () => {
    const env = installEnv();
    try {
      const h = makeHost();
      const store = new PresentationCaptureStore();
      store.assign("front", h.host.captureViewSnapshot(), 1);
      h.state.generation = 2;
      store.assign("side", h.host.captureViewSnapshot(), 2);
      assert.equal(store.dropOtherWorlds(2), 1);
      assert.deepEqual(store.slots().map((c) => c?.slot ?? null), [null, "side", null]);
    } finally { env.restore(); }
  });

  test("scene label comes from the world URL", () => {
    assert.equal(sceneLabelFromUrl("/Apartment.sog"), "Apartment");
    assert.equal(sceneLabelFromUrl("https://x.test/a/office_space.sog?v=2#h"), "office space");
    assert.equal(sceneLabelFromUrl("/My%20Room.spz"), "My Room");
    assert.equal(sceneLabelFromUrl(null), "Scene");
    assert.equal(sceneLabelFromUrl(""), "Scene");
  });
});

describe("presentation mode in the demo controller (fake DOM)", () => {
  let env: ReturnType<typeof installEnv>;
  let controllers: DemoController[];
  beforeEach(() => {
    removed.clear();
    env = installEnv();
    controllers = [];
    mock.method(performance, "now", () => 1000);
  });
  afterEach(() => {
    for (const c of controllers) c.dispose();
    mock.restoreAll();
    env.restore();
  });

  const create = (h: ReturnType<typeof makeHost>, options: ConstructorParameters<typeof DemoController>[1] = {}) => {
    const controller = new DemoController(h.host, { storage: null, ...options });
    h.log.overlayRoot = controller.root;
    controllers.push(controller);
    return controller;
  };
  const hudRoot = () => find(env.body, (n) => n.attrs.get("data-demo-hud") === "true")[0];
  const panelRoot = () => find(env.body, (n) => n.attrs.get("data-presentation") === "true")[0];
  const button = (slot: string) => find(panelRoot(), (n) => n.tag === "button" && new RegExp(`apture ${slot}`, "i").test(n.textContent))[0];
  const card = (slot: string) => find(panelRoot(), (n) => n.attrs.get("data-slot") === slot)[0];
  const thumb = (slot: string) => find(card(slot), (n) => n.tag === "img")[0];

  test("normal demo mode keeps the engineering HUD and has no presentation UI or shortcuts", () => {
    const h = makeHost();
    const d = create(h);
    assert.ok(hudRoot(), "engineering HUD exists");
    assert.notEqual(hudRoot().style.display, "none");
    assert.equal(panelRoot(), undefined);
    assert.equal(d.state().presentation, null);
    env.key("Digit1");
    assert.equal(h.log.renders, 0, "Shift+1 does nothing outside presentation mode");
    assert.equal(d.capturePresentationSlot("front"), null);
    assert.equal(d.counters.presentationCaptures, 0);
  });

  test("presentation mode hides only the engineering HUD and shows scene, count and three slots", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    assert.equal(hudRoot().style.display, "none", "engineering HUD hidden");
    assert.ok(panelRoot());
    const ui = text(panelRoot());
    assert.match(ui, /Apartment/);
    assert.match(ui, /0 \/ 3 captured/);
    for (const slot of CAPTURE_SLOTS) assert.ok(button(slot.title), `${slot.title} button`);
    assert.equal(d.toggleHud(), true, "engineering HUD stays reachable via the existing Shift+G toggle");
    assert.equal(h.log.renders, 0, "building the UI renders nothing");
  });

  test("each slot captures its own pose; earlier captures survive camera movement", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });

    h.rig.position.set(0, 0, -3); button("Side").click();
    const afterFirst = d.state().presentation!;
    assert.equal(afterFirst.count, 1);
    assert.equal(afterFirst.captures[0], null, "Front untouched");
    assert.ok(afterFirst.captures[1], "Side filled");

    h.rig.position.set(4, 0, -3); env.key("Digit3"); // Shift+3 → Rear
    h.rig.position.set(-4, 1, 2); button("Front").click();

    const [front, side, rear] = d.state().presentation!.captures;
    assert.equal(d.state().presentation!.count, 3);
    assert.deepEqual([front!.slot, side!.slot, rear!.slot], ["front", "side", "rear"]);
    assert.deepEqual(front!.snapshot.camera.position, { x: -4, y: 1, z: 2 });
    assert.deepEqual(side!.snapshot.camera.position, { x: 0, y: 0, z: -3 });
    assert.deepEqual(rear!.snapshot.camera.position, { x: 4, y: 0, z: -3 });
    // Each stored image was rendered from exactly its recorded pose.
    for (const capture of [front!, side!, rear!]) {
      const encoded = poseOf(capture.snapshot).split(",").map(Number);
      capture.snapshot.camera.worldMatrix.forEach((v, i) => assert.ok(Math.abs(v - encoded[i]) < 1e-5));
    }
    assert.equal(new Set([front!.id, side!.id, rear!.id]).size, 3);

    const thumbs = ["front", "side", "rear"].map((s) => thumb(s).src);
    const before = JSON.stringify(d.state().presentation);

    // Move the camera a lot; nothing captured changes.
    for (let i = 0; i < 20; i++) { h.rig.position.x += 0.5; h.rig.rotateY(0.1); }
    h.host.captureViewSnapshot();
    assert.equal(JSON.stringify(d.state().presentation), before);
    assert.deepEqual(["front", "side", "rear"].map((s) => thumb(s).src), thumbs);
    assert.equal(new Set(thumbs).size, 3, "three distinct thumbnails");
    assert.match(text(panelRoot()), /3 \/ 3 captured/);
  });

  test("re-capturing one slot replaces only that slot", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    h.rig.position.x = 1; button("Front").click();
    h.rig.position.x = 2; button("Side").click();
    const [front1, side1] = d.state().presentation!.captures;
    h.rig.position.x = 3; button("Side").click();
    const [front2, side2] = d.state().presentation!.captures;
    assert.equal(front2, front1);
    assert.notEqual(side2!.id, side1!.id);
    assert.equal(d.state().presentation!.count, 2);
    assert.match(text(card("side")), /Re-capture Side/);
  });

  test("presentation capture is one render, hides demo overlays, and leaves the annotation pipeline alone", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    button("Front").click();
    assert.equal(h.log.renders, 1, "exactly one GPU render pass per capture");
    assert.equal(h.log.rendersWithOverlayVisible, 0, "demo geometry hidden while rendering");
    assert.equal(d.root.visible, true, "overlay visibility restored");
    assert.equal(d.counters.captures, 0, "production snapshot counter untouched");
    assert.equal(d.counters.presentationCaptures, 1);
    assert.equal(d.state().hasSnapshot, false, "no annotation snapshot adopted");
    assert.ok(button("Front").blurred >= 1, "focus released so camera keys keep working");
  });

  test("production capture still goes through the demo wrapper and counts", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    h.host.captureViewSnapshot();
    assert.equal(d.counters.captures, 1);
    assert.equal(h.log.rendersWithOverlayVisible, 0);
  });

  test("capture before the scene is ready warns and stores nothing", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    h.host.splatLoaded = false;
    button("Front").click();
    assert.equal(h.log.renders, 0);
    assert.equal(d.state().presentation!.count, 0);
    assert.match(text(panelRoot()), /still loading/);
  });

  test("confirmation names the slot; captures from a replaced world are dropped", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    button("Rear").click();
    assert.match(text(panelRoot()), /Rear view captured/);
    h.state.generation = 2;
    (d as unknown as { refreshHud(force: boolean): void }).refreshHud(true);
    assert.equal(d.state().presentation!.count, 0);
    assert.match(text(panelRoot()), /0 \/ 3 captured/);
  });

  test("dispose removes the presentation UI", () => {
    const h = makeHost();
    const d = create(h, { presentation: true });
    assert.ok(panelRoot());
    d.dispose();
    assert.equal(panelRoot(), undefined);
  });
});
