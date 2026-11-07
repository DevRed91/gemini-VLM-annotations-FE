import * as THREE from "three";
import { dyno, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { liftCluster } from "../utils/clusterLifter";
import { GaussianMaskManager } from "../utils/gaussianMaskManager";
import { GaussianObjectHighlighter } from "../utils/gaussianObjectHighlighter";
import { fitOBB } from "../utils/obbFit";
import { HoverTint, OBB } from "../utils/hoverTint";

interface FixtureEntry {
  center: [number, number, number];
  opacity?: number;
}

interface TestRecord {
  name: string;
  passed: boolean;
  details?: unknown;
  error?: string;
}

interface Phase3Report {
  startedAt: string;
  tests: TestRecord[];
  performance: Record<string, unknown> | null;
  shaderErrors: string[];
  finalGlError: number;
}

const FIXTURE: FixtureEntry[] = [
  { center: [-2, 0, 0] },
  { center: [-1.5, 0, 0] },
  { center: [2, 0, 0] },
  { center: [2.5, 0, 0] },
  { center: [0, 0, 0] },
  { center: [0, 1, 0] },
  { center: [10, 10, 0] },
];
const A_OBB = new OBB({ position: new THREE.Vector3(-1.75, 0, 0), size: new THREE.Vector3(1, 1, 1) });
const B_OBB = new OBB({ position: new THREE.Vector3(2.25, 0, 0), size: new THREE.Vector3(1, 1, 1) });
const requestedRepetitions = Number(new URLSearchParams(location.search).get("repetitions"));
const REPETITIONS = Number.isInteger(requestedRepetitions) && requestedRepetitions > 0
  ? Math.min(100, requestedRepetitions)
  : 20;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(640, 480);
renderer.domElement.style.width = "640px";
renderer.domElement.style.height = "480px";
document.body.appendChild(renderer.domElement);

const report: Phase3Report = {
  startedAt: new Date().toISOString(),
  tests: [],
  performance: null,
  shaderErrors: [],
  finalGlError: 0,
};
renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
  report.shaderErrors.push([
    gl.getProgramInfoLog(program),
    gl.getShaderInfoLog(vertexShader),
    gl.getShaderInfoLog(fragmentShader),
  ].filter(Boolean).join("\n"));
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function ids(values: ArrayLike<number>): number[] {
  return Array.from(values as ArrayLike<number>);
}
function assertIds(actual: ArrayLike<number>, expected: number[], message?: string): void {
  assert(JSON.stringify(ids(actual)) === JSON.stringify(expected),
    message ?? `Expected IDs ${JSON.stringify(expected)}, got ${JSON.stringify(ids(actual))}`);
}
function assertNoGlError(): void {
  const gl = renderer.getContext();
  assert(gl.getError() === gl.NO_ERROR, "WebGL reported an error");
}
async function test(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const details = await run();
    report.tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
    console.info(`[Phase3 PASS] ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    report.tests.push({ name, passed: false, error: message });
    console.warn(`[Phase3 FAIL] ${name}: ${message}`);
  }
}
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `Rejection did not match ${pattern}: ${message}`);
    return;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}
async function makeMesh(entries: FixtureEntry[]): Promise<SplatMesh> {
  const mesh = new SplatMesh({
    constructSplats: (packed) => {
      for (const entry of entries) {
        packed.pushSplat(
          new THREE.Vector3(...entry.center),
          new THREE.Vector3(0.12, 0.12, 0.12),
          new THREE.Quaternion(),
          entry.opacity ?? 1,
          new THREE.Color(0.25, 0.4, 0.55),
        );
      }
    },
  });
  await mesh.initialized;
  return mesh;
}
function makeScene(mesh: SplatMesh): {
  scene: THREE.Scene;
  spark: SparkRenderer;
  camera: THREE.PerspectiveCamera;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark, mesh);
  const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.01, 100);
  camera.position.set(0, 0, 8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return { scene, spark, camera };
}
async function renderFrames(scene: THREE.Scene, camera: THREE.Camera, count = 4): Promise<void> {
  for (let i = 0; i < count; i++) {
    renderer.render(scene, camera);
    renderer.getContext().finish();
    await new Promise(requestAnimationFrame);
  }
  assertNoGlError();
}
function pixels(): Uint8Array {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  const out = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, out);
  assertNoGlError();
  return out;
}
function hasVisibleContent(frame: Uint8Array): boolean {
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] !== 0 || frame[i + 1] !== 0 || frame[i + 2] !== 0) return true;
  }
  return false;
}
async function capture(scene: THREE.Scene, camera: THREE.Camera): Promise<Uint8Array> {
  let previous: Uint8Array | null = null;
  for (let frame = 0; frame < 12; frame++) {
    await renderFrames(scene, camera, 1);
    const current = pixels();
    if (previous && hasVisibleContent(previous) && hasVisibleContent(current) &&
        pixelDiff(previous, current).count === 0) return current;
    previous = current;
  }
  throw new Error("Rendered output did not become visibly non-black and stable within twelve frames");
}
function pixelDiff(a: Uint8Array, b: Uint8Array, tolerance = 0): {
  count: number;
  bbox: [number, number, number, number] | null;
  center: [number, number] | null;
} {
  assert(a.length === b.length, "Pixel buffers have different sizes");
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const width = renderer.getContext().drawingBufferWidth;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > tolerance ||
        Math.abs(a[i + 1] - b[i + 1]) > tolerance ||
        Math.abs(a[i + 2] - b[i + 2]) > tolerance) {
      const pixel = i / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  return {
    count,
    bbox: count ? [minX, minY, maxX, maxY] : null,
    center: count ? [(minX + maxX) / 2, (minY + maxY) / 2] : null,
  };
}
function disposeScene(mesh: SplatMesh, spark: SparkRenderer): void {
  mesh.removeFromParent();
  mesh.dispose();
  spark.removeFromParent();
}
function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
function median(values: number[]): number {
  return percentile(values, 0.5);
}

async function run(): Promise<void> {
  await test("OBB fitting produces normalized rigid transforms for basic, translated, and rotated points", () => {
    const base: THREE.Vector3[] = [];
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      for (const y of [-0.4, 0.4]) {
        for (const z of [-0.2, 0.2]) base.push(new THREE.Vector3(x, y, z));
      }
    }
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.5, 0.2));
    const translation = new THREE.Vector3(3, -2, 1);
    for (const [name, points] of [
      ["basic", base],
      ["translated", base.map((point) => point.clone().add(translation))],
      ["rotated", base.map((point) => point.clone().applyQuaternion(rotation).add(translation))],
    ] as const) {
      const fit = fitOBB(points);
      assert(fit && fit.method === "pca", `${name}: PCA fit failed`);
      assert(Math.abs(fit.obb.quaternion.lengthSq() - 1) <= 1e-12, `${name}: rotation is not normalized`);
      const inverse = fit.obb.getWorldMatrix().invert();
      const half = fit.obb.halfExtents;
      for (const point of points) {
        const local = point.clone().applyMatrix4(inverse);
        assert(Math.abs(local.x) <= half.x + 1e-6 &&
          Math.abs(local.y) <= half.y + 1e-6 &&
          Math.abs(local.z) <= half.z + 1e-6, `${name}: fitted OBB excludes an input point`);
      }
    }
    const fallback = fitOBB([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
    assert(fallback?.method === "aabb-fallback", "Degenerate fit did not use AABB fallback");
    assert(Math.abs(fallback.obb.quaternion.lengthSq() - 1) <= 1e-12, "Fallback rotation is not normalized");
  });

  await test("non-unit OBB quaternions are rejected at lifting boundary", async () => {
    const mesh = await makeMesh(FIXTURE);
    try {
      const scaled = new OBB({ quaternion: new THREE.Quaternion(0, 0, 0, 2) });
      const near = new OBB({ quaternion: new THREE.Quaternion(0, 0, 0, 1.01) });
      await expectRejection(liftCluster(mesh, scaled), /unit length/);
      await expectRejection(liftCluster(mesh, near), /unit length/);
    } finally {
      mesh.dispose();
    }
  });

  await test("labels keep disjoint memberships and stable distinct colors", async () => {
    const mesh = await makeMesh(FIXTURE);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      const a = mask.replaceLabel(1, [0, 1]);
      const aColor = mask.getLabelColor(1);
      const aVersion = mesh.version;
      const b = mask.replaceLabel(2, [2, 3]);
      assert(a.changed && b.changed, "Initial label replacements did not change the mask");
      assertIds(mask.getSelectedIds(1), [0, 1]);
      assertIds(mask.getSelectedIds(2), [2, 3]);
      assertIds(mask.selectedIds, [0, 1, 2, 3]);
      assert(mask.count === 4, "Visible selected count is incorrect");
      assert(JSON.stringify(mask.getLabelColor(1)) === JSON.stringify(aColor), "Label one color changed");
      assert(JSON.stringify(aColor) !== JSON.stringify(mask.getLabelColor(2)), "Label colors are not distinct");
      assert(mask.getLabelAt(0) === 1 && mask.getLabelAt(2) === 2, "Wrong visible labels");
      assert(mesh.version === aVersion + 1, "Updating B invalidated A or submitted more than one update");
      const submissions = mask.uploadSubmissions;
      const noOp = mask.replaceLabel(2, [3, 2, 3]);
      assert(!noOp.changed && noOp.duplicateIds === 1 && mask.uploadSubmissions === submissions,
        "Equivalent label update was not suppressed");
    } finally {
      mask.dispose();
      mesh.dispose();
    }
  });

  await test("latest label wins overlaps and clearing restores the underlying label", async () => {
    const mesh = await makeMesh(FIXTURE);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      mask.replaceLabel(1, [0, 1, 4]);
      mask.replaceLabel(2, [2, 3, 4]);
      assert(mask.getLabelAt(4) === 2, "Latest label did not win the overlap");
      assertIds(mask.getSelectedIds(1), [0, 1, 4], "Overlap erased A's retained membership");
      mask.clearLabel(2);
      assert(mask.getLabelAt(4) === 1, "Clearing B did not restore A");
      assertIds(mask.getSelectedIds(2), []);
      mask.replaceLabel(2, [2, 3, 4]);
      mask.replaceLabel(1, [0, 1, 4]);
      assert(mask.getLabelAt(4) === 1, "Updating A did not reclaim the overlap");
      mask.clearLabel(1);
      assert(mask.getLabelAt(4) === 2, "Clearing updated A did not restore B");
      mask.clearLabel(2);
      assert(mask.getLabelAt(4) === 0 && mask.count === 0, "Final clear did not empty the mask");
    } finally {
      mask.dispose();
      mesh.dispose();
    }
  });

  await test("label validation, deduplication, no-op suppression, and binary compatibility", async () => {
    const mesh = await makeMesh(FIXTURE);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      const update = mask.replaceLabel(3, [2, 2, 1, -1, 1.5, NaN, 99]);
      assert(update.validIds === 2 && update.duplicateIds === 1 && update.invalidIds === 4,
        "Unexpected label diagnostics");
      assertIds(mask.getSelectedIds(3), [1, 2]);
      assert(!mask.clearLabel(4).changed, "Clearing an absent label changed pixels");
      mask.replaceLabel(2, [0]);
      const legacy = mask.replace([4]);
      assert(legacy.changed && mask.count === 1 && mask.getLabelAt(4) === 1,
        "Legacy replace did not replace the whole mask");
      assertIds(mask.getSelectedIds(2), []);
      assertIds(mask.getSelectedIds(3), []);
      const textureVersion = mask.texture.version;
      const version = mesh.version;
      assert(!mask.replace([4]).changed && mask.texture.version === textureVersion && mesh.version === version,
        "Legacy no-op submitted work");
      assert(mask.clear().changed, "Legacy clear did not report a change");
      assert(Number(mask.count) === 0 && !mask.clear().changed, "Clear-all was not idempotent");
      for (const label of [0, 256, 1.5, NaN]) {
        let rejected = false;
        try { mask.replaceLabel(label, [0]); } catch { rejected = true; }
        assert(rejected, `Invalid label ${label} was accepted`);
      }
    } finally {
      mask.dispose();
      mesh.dispose();
    }
  });

  await test("two disjoint objects render simultaneously and clear-one restores exact independent pixels", async () => {
    const mesh = await makeMesh(FIXTURE);
    const { scene, spark, camera } = makeScene(mesh);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      const baseline = await capture(scene, camera);
      mask.replaceLabel(2, [2, 3]);
      const bOnly = await capture(scene, camera);
      mask.replaceLabel(1, [0, 1]);
      const both = await capture(scene, camera);
      assert(pixelDiff(bOnly, baseline).count > 0 && pixelDiff(both, bOnly).count > 0,
        `Both disjoint selections are not visible: B=${pixelDiff(bOnly, baseline).count}, A=${pixelDiff(both, bOnly).count}`);
      mask.clearLabel(1);
      const restoredB = await capture(scene, camera);
      assert(pixelDiff(restoredB, bOnly).count === 0, "Clearing A changed B's independent reference pixels");
      mask.clearLabel(2);
      const cleared = await capture(scene, camera);
      assert(pixelDiff(cleared, baseline).count === 0, "Clear-all did not restore the exact RGB baseline");
      return { bPixels: pixelDiff(bOnly, baseline).count, aPixels: pixelDiff(both, bOnly).count };
    } finally {
      mask.dispose();
      disposeScene(mesh, spark);
    }
  });

  await test("overlap pixels follow update precedence and restore exactly", async () => {
    const mesh = await makeMesh(FIXTURE);
    const { scene, spark, camera } = makeScene(mesh);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      const baseline = await capture(scene, camera);
      mask.replaceLabel(1, [4]);
      const a = await capture(scene, camera);
      mask.replaceLabel(2, [4]);
      const b = await capture(scene, camera);
      assert(pixelDiff(a, baseline).count > 0 && pixelDiff(a, b).count > 0,
        "Different overlap labels produced identical or invisible output");
      mask.clearLabel(2);
      const restoredA = await capture(scene, camera);
      assert(pixelDiff(restoredA, a).count === 0, "Underlying label pixels were not restored exactly");
      mask.clearLabel(1);
      assert(pixelDiff(await capture(scene, camera), baseline).count === 0, "Overlap cleanup differs from baseline");
    } finally {
      mask.dispose();
      disposeScene(mesh, spark);
    }
  });

  await test("label masks retain 4096-row addressing and shifted-ID negative controls", async () => {
    const markerIds = [4095, 4096, 8191, 8192];
    const entries = new Array<FixtureEntry>(8193).fill({ center: [100, 100, 0] });
    markerIds.forEach((id, index) => {
      entries[id] = { center: [-2.4 + index * 1.6, index % 2 ? 0.7 : -0.7, 0] };
    });
    const mesh = await makeMesh(entries);
    const { scene, spark, camera } = makeScene(mesh);
    const mask = await GaussianMaskManager.create(mesh);
    try {
      assert(mask.texture.image.height === 3, "Expected three R8UI rows");
      const baseline = await capture(scene, camera);
      mask.replaceLabel(2, markerIds);
      const correct = await capture(scene, camera);
      assert(pixelDiff(correct, baseline).count > 0, "Boundary labels were not visible");
      for (const id of markerIds) assert(mask.getLabelAt(id) === 2, `Wrong label at storage ID ${id}`);
      mask.replaceLabel(2, markerIds.map((id) => id - 1));
      const shifted = await capture(scene, camera);
      assert(pixelDiff(correct, shifted).count > 0, "Shifted-ID negative control matched the correct image");
      mask.clear();
      assert(pixelDiff(await capture(scene, camera), baseline).count === 0, "Boundary mask did not clear exactly");
      return { markerIds, rows: 3 };
    } finally {
      mask.dispose();
      disposeScene(mesh, spark);
    }
  });

  await test("coordinator updates only one object and never reuses IDs", async () => {
    const mesh = await makeMesh(FIXTURE);
    const highlighter = await GaussianObjectHighlighter.create(mesh);
    try {
      const a = await highlighter.select(A_OBB);
      const b = await highlighter.select(B_OBB);
      assert(a && b && a.objectId === 1 && b.objectId === 2, "Initial stable IDs were not allocated");
      assertIds(a.selectedIds, [0, 1]);
      assertIds(b.selectedIds, [2, 3]);
      const aBefore = highlighter.get(1)!;
      const updatedB = await highlighter.select(B_OBB, { objectId: 2 });
      assert(updatedB?.objectId === 2, "Updating B allocated a new ID");
      assertIds(highlighter.get(1)!.selectedIds, ids(aBefore.selectedIds));
      assertIds(highlighter.get(2)!.selectedIds, [2, 3]);
      assert(highlighter.mask.getLabelAt(0) === 1 && highlighter.mask.getLabelAt(2) === 2,
        "Updating B changed A's label");
      await highlighter.clear(1);
      assert(!highlighter.get(1) && highlighter.get(2), "Clear-one removed the wrong object");
      const c = await highlighter.select(A_OBB);
      assert(c?.objectId === 3, "A cleared object ID was reused");
      await highlighter.clearAll();
      assert(highlighter.size === 0 && highlighter.mask.count === 0, "Coordinator clear-all left state");
    } finally {
      highlighter.dispose();
      mesh.dispose();
    }
  });

  await test("stale selections are ignored after clear-one, clear-all, and disposal", async () => {
    const mesh = await makeMesh(FIXTURE);
    const highlighter = await GaussianObjectHighlighter.create(mesh);
    try {
      const staleByAll = highlighter.select(A_OBB);
      const clearing = highlighter.clearAll();
      assert(await staleByAll === null, "A selection completed after clear-all invalidated it");
      await clearing;
      assert(highlighter.size === 0, "Stale clear-all selection committed state");

      const original = await highlighter.select(A_OBB);
      assert(original, "Could not create clear-one fixture");
      const staleUpdate = highlighter.select(B_OBB, { objectId: original.objectId });
      const clearOne = highlighter.clear(original.objectId);
      assert(await staleUpdate === null, "A stale update completed after clear-one");
      await clearOne;
      assert(highlighter.size === 0 && highlighter.mask.count === 0, "Stale clear-one update left pixels");

      const staleByDispose = highlighter.select(B_OBB);
      highlighter.dispose();
      assert(await staleByDispose === null, "A selection completed after disposal");
      highlighter.dispose();
      assert(highlighter.isDisposed && highlighter.mask.isDisposed, "Disposal was not idempotent");
    } finally {
      highlighter.dispose();
      mesh.dispose();
    }
  });

  await test("hover, mask, and third-party effects compose with owned disposal", async () => {
    const mesh = await makeMesh(FIXTURE);
    const { scene, spark, camera } = makeScene(mesh);
    const sentinel = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({ gsplat }),
    );
    mesh.objectModifiers = [sentinel];
    mesh.updateGenerator();
    const highlighter = await GaussianObjectHighlighter.create(mesh);
    const hover = new HoverTint(mesh);
    try {
      assert((mesh.objectModifiers ?? []).length === 3, "Persistent mask was not installed before hover");
      const baseline = await capture(scene, camera);
      await highlighter.select(A_OBB);
      const selected = await capture(scene, camera);
      hover.setHovered(A_OBB);
      const both = await capture(scene, camera);
      assert(pixelDiff(both, selected).count > 0, "Hover did not compose over the persistent mask");
      hover.setHovered(null);
      assert(pixelDiff(await capture(scene, camera), selected).count === 0,
        "Clearing hover did not restore persistent pixels");
      await highlighter.clearAll();
      assert(pixelDiff(await capture(scene, camera), baseline).count === 0,
        "Mask clear-all did not restore the composed baseline");
      highlighter.dispose();
      assert((mesh.objectModifiers ?? []).length === 2 && mesh.objectModifiers?.[0] === sentinel,
        "Mask disposal removed hover or the third-party effect");
      hover.dispose();
      hover.dispose();
      assert((mesh.objectModifiers ?? []).length === 1 && mesh.objectModifiers[0] === sentinel,
        "Hover disposal did not preserve the third-party effect");
    } finally {
      highlighter.dispose();
      hover.dispose();
      disposeScene(mesh, spark);
    }
  });

  await test("two selections survive rigid splat motion and repeated lifecycle cleanup", async () => {
    const mesh = await makeMesh(FIXTURE);
    const { scene, spark, camera } = makeScene(mesh);
    const highlighter = await GaussianObjectHighlighter.create(mesh);
    const hover = new HoverTint(mesh);
    try {
      const baseline = await capture(scene, camera);
      const a = await highlighter.select(A_OBB);
      const b = await highlighter.select(B_OBB);
      assert(a && b, "Missing motion fixture selections");
      const before = await capture(scene, camera);
      const beforeDiff = pixelDiff(before, baseline);
      assert(beforeDiff.center, "Two selections were not visible");
      mesh.position.set(0.7, 0.15, -0.2);
      mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.45);
      const moved = await capture(scene, camera);
      const movedDiff = pixelDiff(moved, before);
      assert(movedDiff.count > 0 && movedDiff.center, "Both highlights did not move with the splat");
      assertIds(highlighter.get(a.objectId)!.selectedIds, [0, 1]);
      assertIds(highlighter.get(b.objectId)!.selectedIds, [2, 3]);
      await highlighter.clearAll();
      const movedBaseline = await capture(scene, camera);
      assert(pixelDiff(moved, movedBaseline).count > 0, "Moved highlights were not visible");

      mesh.position.set(0, 0, 0);
      mesh.quaternion.identity();
      const textureBytes = highlighter.maskSnapshot().textureBytes;
      for (let i = 0; i < 5; i++) {
        const a = await highlighter.select(A_OBB);
        await highlighter.select(B_OBB);
        assert(a && highlighter.size === 2 && (mesh.objectModifiers ?? []).length === 2,
          `Lifecycle iteration ${i} accumulated state`);
        await highlighter.clear(a.objectId);
        assert(Number(highlighter.size) === 1, `Lifecycle iteration ${i} did not clear one`);
        await highlighter.clearAll();
        assert(highlighter.maskSnapshot().textureBytes === textureBytes,
          `Lifecycle iteration ${i} changed texture allocation`);
      }
      let textureDisposeEvents = 0;
      highlighter.mask.texture.addEventListener("dispose", () => { textureDisposeEvents++; });
      highlighter.dispose();
      highlighter.dispose();
      hover.dispose();
      assert(textureDisposeEvents === 1 && (mesh.objectModifiers ?? []).length === 0,
        "Final lifecycle cleanup leaked a texture or modifier");
    } finally {
      highlighter.dispose();
      hover.dispose();
      disposeScene(mesh, spark);
    }
  });

  await test("real Apartment.sog repeated selections meet measured resource and timing gates", async () => {
    const apartment = new SplatMesh({ url: new URL("/Apartment.sog", location.origin).href });
    apartment.quaternion.set(1, 0, 0, 0);
    apartment.position.set(0, -1.5, 0);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    const spark = new SparkRenderer({ renderer });
    scene.add(spark, apartment);
    const camera = new THREE.PerspectiveCamera(60, 320 / 240, 0.01, 1000);
    camera.position.set(0, 0.4, 0);
    camera.lookAt(0, 0.4, -1);
    camera.updateMatrixWorld(true);
    await apartment.initialized;
    const highlighter = await GaussianObjectHighlighter.create(apartment);
    try {
      renderer.setSize(320, 240);
      apartment.updateWorldMatrix(true, false);
      const bounds = apartment.getBoundingBox(true).applyMatrix4(apartment.matrixWorld);
      const obb = new OBB({
        position: bounds.getCenter(new THREE.Vector3()),
        size: bounds.getSize(new THREE.Vector3()).addScalar(0.02),
      });
      const baseline = await capture(scene, camera);
      const samples: Array<Record<string, number>> = [];
      for (let iteration = 0; iteration < REPETITIONS; iteration++) {
        if (iteration > 0) {
          await highlighter.clearAll();
          const cleared = await capture(scene, camera);
          assert(pixelDiff(cleared, baseline).count === 0,
            `Iteration ${iteration}: clear-all did not restore baseline`);
        }
        const selectionStart = performance.now();
        const selection = await highlighter.select(obb, { minOpacity: 0.05 });
        assert(selection && selection.selectedIds.length > 0, `Iteration ${iteration}: empty selection`);
        const selectTotalMs = performance.now() - selectionStart;
        let firstVisibleFrame: number | null = null;
        let firstVisibleMs = 0;
        let candidate: { frame: number; elapsedMs: number; pixels: Uint8Array } | null = null;
        for (let frame = 1; frame <= 12; frame++) {
          renderer.render(scene, camera);
          renderer.getContext().finish();
          const current = pixels();
          if (pixelDiff(current, baseline).count > 0) {
            if (candidate && pixelDiff(candidate.pixels, current).count === 0) {
              firstVisibleFrame = candidate.frame;
              firstVisibleMs = candidate.elapsedMs;
              break;
            }
            candidate = { frame, elapsedMs: performance.now() - selectionStart, pixels: current };
          } else {
            candidate = null;
          }
          await new Promise(requestAnimationFrame);
        }
        assert(firstVisibleFrame !== null,
          `Iteration ${iteration}: no stable visible highlight within twelve frames`);
        samples.push({
          iteration,
          scanMs: selection.lift.scanDurationMs,
          selectTotalMs,
          maskRewriteMs: selection.mask.rewriteMs,
          maskSubmissionMs: selection.mask.submissionMs,
          changedBytes: selection.mask.changedBytes,
          firstVisibleFrame,
          selectionToVisibleMs: firstVisibleMs,
        });
      }
      const scans = samples.map((sample) => sample.scanMs);
      const rewrites = samples.map((sample) => sample.maskRewriteMs);
      const visibility = samples.map((sample) => sample.selectionToVisibleMs);
      const maskSnapshot = highlighter.maskSnapshot();
      const selectedIdArrayBytes = maskSnapshot.labels.reduce(
        (sum, label) => sum + label.selectedIds.byteLength,
        0,
      );
      report.performance = {
        asset: "Apartment.sog",
        initializedSplats: apartment.numSplats,
        viewport: [320, 240],
        repetitions: samples.length,
        scanMedianMs: median(scans),
        scanP95Ms: percentile(scans, 0.95),
        maskRewriteMedianMs: median(rewrites),
        maskRewriteP95Ms: percentile(rewrites, 0.95),
        selectionToVisibleMedianMs: median(visibility),
        selectionToVisibleP95Ms: percentile(visibility, 0.95),
        textureBytes: maskSnapshot.textureBytes,
        selectedIdArrayBytes,
        activeLabels: maskSnapshot.labels.length,
        modifierCount: apartment.objectModifiers?.length ?? 0,
        maskSubmissions: highlighter.mask.uploadSubmissions,
        paletteSubmissions: highlighter.mask.paletteUploadSubmissions,
        samples,
        note: "SwiftShader whole-scene OBB selections; selectedIdArrayBytes excludes Set overhead; visibility includes CPU lift, mask work and rendering",
      };
      assert(samples.length === REPETITIONS, "Not all requested selections were measured");
      assert(percentile(scans, 0.95) < 200, `p95 scan exceeded 200 ms: ${percentile(scans, 0.95)}`);
      assert(maskSnapshot.labels.length === 1 && selectedIdArrayBytes > 0, "Selection storage accounting is invalid");
      assert((apartment.objectModifiers ?? []).length === 1, "Repeated selections stacked mask modifiers");
      await highlighter.clearAll();
      const finalBaseline = await capture(scene, camera);
      assert(pixelDiff(finalBaseline, baseline).count === 0, "Final Apartment clear-all differed from baseline");
    } finally {
      highlighter.dispose();
      disposeScene(apartment, spark);
    }
  });

  report.finalGlError = renderer.getContext().getError();
}

(async () => {
  try {
    await run();
  } catch (error) {
    report.tests.push({
      name: "harness initialization/cleanup",
      passed: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
  const passed = report.tests.filter((entry) => entry.passed).length;
  const failed = report.tests.length - passed;
  const output = document.createElement("pre");
  output.textContent = `Phase 3: ${passed} passed, ${failed} failed\n${JSON.stringify(report, null, 2)}`;
  output.style.cssText = "position:absolute;inset:0;overflow:auto;background:#111;color:#eee;padding:16px;white-space:pre-wrap";
  document.body.appendChild(output);
  (window as unknown as { __phase3: { ready: boolean; report: Phase3Report } }).__phase3 = {
    ready: true,
    report,
  };
})();
