import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  captureViewSnapshot,
  generateSnapshotRay,
  projectSnapshotPoint,
  validateViewSnapshot,
  type ViewSnapshot,
} from "../src/viewer/ViewSnapshot.ts";

const IMAGE_DATA_URL = "data:image/jpeg;base64,ZmFrZQ==";

function fixture(options: {
  aspect?: number;
  position?: THREE.Vector3;
  viewport?: { left: number; top: number; width: number; height: number };
  splat?: THREE.Object3D | null;
  rotationY?: number;
} = {}): { snapshot: ViewSnapshot; camera: THREE.PerspectiveCamera; rendererCalls: number[] } {
  const camera = new THREE.PerspectiveCamera(90, options.aspect ?? 1, 0.1, 100);
  if (options.position) camera.position.copy(options.position);
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  const rig = new THREE.Group();
  rig.position.set(0.5, -0.25, 3);
  rig.rotation.y = options.rotationY ?? 0;
  rig.add(camera);
  scene.add(rig);

  const viewport = options.viewport ?? { left: 0, top: 0, width: 800, height: 600 };
  let readbacks = 0;
  const canvas = {
    width: 800,
    height: 600,
    clientWidth: 400,
    clientHeight: 300,
    getBoundingClientRect: () => ({ ...viewport, right: viewport.left + viewport.width, bottom: viewport.top + viewport.height, x: viewport.left, y: viewport.top, toJSON() {} }),
    toDataURL: (mimeType: string, quality: number) => {
      readbacks += 1;
      assert.equal(mimeType, "image/jpeg");
      assert.equal(quality, 0.7);
      return IMAGE_DATA_URL;
    },
  } as unknown as HTMLCanvasElement;
  let renders = 0;
  const renderer = {
    domElement: canvas,
    render: (_scene: THREE.Scene, renderedCamera: THREE.Camera) => {
      renders += 1;
      scene.updateMatrixWorld(true);
      renderedCamera.matrixWorldInverse.copy(renderedCamera.matrixWorld).invert();
      options.splat?.updateWorldMatrix(true, false);
    },
  } as unknown as THREE.WebGLRenderer;

  const snapshot = captureViewSnapshot(renderer, scene, camera, options.splat ?? null, 4);
  assert.equal(readbacks, 1, "capture should read the canvas once");
  return { snapshot, camera, rendererCalls: [renders, readbacks] };
}

function close(actual: number, expected: number, epsilon = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

describe("production ViewSnapshot", () => {
  test("serializes world camera pose and renderer matrices as immutable plain data", () => {
    const { snapshot } = fixture({ position: new THREE.Vector3(1, 2, -1), rotationY: Math.PI / 2 });
    assert.equal(snapshot.image.dataUrl, IMAGE_DATA_URL);
    assert.equal(snapshot.image.width, 800);
    assert.equal(snapshot.image.height, 600);
    assert.equal(snapshot.camera.worldMatrix.length, 16);
    assert.equal(snapshot.camera.inverseWorldMatrix.length, 16);
    assert.equal(snapshot.camera.projectionMatrix.length, 16);
    close(snapshot.camera.position.x, -0.5);
    close(snapshot.camera.position.y, 1.75);
    close(snapshot.camera.position.z, 2);
    close(Math.abs(snapshot.camera.orientation.y), Math.SQRT1_2);
    assert.equal(snapshot.camera.projectionKind, "perspective");
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.camera));
    assert.ok(Object.isFrozen(snapshot.camera.worldMatrix));
    assert.ok(Object.isFrozen(snapshot.image));
    assert.notEqual(fixture().snapshot.id, snapshot.id);
  });

  test("projects known world points and maps through the captured viewport", () => {
    const { snapshot } = fixture({
      aspect: 1,
      viewport: { left: 100, top: 50, width: 400, height: 200 },
    });
    // The camera rig places the view at (0.5, -0.25, 3), looking along -Z.
    const centreRayPoint = { x: 0.5, y: -0.25, z: 1 };
    const projected = projectSnapshotPoint(snapshot, centreRayPoint, 4);
    assert.ok(projected.normalized);
    close(projected.normalized.u, 0.5);
    close(projected.normalized.v, 0.5);
    assert.deepEqual(projected.pixel, { x: 300, y: 150 });

    const right = projectSnapshotPoint(snapshot, { x: 1.5, y: -0.25, z: 1 }, 4);
    assert.ok(right.normalized);
    close(right.normalized.u, 0.75);
    close(right.normalized.v, 0.5);
  });

  test("generates rays at known normalized screen coordinates", () => {
    const { snapshot } = fixture();
    const centre = generateSnapshotRay(snapshot, 0.5, 0.5, 4);
    close(centre.direction.x, 0);
    close(centre.direction.y, 0);
    close(centre.direction.z, -1);

    const upperRight = generateSnapshotRay(snapshot, 1, 0, 4);
    close(upperRight.direction.x, 1 / Math.sqrt(3));
    close(upperRight.direction.y, 1 / Math.sqrt(3));
    close(upperRight.direction.z, -1 / Math.sqrt(3));
  });

  test("uses captured camera aspect independently from CSS viewport dimensions", () => {
    const { snapshot } = fixture({
      aspect: 2,
      viewport: { left: 0, top: 0, width: 1000, height: 250 },
    });
    const edgeRay = generateSnapshotRay(snapshot, 1, 0.5, 4);
    close(edgeRay.direction.x, 2 / Math.sqrt(5));
    close(edgeRay.direction.y, 0);
    close(edgeRay.direction.z, -1 / Math.sqrt(5));
    const point = projectSnapshotPoint(snapshot, { x: 0.5, y: -0.25, z: 2 }, 4);
    assert.deepEqual(point.pixel, { x: 500, y: 125 });
  });

  test("camera movement after capture does not change snapshot projection or rays", () => {
    const { snapshot, camera } = fixture();
    const beforeProjection = projectSnapshotPoint(snapshot, { x: 0.5, y: -0.25, z: 1 }, 4);
    const beforeRay = generateSnapshotRay(snapshot, 0.3, 0.7, 4);
    camera.position.set(100, 50, 20);
    camera.updateMatrixWorld(true);
    const afterProjection = projectSnapshotPoint(snapshot, { x: 0.5, y: -0.25, z: 1 }, 4);
    const afterRay = generateSnapshotRay(snapshot, 0.3, 0.7, 4);
    assert.deepEqual(afterProjection, beforeProjection);
    assert.deepEqual(afterRay, beforeRay);
  });

  test("snapshot state does not alias mutable Three.js camera or splat matrices", () => {
    const splat = new THREE.Group();
    splat.position.set(2, 3, 4);
    splat.rotation.set(0.2, -0.3, 0.4);
    splat.scale.set(2, 0.5, 3);
    const { snapshot, camera } = fixture({ splat });
    const frozenCameraMatrix = [...snapshot.camera.worldMatrix];
    const frozenSplatMatrix = [...snapshot.splat!.matrixWorld];
    camera.position.x += 10;
    camera.updateMatrixWorld(true);
    splat.position.x += 10;
    splat.updateWorldMatrix(true, false);
    assert.deepEqual(snapshot.camera.worldMatrix, frozenCameraMatrix);
    assert.deepEqual(snapshot.splat!.matrixWorld, frozenSplatMatrix);
    assert.ok(Object.isFrozen(snapshot.splat));
  });

  test("rejects stale generations for validation, projection, and ray generation", () => {
    const { snapshot } = fixture();
    assert.throws(() => validateViewSnapshot(snapshot, 5), /Stale ViewSnapshot/);
    assert.throws(() => projectSnapshotPoint(snapshot, { x: 0, y: 0, z: -1 }, 5), /Stale ViewSnapshot/);
    assert.throws(() => generateSnapshotRay(snapshot, 0.5, 0.5, 5), /Stale ViewSnapshot/);
  });

  test("rejects missing and non-finite camera data", () => {
    const { snapshot } = fixture();
    assert.throws(() => validateViewSnapshot({ ...snapshot, camera: undefined }), /camera data is missing/);
    const badCamera = {
      ...snapshot.camera,
      projectionMatrix: snapshot.camera.projectionMatrix.map((value, index) => index === 0 ? Number.NaN : value),
    };
    assert.throws(() => validateViewSnapshot({ ...snapshot, camera: badCamera }), /16 finite values/);
  });

  test("preserves the complete splat matrixWorld without decomposition loss", () => {
    const parent = new THREE.Group();
    parent.position.set(4, -2, 7);
    parent.rotation.set(0.3, 0.8, -0.2);
    parent.scale.set(1.5, 0.75, 2);
    const splat = new THREE.Group();
    splat.position.set(-1, 2, 0.5);
    splat.rotation.set(-0.6, 0.1, 0.9);
    splat.scale.set(-2, 1.25, 0.4);
    parent.add(splat);
    const { snapshot } = fixture({ splat });
    parent.updateWorldMatrix(true, true);
    assert.deepEqual(snapshot.splat?.matrixWorld, Array.from(parent.children[0].matrixWorld.elements));
  });

  test("captures one rendered frame and performs one canvas readback", () => {
    const { rendererCalls } = fixture();
    assert.deepEqual(rendererCalls, [1, 1]);
  });
});
