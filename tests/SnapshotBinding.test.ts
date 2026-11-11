import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { captureViewSnapshot } from "../src/viewer/ViewSnapshot.ts";
import {
  StaleSnapshotError,
  assertBindingCurrent,
  assertImageSpaceBox,
  assertPoseUnchanged,
  bindSnapshot,
  snapshotSplatRay,
  type LiveWorldState,
} from "../src/viewer/SnapshotBinding.ts";

/** Plane at z = -5 (local), hit anywhere; records the ray it was cast with. */
class FakeSplat extends THREE.Object3D {
  lastRay: THREE.Ray | null = null;
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    this.lastRay = raycaster.ray.clone();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 5).applyMatrix4(this.matrixWorld);
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (point) {
      intersects.push({ distance: point.distanceTo(raycaster.ray.origin), point, object: this });
    }
  }
}

function setup(generation = 3) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
  camera.position.set(0.3, 0.2, 1);
  camera.rotation.set(0.1, 0.4, 0);
  const splat = new FakeSplat();
  splat.position.set(0, -1.5, 0);
  scene.add(splat, camera);
  const canvas = {
    width: 800, height: 600, clientWidth: 400, clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
  };
  const renderer = {
    domElement: canvas,
    render: () => {
      scene.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    },
  } as unknown as THREE.WebGLRenderer;
  const live: { value: LiveWorldState } = {
    value: { worldGeneration: generation, splat, splatLoaded: true },
  };
  const snapshot = captureViewSnapshot(renderer, scene, camera, splat, generation);
  return { scene, camera, splat, live, snapshot };
}

function liveRay(camera: THREE.PerspectiveCamera, u: number, v: number): THREE.Ray {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(u * 2 - 1, -(v * 2 - 1)), camera);
  return rc.ray;
}

describe("snapshot binding", () => {
  test("snapshot rays equal the legacy live-camera rays when nothing moved", () => {
    const { camera, splat, live, snapshot } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    for (const [u, v] of [[0.5, 0.5], [0.1, 0.9], [0.77, 0.23]]) {
      const cast = snapshotSplatRay(binding, live.value, u, v);
      const legacy = liveRay(camera, u, v);
      assert.ok(cast.ray.origin.distanceTo(legacy.origin) < 1e-9);
      assert.ok(cast.ray.direction.distanceTo(legacy.direction) < 1e-9);
      assert.ok(cast.intersection && splat.lastRay);
    }
  });

  test("moving the live camera after capture does not change sampling rays or hits", () => {
    const { camera, live, snapshot } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    const before = snapshotSplatRay(binding, live.value, 0.4, 0.6);
    camera.position.set(5, 5, 5);
    camera.rotation.set(1, 1, 1);
    camera.updateMatrixWorld(true);
    const after = snapshotSplatRay(binding, live.value, 0.4, 0.6);
    assert.deepEqual(after.ray.origin.toArray(), before.ray.origin.toArray());
    assert.deepEqual(after.ray.direction.toArray(), before.ray.direction.toArray());
    assert.deepEqual(after.intersection!.point.toArray(), before.intersection!.point.toArray());
    // ...whereas the live camera now produces a different ray.
    assert.ok(liveRay(camera, 0.4, 0.6).origin.distanceTo(before.ray.origin) > 1);
  });

  test("Gemini [ymin,xmin,ymax,xmax] box corners map to image-space rays (y down, x right)", () => {
    const { live, snapshot } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    const topLeft = snapshotSplatRay(binding, live.value, 0, 0).ray.direction;
    const bottomRight = snapshotSplatRay(binding, live.value, 1, 1).ray.direction;
    const toCam = (d: THREE.Vector3) => d.clone().transformDirection(
      new THREE.Matrix4().fromArray(snapshot.camera.inverseWorldMatrix),
    );
    const tl = toCam(topLeft);
    const br = toCam(bottomRight);
    assert.ok(tl.x < 0 && tl.y > 0, "top-left of image is camera -x, +y");
    assert.ok(br.x > 0 && br.y < 0, "bottom-right of image is camera +x, -y");
  });

  test("rejects capture binding before splat initialization", () => {
    const { snapshot, splat } = setup();
    assert.throws(
      () => bindSnapshot(snapshot, { worldGeneration: 3, splat: null, splatLoaded: false }),
      (e: unknown) => e instanceof StaleSnapshotError && e.reason === "no-splat",
    );
    assert.throws(
      () => bindSnapshot(snapshot, { worldGeneration: 3, splat, splatLoaded: false }),
      (e: unknown) => e instanceof StaleSnapshotError && e.reason === "no-splat",
    );
  });

  test("world generation change invalidates outstanding bindings", () => {
    const { live, snapshot, splat } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    live.value = { worldGeneration: 4, splat, splatLoaded: true };
    assert.throws(
      () => snapshotSplatRay(binding, live.value, 0.5, 0.5),
      (e: unknown) => e instanceof StaleSnapshotError && e.reason === "world-generation",
    );
  });

  test("replacing the splat instance (even at the same generation) is rejected", () => {
    const { live, snapshot } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    const replacement = new FakeSplat();
    replacement.position.set(0, -1.5, 0);
    replacement.updateMatrixWorld(true);
    live.value = { worldGeneration: 3, splat: replacement, splatLoaded: true };
    assert.throws(
      () => assertBindingCurrent(binding, live.value),
      (e: unknown) => e instanceof StaleSnapshotError && e.reason === "splat-instance",
    );
  });

  test("a moved splat transform is rejected rather than raycast against different geometry", () => {
    const { live, snapshot, splat } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    splat.position.y += 1;
    splat.updateMatrixWorld(true);
    assert.throws(
      () => snapshotSplatRay(binding, live.value, 0.5, 0.5),
      (e: unknown) => e instanceof StaleSnapshotError && e.reason === "splat-transform",
    );
  });

  test("sampling grid positions are unchanged: same (u,v) cells give same snapshot rays as live camera", () => {
    const { camera, live, snapshot } = setup();
    const binding = bindSnapshot(snapshot, live.value);
    const [ymin, xmin, ymax, xmax] = [0.2, 0.3, 0.6, 0.7];
    const n = 6;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      const u = xmin + ((c + 0.5) / n) * (xmax - xmin);
      const v = ymin + ((r + 0.5) / n) * (ymax - ymin);
      const a = snapshotSplatRay(binding, live.value, u, v).ray;
      const b = liveRay(camera, u, v);
      assert.ok(a.direction.distanceTo(b.direction) < 1e-9);
    }
  });

  test("binding carries snapshot id, generation, splat identity and matrices", () => {
    const { live, snapshot, splat } = setup(7);
    const binding = bindSnapshot(snapshot, live.value);
    assert.equal(binding.snapshotId, snapshot.id);
    assert.equal(binding.worldGeneration, 7);
    assert.equal(binding.splat, splat);
    assert.equal(binding.snapshot.camera.worldMatrix.length, 16);
    assert.equal(binding.snapshot.splat!.matrixWorld.length, 16);
    assert.ok(Object.isFrozen(binding));
  });

  test("camera moved between click and capture is detected; unchanged pose passes", () => {
    const { camera, snapshot } = setup();
    const poseAtClick = Array.from(camera.matrixWorld.elements);
    assert.equal(assertPoseUnchanged(poseAtClick, snapshot), 0);
    const moved = poseAtClick.slice();
    moved[12] += 0.01; // capture would have rendered a pose 1 cm away from the click-time pose
    assert.throws(() => assertPoseUnchanged(moved, snapshot), /pose changed/);
  });

  test("camera under a transformed parent rig: snapshot rays match the live world-space camera", () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    rig.position.set(2, -1, 4);
    rig.rotation.set(0.3, -0.8, 0.1);
    rig.scale.setScalar(1);
    const camera = new THREE.PerspectiveCamera(70, 1.5, 0.1, 50);
    camera.position.set(0.2, 0.5, -0.3);
    camera.rotation.set(-0.2, 0.1, 0);
    rig.add(camera);
    const splat = new FakeSplat();
    scene.add(rig, splat);
    const renderer = {
      domElement: {
        width: 600, height: 400, clientWidth: 600, clientHeight: 400,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 400 }),
        toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
      },
      render: () => { scene.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); },
    } as unknown as THREE.WebGLRenderer;
    const snapshot = captureViewSnapshot(renderer, scene, camera, splat, 1);
    const live: LiveWorldState = { worldGeneration: 1, splat, splatLoaded: true };
    const binding = bindSnapshot(snapshot, live);
    for (const [u, v] of [[0.5, 0.5], [0, 0], [1, 1], [0.2, 0.8]]) {
      const a = snapshotSplatRay(binding, live, u, v).ray;
      const b = liveRay(camera, u, v);
      assert.ok(a.origin.distanceTo(b.origin) < 1e-9, "origin must be the world-space camera position");
      assert.ok(a.direction.distanceTo(b.direction) < 1e-9);
    }
    rig.position.set(-9, 9, 9); // moving the parent afterwards changes nothing
    rig.updateMatrixWorld(true);
    const again = snapshotSplatRay(binding, live, 0.5, 0.5).ray;
    assert.ok(again.origin.distanceTo(liveRay(camera, 0.5, 0.5).origin) > 1);
  });

  test("box edge coordinates: 0 and 1 are valid; out-of-range, NaN, degenerate and swapped are rejected", () => {
    const { snapshot, live } = setup();
    assert.doesNotThrow(() => assertImageSpaceBox(snapshot, [0, 0, 1, 1]));
    assert.doesNotThrow(() => assertImageSpaceBox(snapshot, [0.999, 0.999, 1, 1]));
    for (const bad of [[-0.001, 0, 1, 1], [0, 0, 1.001, 1], [NaN, 0, 1, 1], [0.5, 0.5, 0.5, 0.9], [0.9, 0, 0.1, 1], [0, 0, 1]]) {
      assert.throws(() => assertImageSpaceBox(snapshot, bad as number[]), RangeError, JSON.stringify(bad));
    }
    // 0-1000-scale values must never reach NDC conversion.
    assert.throws(() => assertImageSpaceBox(snapshot, [300, 350, 600, 650]), RangeError);
    // Corners of the image produce finite unit rays.
    const binding = bindSnapshot(snapshot, live.value);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const d = snapshotSplatRay(binding, live.value, u, v).ray.direction;
      assert.ok(Math.abs(d.length() - 1) < 1e-9);
    }
    assert.throws(() => snapshotSplatRay(binding, live.value, 1.0001, 0.5), RangeError);
  });
});
