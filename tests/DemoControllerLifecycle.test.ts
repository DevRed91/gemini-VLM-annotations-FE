import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { DemoController, type DemoHost } from "../src/demo/DemoController.ts";
import { HELPER_WARNING } from "../src/demo/helperDetection.ts";
import { captureViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

// ---------------------------------------------------------------- fake DOM

class FakeEl {
  children: FakeEl[] = [];
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  src = "";
  alt = "";
  width = 0;
  height = 0;
  id = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  classList = { toggle() {}, add() {}, remove() {} };
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: FakeEl[]) { this.children.push(...nodes); }
  appendChild(node: FakeEl) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeEl[]) { this.children = [...nodes]; }
  remove() { removed.add(this); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(type: string, fn: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  click() { for (const fn of this.listeners.get("click") ?? []) fn({ stopPropagation() {} }); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; }
  getContext() {
    return new Proxy({ measureText: (t: string) => ({ width: t.length * 12 }) } as Record<string, unknown>, {
      get: (target, key) => (key in target ? target[key as string] : () => {}),
      set: (target, key, value) => { target[key as string] = value; return true; },
    });
  }
}
const removed = new Set<FakeEl>();

function text(node: FakeEl): string {
  if (removed.has(node)) return "";
  return [node.textContent, ...node.children.map(text)].join("\n");
}
function find(node: FakeEl, test: (n: FakeEl) => boolean): FakeEl[] {
  return [...(test(node) ? [node] : []), ...node.children.flatMap((c) => find(c, test))];
}

interface Listener { type: string; fn: (event: unknown) => void; capture: boolean }

function installEnv() {
  const listeners: Listener[] = [];
  const body = new FakeEl("body");
  const head = new FakeEl("head");
  const fakeWindow = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    fetch: async () => new Response("{}"),
    setTimeout,
    clearTimeout,
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
    listeners, body, fakeWindow,
    key(code: string, shiftKey = true) {
      const event = { code, key: code.replace("Key", "").toLowerCase(), shiftKey, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault() {}, stopImmediatePropagation() {} };
      for (const l of [...listeners]) if (l.type === "keydown" && l.capture) { l.fn(event); }
    },
    pressD() {
      const event = { key: "d", repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null };
      for (const l of [...listeners]) if (l.type === "keydown" && !l.capture) l.fn(event);
    },
    restore() { g.window = previous.window; g.document = previous.document; },
  };
}

// ---------------------------------------------------------------- fake host

// Stand-in for production AnnotationDiagnostics: its source uses TypeScript parameter
// properties, which Node's strip-only loader rejects, so tests cannot import it. This
// mirrors the surface the demo touches (isEnabled/setEnabled/toggle/dispose) and the
// window "d" keydown shortcut. The real D handler is therefore NOT exercised here.
class FakeDiagnostics {
  private enabled = true;
  private readonly onKey: (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean }) => void;
  constructor() {
    this.onKey = (e) => {
      if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) this.toggle();
    };
    (globalThis as unknown as { window: { addEventListener: (t: string, f: unknown) => void } }).window.addEventListener("keydown", this.onKey);
  }
  get isEnabled(): boolean { return this.enabled; }
  setEnabled(value: boolean): void { this.enabled = value; }
  toggle(): void { this.enabled = !this.enabled; }
  last(): null { return null; }
  dispose(): void {
    (globalThis as unknown as { window: { removeEventListener: (t: string, f: unknown) => void } }).window.removeEventListener("keydown", this.onKey);
  }
}


class FakeSplat extends THREE.Object3D {
  raycastable = true;
  isInitialized = true;
  packedSplats = {};
  context = { numSplats: { value: 1000 } };
  raycasts = 0;
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    this.raycasts++;
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 8);
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (point) intersects.push({ distance: point.distanceTo(raycaster.ray.origin), point, object: this });
  }
}

function makeHost(env: ReturnType<typeof installEnv>) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.01, 1000);
  const rig = new THREE.Group();
  rig.add(camera);
  rig.position.set(0, 0, -3);
  rig.rotateY(Math.PI);
  const splat = new FakeSplat();
  scene.add(splat, rig);
  const canvas = new FakeEl("canvas");
  Object.assign(canvas, { clientWidth: 400, clientHeight: 300, width: 800, height: 600, toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==" });
  const renderer = {
    domElement: canvas,
    render: () => { scene.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); },
  };
  const diagnostics = new FakeDiagnostics();
  const calls = { clearAll: 0, splatRay: 0 };
  const annotations: { apartmentId: string; helper?: THREE.Object3D }[] = [];
  const records: { annotationId: string }[] = [];
  const host = {
    camera, cameraRig: rig, cameraOrientTarget: null, scene,
    renderer, currentSplat: splat, splatLoaded: true, isSelecting: true,
    annotationDiagnostics: diagnostics, objectHighlighter: null, annotations,
    annotationMetadataStore: { list: () => [...records] },
    captureViewSnapshot() { return captureViewSnapshot(renderer as never, scene, camera, splat, 1); },
    splatRay(x: number, y: number) {
      calls.splatRay++;
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera);
      const hits = rc.intersectObject(splat);
      return { ray: rc.ray, intersection: hits[0] ?? null };
    },
    async clearAllSelections() {
      calls.clearAll++;
      for (const a of annotations) a.helper?.removeFromParent();
      annotations.length = 0;
      records.length = 0;
    },
    liveWorldState: () => ({ worldGeneration: 1, splat, splatLoaded: true }),
  } as unknown as DemoHost;
  const addAnnotation = (id: string) => {
    const helper = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    helper.visible = false;
    splat.add(helper);
    annotations.push({ apartmentId: id, helper });
    records.push({ annotationId: id });
    return helper;
  };
  void env;
  return { host, scene, camera, rig, splat, diagnostics, calls, annotations, records, addAnnotation, canvas };
}

// ------------------------------------------------------------------- tests

describe("demo controller lifecycle (fake DOM, fake AnnotationDiagnostics)", () => {
  let env: ReturnType<typeof installEnv>;
  let clock: { t: number };
  let controllers: DemoController[];

  beforeEach(() => {
    removed.clear();
    env = installEnv();
    clock = { t: 1000 };
    controllers = [];
    mock.method(performance, "now", () => clock.t);
  });
  afterEach(() => {
    for (const c of controllers) c.dispose();
    mock.restoreAll();
    env.restore();
  });

  function create(rig: ReturnType<typeof makeHost>, options: ConstructorParameters<typeof DemoController>[1] = {}) {
    const controller = new DemoController(rig.host, { storage: null, ...options });
    controllers.push(controller);
    const tick = controller.overlay.group.children.find((c) => (c as THREE.Points).isPoints && (c as THREE.Points).geometry.getAttribute("position").count === 1) as THREE.Points;
    const frame = (ms = 16) => {
      clock.t += ms;
      rig.rig.updateMatrixWorld(true);
      (tick.onBeforeRender as unknown as () => void)();
    };
    const run = (ms: number) => { for (let e = 0; e < ms; e += 16) frame(); };
    const moveTo = (x: number) => { rig.rig.position.x = x; };
    const hud = () => text(env.body);
    /** Production click flow: window click capture -> production captures -> window click bubble. */
    const capture = () => {
      const event = { target: rig.canvas, clientX: 200, clientY: 150 };
      for (const l of env.listeners) if (l.type === "click" && l.capture) l.fn(event);
      rig.host.captureViewSnapshot();
      for (const l of env.listeners) if (l.type === "click" && !l.capture) l.fn(event);
    };
    return { controller, frame, run, moveTo, hud, capture };
  }

  test("camera-only live rays are the default and cast nothing into the splat while moving", () => {
    const rig = makeHost(env);
    const d = create(rig);
    assert.equal(d.controller.state().liveMode, "ray");
    d.capture();
    assert.equal(d.controller.state().hasSnapshot, true);
    rig.splat.raycasts = 0;
    rig.calls.splatRay = 0;
    for (let i = 0; i < 120; i++) {
      d.moveTo(i * 0.02);
      d.frame();
    }
    assert.equal(rig.splat.raycasts, 0, "zero splat.raycast calls while the camera moves");
    assert.equal(rig.calls.splatRay, 0);
    // The live rays follow the camera: segment origins are the live camera position.
    const segments = d.controller.overlay.group.children.find((c) => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments;
    const pos = segments.geometry.getAttribute("position");
    const camera = rig.camera.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.hypot(pos.getX(0) - camera.x, pos.getY(0) - camera.y, pos.getZ(0) - camera.z) < 1e-4);
    assert.match(d.hud(), /camera rays · no splat intersection/);
  });

  test("end to end: nine casts after settle, none while still, nine more after moving and settling", () => {
    const rig = makeHost(env);
    const d = create(rig);
    d.capture();
    rig.splat.raycasts = 0;
    d.run(1000);
    assert.equal(rig.splat.raycasts, 9);
    d.run(5000);
    assert.equal(rig.splat.raycasts, 9, "no repeats while stationary");
    assert.match(d.hud(), /CURRENT/);
    assert.equal(d.controller.state().settled?.status, "current");

    d.moveTo(0.5);
    d.frame();
    assert.match(d.hud(), /STALE/);
    assert.match(d.hud(), /NOT a current hit comparison/);
    assert.equal(rig.splat.raycasts, 9);
    const stale = d.controller.state().settled!;
    assert.equal(stale.status, "stale");

    d.run(1000);
    assert.equal(rig.splat.raycasts, 18);
    const fresh = d.controller.state().settled!;
    assert.equal(fresh.status, "current");
    assert.ok(fresh.measuredAtMs > stale.measuredAtMs);
  });

  test("splat not ready: no casts until the real readiness inputs are present", () => {
    const rig = makeHost(env);
    rig.splat.context.numSplats.value = 0;
    const d = create(rig);
    d.capture();
    rig.splat.raycasts = 0;
    d.run(2000);
    assert.equal(rig.splat.raycasts, 0);
    assert.equal(d.controller.state().settledStatus, "waiting-for-splat");
    assert.match(d.hud(), /WAITING FOR SPLAT/);
    rig.splat.context.numSplats.value = 1000;
    d.run(100);
    assert.equal(rig.splat.raycasts, 9);
  });

  test("helper warning: absent when clean, persistent when helpers/records exist, refreshes on change", () => {
    const rig = makeHost(env);
    const d = create(rig);
    d.run(200);
    assert.equal(d.hud().includes(HELPER_WARNING), false);
    rig.addAnnotation("annotation-1");
    d.run(700); // HUD/helper refresh is throttled
    assert.ok(d.hud().includes(HELPER_WARNING));
    assert.equal(d.controller.state().helpers.annotationCount, 1, "helper + live + stored record counted once");
    assert.equal(d.controller.state().helpers.helperCount, 1);
    d.run(2000);
    assert.ok(d.hud().includes(HELPER_WARNING), "persistent");
    assert.equal(rig.splat.children[0].visible, false, "helpers are never made visible");
    assert.equal(rig.splat.children.length, 1, "helpers are never removed by the warning");
  });

  test("settled measurement taken with helpers present carries a contamination warning", () => {
    const rig = makeHost(env);
    rig.addAnnotation("annotation-1");
    const d = create(rig);
    d.capture();
    d.run(1000);
    assert.equal(d.controller.state().settled?.helperCountAtMeasurement, 1);
    assert.match(d.hud(), /annotation helper\(s\) were in the scene/);
  });

  test("Shift+R resets demo state and the camera but preserves annotations and never calls clearAllSelections", () => {
    const rig = makeHost(env);
    rig.addAnnotation("annotation-1");
    rig.addAnnotation("annotation-2");
    const d = create(rig);
    assert.equal(rig.calls.clearAll, 0, "initialization never clears");
    d.capture();
    d.run(1000);
    d.moveTo(2);
    d.frame();
    env.key("KeyR");
    assert.equal(rig.calls.clearAll, 0);
    assert.equal(rig.annotations.length, 2);
    assert.equal(rig.records.length, 2);
    assert.equal(rig.splat.children.length, 2);
    assert.equal(d.controller.state().hasSnapshot, false);
    assert.equal(d.controller.state().settled, null);
    assert.equal(rig.rig.position.x, 0, "home pose restored");
  });

  test("Reset + Clear Annotations: needs confirmation, then clears, verifies and updates the HUD", async () => {
    const rig = makeHost(env);
    rig.addAnnotation("annotation-1");
    rig.addAnnotation("annotation-2");
    const d = create(rig);
    d.run(700);

    // Confirming without arming does nothing.
    assert.deepEqual(await d.controller.confirmClearAnnotations(), { status: "not-armed" });
    assert.equal(rig.calls.clearAll, 0);

    // The HUD buttons implement the two steps.
    const buttons = find(env.body, (n) => n.tag === "button");
    const request = buttons.find((b) => b.textContent === "Reset + Clear Annotations")!;
    const confirm = buttons.find((b) => b.className === "danger armed")!;
    request.click();
    assert.equal(rig.calls.clearAll, 0, "arming alone deletes nothing");
    assert.match(d.hud(), /Confirm: reset \+ delete 2 annotation\(s\)/);

    // Shift+R while armed cancels the arm and still does not clear.
    env.key("KeyR");
    assert.equal(rig.calls.clearAll, 0);
    assert.deepEqual(await d.controller.confirmClearAnnotations(), { status: "not-armed" });

    request.click();
    confirm.click();
    await new Promise((r) => setImmediate(r));
    assert.equal(rig.calls.clearAll, 1);
    assert.equal(rig.annotations.length, 0);
    assert.equal(rig.records.length, 0);
    assert.equal(rig.splat.children.length, 0);
    assert.equal(d.controller.state().helpers.annotationCount, 0);
    assert.match(d.hud(), /cleared 2 annotation\(s\) · verified 0 remain/);
    assert.equal(d.hud().includes(HELPER_WARNING), false, "warning disappears once state is clean");

    // The arm was consumed: a second confirm is a no-op.
    assert.deepEqual(await d.controller.confirmClearAnnotations(), { status: "not-armed" });
    assert.equal(rig.calls.clearAll, 1);
  });

  test("clear reports incomplete when something survives", async () => {
    const rig = makeHost(env);
    rig.addAnnotation("annotation-1");
    rig.host.clearAllSelections = async () => { /* broken: removes nothing */ };
    const d = create(rig);
    d.controller.requestClearAnnotations();
    const result = await d.controller.confirmClearAnnotations();
    assert.equal(result.status === "cleared" && result.complete, false);
    assert.match(d.hud(), /CLEAR INCOMPLETE/);
  });

  test("diagnostics markers are OFF on mount, D toggles them, and the original state returns on dispose", () => {
    const rig = makeHost(env);
    assert.equal(rig.diagnostics.isEnabled, true, "production default");
    const d = create(rig);
    assert.equal(rig.diagnostics.isEnabled, false, "disabled on mount");
    env.pressD();
    assert.equal(rig.diagnostics.isEnabled, true, "D toggles on");
    env.pressD();
    assert.equal(rig.diagnostics.isEnabled, false, "D toggles off");
    env.pressD();
    d.controller.dispose();
    assert.equal(rig.diagnostics.isEnabled, true, "restored to the pre-demo state");
    rig.diagnostics.dispose();
  });

  test("diagnostics that were already off stay off after dispose", () => {
    const rig = makeHost(env);
    rig.diagnostics.setEnabled(false);
    const d = create(rig);
    env.pressD();
    d.controller.dispose();
    assert.equal(rig.diagnostics.isEnabled, false);
    rig.diagnostics.dispose();
  });

  test("dispose removes every demo listener, DOM node and scene object", () => {
    const rig = makeHost(env);
    const before = env.listeners.length;
    const d = create(rig);
    assert.ok(env.listeners.length > before);
    d.controller.dispose();
    assert.equal(env.listeners.length, before);
    assert.equal(rig.scene.children.some((c) => c.name === "demo-root"), false);
    assert.equal(find(env.body, (n) => n.attrs.has("data-demo-hud")).length > 0, true, "node object still referenced...");
    assert.equal(text(env.body).includes("SETTLED LIVE MEASUREMENT"), false, "...but detached from the document");
  });

  test("Scene F captions are separate from the HUD, static, and never move the camera", () => {
    const rig = makeHost(env);
    const d = create(rig);
    const hudRoot = find(env.body, (n) => n.attrs.has("data-demo-hud"))[0];
    const panel = find(env.body, (n) => n.attrs.has("data-demo-captions"))[0];
    assert.ok(panel && hudRoot && panel !== hudRoot);
    assert.equal(find(hudRoot, (n) => n === panel).length, 0, "captions are not inside the demo HUD");
    assert.equal(panel.style.display, "none");
    assert.equal(d.controller.cycleCaptions(), "setup");
    assert.equal(d.controller.bindScenePose("front"), false, "nothing logged yet, nothing invented");
    const logged = d.controller.readPose();
    d.controller.bindScenePose("front", logged);
    const before = rig.rig.position.clone();
    d.run(200);
    assert.match(text(panel), /Next research phase: Multi-view Object Association/);
    assert.match(text(panel), /NOT YET IMPLEMENTED/);
    assert.match(text(panel), /Front view/, "caption shown because the camera is at the logged pose");
    assert.ok(rig.rig.position.equals(before), "captions never move the camera");
    d.moveTo(5);
    d.run(200);
    assert.equal(text(panel).includes("One viewpoint of the object"), false);
  });
});
