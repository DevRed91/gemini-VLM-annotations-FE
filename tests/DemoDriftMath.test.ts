import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

import {
  CostMeter,
  cameraDrift,
  formatDrift,
  gridCells,
  maxRayDeviation,
  meanPairedDistance,
  provisionalBox,
} from "../src/demo/driftMath.ts";

function pose(position: [number, number, number], yawDeg = 0, pitchDeg = 0, scale = 1): number[] {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler((pitchDeg * Math.PI) / 180, (yawDeg * Math.PI) / 180, 0, "YXZ"),
  );
  return new THREE.Matrix4().compose(new THREE.Vector3(...position), q, new THREE.Vector3(scale, scale, scale)).elements.slice();
}

describe("cameraDrift", () => {
  test("identical poses have zero drift", () => {
    const m = pose([1, 2, 3], 30, 10);
    const d = cameraDrift(m, m);
    assert.equal(d.translation, 0);
    assert.ok(d.rotationDeg < 1e-6);
  });

  test("pure translation", () => {
    const d = cameraDrift(pose([0, 0, 0]), pose([3, 4, 0]));
    assert.ok(Math.abs(d.translation - 5) < 1e-12);
    assert.ok(d.rotationDeg < 1e-6);
  });

  test("pure rotation reports the rotation angle, not the axis", () => {
    for (const yaw of [5, 37, 90, 179]) {
      const d = cameraDrift(pose([0, 0, 0]), pose([0, 0, 0], yaw));
      assert.ok(Math.abs(d.rotationDeg - yaw) < 1e-6, `yaw ${yaw} -> ${d.rotationDeg}`);
    }
    const pitched = cameraDrift(pose([0, 0, 0], 20), pose([0, 0, 0], 20, 12));
    assert.ok(Math.abs(pitched.rotationDeg - 12) < 1e-6);
  });

  test("uniform scale on the camera chain does not inflate rotation drift", () => {
    const d = cameraDrift(pose([0, 0, 0], 10), pose([0, 0, 0], 10, 0, 2.5));
    assert.ok(d.rotationDeg < 1e-6);
  });

  test("rejects wrong-length matrices", () => {
    assert.throws(() => cameraDrift([1, 2, 3], pose([0, 0, 0])), RangeError);
  });

  test("formatDrift is stable", () => {
    assert.deepEqual(formatDrift({ translation: 1.23456, rotationDeg: 7.891 }), { position: "1.235 m", rotation: "7.89°" });
  });
});

describe("gridCells", () => {
  test("3x3 cell centres follow the production formula", () => {
    const cells = gridCells([0.2, 0.1, 0.8, 0.7], 3);
    assert.equal(cells.length, 9);
    // Bit-exact against the production expression, written out literally.
    const [ymin, xmin, ymax, xmax] = [0.2, 0.1, 0.8, 0.7];
    const expected = (row: number, col: number) => ({
      row,
      col,
      x: xmin + ((col + 0.5) / 3) * (xmax - xmin),
      y: ymin + ((row + 0.5) / 3) * (ymax - ymin),
    });
    assert.deepEqual(cells[0], expected(0, 0));
    assert.deepEqual(cells[8], expected(2, 2));
    assert.ok(Math.abs(cells[4].x - 0.4) < 1e-12 && Math.abs(cells[4].y - 0.5) < 1e-12);
    // row-major order, same as the sampler's nested loops
    assert.deepEqual(cells.map((c) => [c.row, c.col]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]]);
  });

  test("rejects a bad grid size", () => {
    assert.throws(() => gridCells([0, 0, 1, 1], 0), RangeError);
    assert.throws(() => gridCells([0, 0, 1, 1], 2.5), RangeError);
  });

  test("drift guard: production sampler still uses the formula gridCells mirrors", () => {
    const source = readFileSync(new URL("../src/script.ts", import.meta.url), "utf8");
    assert.ok(source.includes("const x = xmin + ((col + 0.5) / gridSize) * (xmax - xmin);"));
    assert.ok(source.includes("const y = ymin + ((row + 0.5) / gridSize) * (ymax - ymin);"));
  });
});

describe("provisionalBox", () => {
  test("is centred on the click and clamped to the unit square", () => {
    assert.deepEqual(provisionalBox(0.5, 0.5, 0.1), [0.4, 0.4, 0.6, 0.6]);
    assert.deepEqual(provisionalBox(0.02, 0.99, 0.08), [0.91, 0, 1, 0.1]);
  });
});

describe("maxRayDeviation / meanPairedDistance / CostMeter", () => {
  const ray = (o: [number, number, number], d: [number, number, number]) => ({ origin: o, direction: d });
  test("identical rays deviate by exactly zero", () => {
    const a = [ray([1, 2, 3], [0, 0, -1])];
    assert.equal(maxRayDeviation(a, [ray([1, 2, 3], [0, 0, -1])]), 0);
  });
  test("reports the largest component difference over origin and direction", () => {
    const d = maxRayDeviation([ray([0, 0, 0], [0, 0, 1])], [ray([0.25, 0, 0], [0, 0.5, 1])]);
    assert.equal(d, 0.5);
  });
  test("length mismatch throws", () => {
    assert.throws(() => maxRayDeviation([ray([0, 0, 0], [0, 0, 1])], []), RangeError);
  });
  test("meanPairedDistance skips pairs with a miss", () => {
    const r = meanPairedDistance([[0, 0, 0], null, [0, 0, 0]], [[3, 4, 0], [1, 1, 1], null]);
    assert.deepEqual(r, { mean: 5, pairs: 1 });
    assert.equal(meanPairedDistance([null], [[1, 1, 1]]), null);
  });
  test("CostMeter tracks mean/max/last and resets", () => {
    const m = new CostMeter();
    m.record(1); m.record(3);
    assert.deepEqual(m.summary(), { count: 2, meanMs: 2, maxMs: 3, lastMs: 3 });
    m.reset();
    assert.deepEqual(m.summary(), { count: 0, meanMs: 0, maxMs: 0, lastMs: 0 });
  });
});
