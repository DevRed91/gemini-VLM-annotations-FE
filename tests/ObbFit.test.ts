import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { fitOBB, obbTopSurfaceCenter } from "../src/utils/obbFit.ts";

const uprightAxis = (obb: { quaternion: THREE.Quaternion }) =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(obb.quaternion);

describe("OBB fitting", () => {
  test("upright mode rotates only around world +Y and follows a rotated rectangle", () => {
    const yaw = 0.37;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const points: THREE.Vector3[] = [];
    for (let x = -2; x <= 2.001; x += 0.2) for (let z = -0.5; z <= 0.501; z += 0.1) {
      points.push(new THREE.Vector3(x, 1, z).applyQuaternion(rotation));
    }

    const fitted = fitOBB(points, { mode: "upright", trim: 0, trimY: 0 });
    assert.ok(fitted);
    assert.equal(fitted.method, "upright");
    const yAxis = uprightAxis(fitted.obb);
    assert.ok(yAxis.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-8);
    const expectedLongAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation);
    const fittedLongAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(fitted.obb.quaternion);
    assert.ok(Math.abs(expectedLongAxis.dot(fittedLongAxis)) > 0.99);
    assert.ok(fitted.obb.size.x > fitted.obb.size.z * 3);
  });

  test("upright quantile trimming removes sparse floor and horizontal outliers", () => {
    const points: THREE.Vector3[] = [];
    for (let x = -1; x <= 1.001; x += 0.2) for (let z = -0.5; z <= 0.501; z += 0.2) {
      points.push(new THREE.Vector3(x, 1, z));
    }
    points.push(
      new THREE.Vector3(-0.5, -2, -0.2),
      new THREE.Vector3(0, -2, 0),
      new THREE.Vector3(0.5, -2, 0.2),
      new THREE.Vector3(100, 1, 100),
      new THREE.Vector3(-100, 1, -100),
    );
    const fitted = fitOBB(points, { mode: "upright", trim: 0.05, trimY: 0.05, minTrimPoints: 20 });
    assert.ok(fitted);
    assert.ok(fitted.obb.position.y > 0.9);
    assert.ok(fitted.obb.size.y < 0.2);
    assert.ok(fitted.obb.size.x < 4 && fitted.obb.size.z < 3);
  });

  test("dominant horizontal layer isolates a tabletop from sparse lower points", () => {
    const points: THREE.Vector3[] = [];
    for (let x = -1; x <= 1.001; x += 0.1) for (let z = -0.5; z <= 0.501; z += 0.1) {
      points.push(new THREE.Vector3(x, 1, z));
    }
    for (let index = 0; index < 40; index++) {
      points.push(new THREE.Vector3((index % 10) * 0.1, index * 0.02, (index % 7) * 0.1));
    }
    const fitted = fitOBB(points, {
      mode: "upright", dominantLayer: true, trim: 0, trimY: 0,
    });
    assert.ok(fitted);
    assert.ok(fitted.obb.position.y > 0.95);
    assert.ok(fitted.obb.size.y < 0.1);
  });

  test("degenerate upright clouds stay finite and undersized clouds use the AABB fallback", () => {
    const line = Array.from({ length: 5 }, (_, index) => new THREE.Vector3(2, index * 0.25, -3));
    const fittedLine = fitOBB(line, { mode: "upright" });
    assert.ok(fittedLine);
    assert.equal(fittedLine.method, "upright");
    assert.ok([...fittedLine.obb.position, ...fittedLine.obb.size, ...fittedLine.obb.quaternion].every(Number.isFinite));

    const fittedPoint = fitOBB([new THREE.Vector3(2, 3, 4)], { mode: "upright" });
    assert.ok(fittedPoint);
    assert.equal(fittedPoint.method, "aabb-fallback");
    assert.ok(fittedPoint.obb.position.distanceTo(new THREE.Vector3(2, 3, 4)) < 1e-8);
  });

  test("default fitting remains PCA and the upright top-face anchor is centered", () => {
    const points = [
      new THREE.Vector3(-2, 0, -0.5), new THREE.Vector3(2, 0.2, -0.5),
      new THREE.Vector3(-2, 0.1, 0.5), new THREE.Vector3(2, 0.3, 0.5),
      new THREE.Vector3(0, 1, 0),
    ];
    const defaultFit = fitOBB(points);
    const explicitPca = fitOBB(points, { mode: "pca" });
    const upright = fitOBB(points, { mode: "upright" });
    assert.ok(defaultFit && explicitPca && upright);
    assert.equal(defaultFit.method, "pca");
    assert.equal(explicitPca.method, "pca");
    assert.ok(defaultFit.obb.position.distanceTo(explicitPca.obb.position) < 1e-10);
    assert.ok(Math.abs(defaultFit.obb.quaternion.dot(explicitPca.obb.quaternion)) > 1 - 1e-10);

    const anchor = obbTopSurfaceCenter(upright.obb);
    assert.ok(Math.abs(anchor.y - (upright.obb.position.y + upright.obb.size.y / 2)) < 1e-8);
    const local = anchor.clone().sub(upright.obb.position).applyQuaternion(upright.obb.quaternion.clone().invert());
    assert.ok(Math.abs(local.x) < 1e-8 && Math.abs(local.z) < 1e-8);
    assert.ok(Math.abs(local.y - upright.obb.size.y / 2) < 1e-8);
  });
});
