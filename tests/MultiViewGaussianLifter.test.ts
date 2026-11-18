import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { captureViewSnapshot, projectSnapshotPoint, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

const { liftMultiViewGaussians, sampleMaskInterior } = await import("../src/segmentation/multiViewGaussianLifter.ts");
const { SplatMesh } = (await import("./helpers/fakeSpark.ts")) as typeof import("./helpers/fakeSpark.ts");
import type { DecodedMask, ViewObservation } from "../src/segmentation/multiViewGaussianLifter.ts";

const W = 400;
const H = 400;
const GEN = 3;

// ------------------------------------------------------------ synthetic scene
// Unit cube (the "chair") centred at the origin, surface Gaussians on a 0.1
// lattice, with a wall plane just behind its far face (z = -0.6). Cameras sit on
// +z (front), +x (side) and +y (top), all looking at the origin.

const STEP = 0.1;
const lattice = Array.from({ length: 11 }, (_, i) => Math.round((-0.5 + i * STEP) * 10) / 10);
type P = [number, number, number];
const cube: P[] = [];
for (const a of lattice) for (const b of lattice) {
  cube.push([a, b, 0.5], [a, b, -0.5], [0.5, a, b], [-0.5, a, b], [a, 0.5, b], [a, -0.5, b]);
}
const uniqueCube = [...new Map(cube.map((p) => [p.join(","), p])).values()];
const wallLattice = Array.from({ length: 13 }, (_, i) => Math.round((-0.6 + i * STEP) * 10) / 10);
const wall: P[] = [];
for (const x of wallLattice) for (const y of wallLattice) wall.push([x, y, -0.6]);

function buildSplat() {
  const splat = new SplatMesh([...uniqueCube, ...wall].map((center) => ({ center })), 0.08);
  splat.updateMatrixWorld(true);
  return splat;
}
const cubeIndices = uniqueCube.map((_, i) => i);
const wallIndices = wall.map((_, i) => uniqueCube.length + i);

function capture(position: P, splat: InstanceType<typeof SplatMesh> | null, generation = GEN): ViewSnapshot {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(...position);
  camera.up.set(0, position[1] > 1 ? 0 : 1, position[1] > 1 ? -1 : 0);
  camera.lookAt(0, 0, 0);
  scene.add(camera);
  const canvas = {
    width: W, height: H, clientWidth: W, clientHeight: H,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
  };
  const renderer = {
    domElement: canvas,
    render: () => {
      scene.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    },
  } as unknown as THREE.WebGLRenderer;
  return captureViewSnapshot(renderer, scene, camera, splat as unknown as THREE.Object3D | null, generation);
}

/** Silhouette mask of the cube: bounding rectangle of its 8 projected corners (exact for these axis-aligned views). */
function cubeMask(snapshot: ViewSnapshot, size = 0.5): DecodedMask {
  let umin = 1, vmin = 1, umax = 0, vmax = 0;
  for (const sx of [-size, size]) for (const sy of [-size, size]) for (const sz of [-size, size]) {
    const n = projectSnapshotPoint(snapshot, { x: sx, y: sy, z: sz }, GEN).normalized!;
    umin = Math.min(umin, n.u); umax = Math.max(umax, n.u);
    vmin = Math.min(vmin, n.v); vmax = Math.max(vmax, n.v);
  }
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = (y + 0.5) / H;
    if (u >= umin && u <= umax && v >= vmin && v <= vmax) data[y * W + x] = 1;
  }
  return { width: W, height: H, data };
}

function observations(splat: InstanceType<typeof SplatMesh>): ViewObservation[] {
  const poses: Array<[ViewObservation["view"], P]> = [["front", [0, 0, 3]], ["side", [3, 0, 0]], ["top", [0, 3, 0]]];
  return poses.map(([view, position]) => {
    const snapshot = capture(position, splat);
    return { view, snapshot, visible: true, mask: cubeMask(snapshot) };
  });
}

const run = (splat: InstanceType<typeof SplatMesh>, views: ViewObservation[], options = {}, generation = GEN) =>
  liftMultiViewGaussians({ splat: splat as never, worldGeneration: generation, views, options });

// -------------------------------------------------------------------- tests

describe("multi-view Gaussian lifter", () => {
  test("occlusion: with generous padding the wall is a candidate and is rejected, even where it projects inside the front mask", async () => {
    const splat = buildSplat();
    const views = observations(splat);

    // Precondition: much of the wall really does project inside the front mask.
    const frontMask = views[0].mask!;
    const wallInsideFront = wall.filter(([x, y, z]) => {
      const n = projectSnapshotPoint(views[0].snapshot, { x, y, z }, GEN).normalized!;
      return frontMask.data[Math.floor(n.v * H) * W + Math.floor(n.u * W)] === 1;
    });
    assert.ok(wallInsideFront.length > 50);

    // Padding 0.5 grows the hit-derived search volume (visible surfaces only) back past the wall at z = -0.6.
    const result = await run(splat, views, { bboxPaddingRatio: 0.5 });
    const accepted = new Set(result.indices);

    // Every Gaussian on a face some camera looks at (+z front, +x side, +y top) is accepted.
    const seenByACamera = cubeIndices.filter((i) => uniqueCube[i][2] === 0.5 || uniqueCube[i][0] === 0.5 || uniqueCube[i][1] === 0.5);
    assert.equal(seenByACamera.length, 3 * 121 - 3 * 11 + 1);
    for (const i of seenByACamera) assert.ok(accepted.has(i), `cube Gaussian ${i} (${uniqueCube[i]}) should be accepted`);
    for (const i of wallIndices) assert.ok(!accepted.has(i), `wall Gaussian ${i} (${wall[i - uniqueCube.length]}) should be rejected`);

    const d = result.diagnostics;
    assert.deepEqual([...d.viewsUsed].sort(), ["front", "side", "top"]);
    assert.deepEqual(d.excludedViews, []);
    for (const view of ["front", "side", "top"] as const) assert.equal(d.sparseHitsPerView[view], 20);
    assert.equal(d.acceptedCount, result.indices.length);
    assert.equal(d.candidateCount, d.acceptedCount + d.rejectedBackgroundCount + d.rejectedInsufficientVotesCount);
    assert.ok(d.abstainedOccludedCount > 0);
    // The wall was genuinely in play (inside the search volume), not rejected for being out of range.
    const { min, max } = d.searchVolume!;
    const wallCandidates = wall.filter(([x, y, z]) => x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z);
    assert.ok(wallCandidates.length > 30, `only ${wallCandidates.length} wall Gaussians were candidates`);
    assert.ok(d.rejectedBackgroundCount + d.rejectedInsufficientVotesCount >= wallCandidates.length);
    assert.ok(result.obb);
    // Fitted box covers the visible cube surfaces (~1 unit per side).
    const dims = result.obb.obb.size.toArray().sort();
    assert.ok(dims[0] > 0.6 && dims[2] < 1.6, `unexpected OBB size ${dims}`);
  });

  test("default padding: visible faces accepted; the wall is outside the search volume and never a candidate", async () => {
    const splat = buildSplat();
    const result = await run(splat, observations(splat));
    const accepted = new Set(result.indices);
    for (const i of cubeIndices) {
      const p = uniqueCube[i];
      if (p[2] === 0.5 || p[0] === 0.5 || p[1] === 0.5) assert.ok(accepted.has(i), `cube Gaussian ${i} (${p})`);
    }
    for (const i of wallIndices) assert.ok(!accepted.has(i));
    const { min } = result.diagnostics.searchVolume!;
    assert.ok(min.z > -0.6);
  });

  test("output is sorted, unique, and deterministic", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    const a = await run(splat, views);
    const b = await run(splat, views);
    assert.deepEqual(Array.from(a.indices), Array.from(b.indices));
    assert.deepEqual(Array.from(a.indices), [...new Set(a.indices)].sort((x, y) => x - y));
    assert.ok(a.indices instanceof Uint32Array);
  });

  test("limitation: Gaussians no view can see are not lifted (hidden far corner abstains everywhere)", async () => {
    const splat = buildSplat();
    const result = await run(splat, observations(splat));
    const corner = uniqueCube.findIndex((p) => p[0] === -0.5 && p[1] === -0.5 && p[2] === -0.5);
    assert.ok(corner >= 0);
    assert.ok(!new Set(result.indices).has(corner));
    assert.ok(result.indices.length < uniqueCube.length);
  });

  test("a stale snapshot (old world generation) is excluded, not mixed in", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    const stale = capture([0, 0, 3], splat, GEN - 1);
    views[0] = { ...views[0], snapshot: stale };
    const result = await run(splat, views);
    assert.deepEqual([...result.diagnostics.viewsUsed].sort(), ["side", "top"]);
    assert.equal(result.diagnostics.excludedViews.length, 1);
    assert.equal(result.diagnostics.excludedViews[0].view, "front");
    assert.match(result.diagnostics.excludedViews[0].reason, /stale/i);
  });

  test("a splat that moved after capture invalidates every view", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    splat.position.set(0.5, 0, 0);
    splat.updateMatrixWorld(true);
    const result = await run(splat, views);
    assert.equal(result.indices.length, 0);
    assert.equal(result.obb, null);
    assert.equal(result.diagnostics.viewsUsed.length, 0);
    assert.equal(result.diagnostics.excludedViews.length, 3);
    assert.ok(result.diagnostics.excludedViews.every((e) => /transform/i.test(e.reason)));
    assert.equal(result.diagnostics.candidateCount, 0);
  });

  test("a snapshot taken with no splat loaded is excluded", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    views[1] = { ...views[1], snapshot: capture([3, 0, 0], null) };
    const result = await run(splat, views);
    assert.deepEqual(result.diagnostics.excludedViews.map((e) => e.view), ["side"]);
  });

  test("not-visible views are skipped; a view with no mask falls back to its bbox", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    const topMask = views[2].mask!;
    let ymin = H, ymax = 0, xmin = W, xmax = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (topMask.data[y * W + x]) {
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    }
    views[1] = { ...views[1], visible: false };
    views[2] = { ...views[2], mask: null, bboxNormalized: [ymin / H, xmin / W, (ymax + 1) / H, (xmax + 1) / W] };
    const result = await run(splat, views);
    assert.deepEqual([...result.diagnostics.viewsUsed].sort(), ["front", "top"]);
    assert.deepEqual(result.diagnostics.bboxFallbackViews, ["top"]);
    assert.deepEqual(result.diagnostics.excludedViews, [{ view: "side", reason: "not visible" }]);
    for (const i of wallIndices) assert.ok(!new Set(result.indices).has(i));
  });

  test("low-opacity Gaussians are never candidates", async () => {
    const splat = buildSplat();
    splat.gaussians[0] = { ...splat.gaussians[0], opacity: 0.01 };
    const result = await run(splat, observations(splat));
    assert.ok(!new Set(result.indices).has(0));
  });

  test("minPositiveVotes and option validation", async () => {
    const splat = buildSplat();
    const views = observations(splat);
    const strict = await run(splat, views, { minPositiveVotes: 3 });
    assert.ok(strict.indices.length < uniqueCube.length); // faces seen by one view only now fail
    await assert.rejects(run(splat, views, { raysPerView: 0 }), RangeError);
    await assert.rejects(run(splat, views, { minOpacity: 2 }), RangeError);
    await assert.rejects(run(splat, [views[0], views[0]]), /Duplicate/);
  });

  test("LOD splats are rejected before any work", async () => {
    const splat = buildSplat();
    splat.enableLod = true;
    await assert.rejects(run(splat, observations(splat)), /non-LOD/);
  });
});

describe("sampleMaskInterior", () => {
  const rect = (w: number, h: number, x0: number, y0: number, x1: number, y1: number): DecodedMask => {
    const data = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
    return { width: w, height: h, data };
  };

  test("samples only foreground, spread across the mask, off its boundary", () => {
    const mask = rect(100, 100, 20, 20, 80, 80);
    const samples = sampleMaskInterior(mask, 20);
    assert.equal(samples.length, 20);
    for (const { u, v } of samples) {
      const x = Math.floor(u * 100), y = Math.floor(v * 100);
      assert.equal(mask.data[y * 100 + x], 1);
      assert.ok(x >= 25 && x <= 74 && y >= 25 && y <= 74, `sample (${x},${y}) is too close to the edge`);
    }
    const us = samples.map((s) => s.u);
    assert.ok(Math.max(...us) - Math.min(...us) > 0.4); // covers the extent, not just the centre
  });

  test("an empty mask yields no samples; a tiny mask yields what it has", () => {
    assert.deepEqual(sampleMaskInterior(rect(10, 10, 0, 0, 0, 0), 5), []);
    assert.ok(sampleMaskInterior(rect(10, 10, 4, 4, 6, 6), 20).length <= 4);
  });
});
