import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { captureViewSnapshot, projectSnapshotPoint, type ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

const { liftMultiViewGaussians, sampleMaskInterior } = await import("../src/segmentation/multiViewGaussianLifter.ts");
const { SplatMesh } = (await import("./helpers/fakeSpark.ts")) as typeof import("./helpers/fakeSpark.ts");
import type { DecodedMask, LiftView, PeerViewObservation, ViewObservation } from "../src/segmentation/multiViewGaussianLifter.ts";
import type { SnapshotVector3 } from "../src/viewer/ViewSnapshot.ts";

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

function capture(position: P, splat: InstanceType<typeof SplatMesh> | null, generation = GEN, up?: P): ViewSnapshot {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 100);
  camera.position.set(...position);
  if (up) camera.up.set(...up);
  else camera.up.set(0, position[1] > 1 ? 0 : 1, position[1] > 1 ? -1 : 0);
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

function projectedBoundsMask(snapshot: ViewSnapshot, min: P, max: P, generation = GEN): DecodedMask {
  let umin = 1, vmin = 1, umax = 0, vmax = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const point = projectSnapshotPoint(snapshot, { x, y, z }, generation).normalized!;
    umin = Math.min(umin, point.u); umax = Math.max(umax, point.u);
    vmin = Math.min(vmin, point.v); vmax = Math.max(vmax, point.v);
  }
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = (y + 0.5) / H;
    if (u >= umin && u <= umax && v >= vmin && v <= vmax) data[y * W + x] = 1;
  }
  return { width: W, height: H, data };
}

function buildTableChairWallScene() {
  const table: P[] = [];
  for (let x = -0.8; x <= 0.8001; x += 0.05) for (let y = -0.5; y <= 0.5001; y += 0.05) {
    table.push([Math.round(x * 20) / 20, Math.round(y * 20) / 20, 0]);
  }
  const chairs: P[][] = [];
  for (const centerX of [-0.6, -0.2, 0.2, 0.6]) {
    const points: P[] = [];
    for (let x = centerX - 0.1; x <= centerX + 0.1001; x += 0.1) for (let y = -0.4; y <= 0.1001; y += 0.1) {
      points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, 0.15]);
    }
    chairs.push(points);
  }
  const background: P[] = [];
  for (let x = -0.8; x <= 0.8001; x += 0.1) for (let y = -0.5; y <= 0.5001; y += 0.1) {
    background.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, -0.18]);
  }
  const all = [...table, ...chairs.flat(), ...background, [0, 0, -0.1] as P];
  const planarScaleIndex = table.findIndex(([x, y]) => x === 0 && y === 0.3);
  const splat = new SplatMesh(all.map((center, index) => ({
    center,
    ...(index === all.length - 1 ? { scales: [2, 0.01, 0.01] as [number, number, number] } : {}),
    ...(index === planarScaleIndex ? { scales: [0.08, 0.08, 0.01] as [number, number, number] } : {}),
  })), 0.035);
  splat.updateMatrixWorld(true);
  const tableIndices = table.map((_, index) => index);
  const chairStart = table.length;
  const chairIndices: number[] = [];
  for (const chair of chairs) {
    chairIndices.push(...Array.from({ length: chair.length }, (_, index) => chairStart + chairIndices.length + index));
  }
  const backgroundStart = table.length + chairs.flat().length;
  const backgroundIndices = background.map((_, index) => backgroundStart + index);
  return { splat, table, chairs, tableIndices, chairIndices, backgroundIndices, planarScaleIndex, scaleOutlierIndex: all.length - 1 };
}

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
    for (const view of ["front", "side", "top"] as const) assert.equal(d.sparseHitsPerView[view], 40, "default raysPerView is 40");
    assert.equal(d.acceptedCount, result.indices.length);
    assert.equal(d.candidateCount, d.acceptedCount + d.rejectedBackgroundCount + d.rejectedPeerCount + d.rejectedScaleCount + d.rejectedFloorCount + d.rejectedInsufficientVotesCount);
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

  test("peer competition removes four tucked chairs from target membership and rejects a broad wall primitive", async () => {
    const scene = buildTableChairWallScene();
    const snapshot = capture([0, 0, 3], scene.splat);
    const targetView: ViewObservation = {
      view: "front",
      snapshot,
      visible: true,
      mask: projectedBoundsMask(snapshot, [-0.8, -0.5, 0], [0.8, 0.5, 0]),
    };
    const peerObjects: PeerViewObservation[] = scene.chairs.map((_, index) => {
      const centerX = [-0.6, -0.2, 0.2, 0.6][index];
      return {
        objectId: `chair-${index + 1}`,
        view: "front" as const,
        snapshot,
        visible: true,
        mask: projectedBoundsMask(snapshot, [centerX - 0.14, -0.45, 0.15], [centerX + 0.14, 0.15, 0.15]),
      };
    });
    const staleSnapshot = capture([3, 0, 0], scene.splat, GEN - 1);
    peerObjects.push({
      objectId: "stale-peer",
      view: "side",
      snapshot: staleSnapshot,
      visible: true,
      mask: projectedBoundsMask(staleSnapshot, [-0.2, -0.4, 0], [0.2, 0.1, 0], GEN - 1),
    });
    const mismatchedSnapshot = capture([0, 0, 4], scene.splat);
    peerObjects.push({
      objectId: "misaligned-peer",
      view: "front",
      snapshot: mismatchedSnapshot,
      visible: true,
      mask: projectedBoundsMask(mismatchedSnapshot, [-0.2, -0.4, 0], [0.2, 0.1, 0]),
    });
    const result = await liftMultiViewGaussians({
      splat: scene.splat as never,
      worldGeneration: GEN,
      views: [targetView],
      peerObjects,
      options: { raysPerView: 160, bboxPaddingRatio: 0.2, depthToleranceSceneUnits: 0.1, useAdaptiveDepthTolerance: false },
    });
    const selected = new Set(result.indices);
    assert.ok(scene.tableIndices.some((index) => selected.has(index)), "at least part of the tabletop should remain selected");
    for (const index of scene.chairIndices) assert.ok(!selected.has(index), `chair Gaussian ${index} should be peer-owned`);
    for (const index of scene.backgroundIndices) assert.ok(!selected.has(index), `wall Gaussian ${index} should be rejected`);
    assert.ok(selected.has(scene.planarScaleIndex), "a moderate anisotropic surface splat remains eligible");
    assert.ok(!selected.has(scene.scaleOutlierIndex));
    assert.ok(result.diagnostics.rejectedPeerCount > 0);
    assert.ok(result.diagnostics.peerSurfaceHitsRemoved > 0);
    assert.ok(result.diagnostics.rejectedScaleCount > 0);
    assert.equal(result.diagnostics.excludedPeerViews, 2, "stale and mismatched peer snapshots are skipped without excluding valid peers");
  });

  test("zero-variance Stage A depth samples use the configured 0.25 scene-unit fallback", async () => {
    const splat = buildSplat();
    const snapshot = capture([0, 0, 3], splat);
    const views: ViewObservation[] = [{ ...observations(splat)[0], snapshot }];
    const cast = (origin: SnapshotVector3, direction: SnapshotVector3) => {
      const t = (0.5 - origin.z) / direction.z;
      const point = { x: origin.x + direction.x * t, y: origin.y + direction.y * t, z: 0.5 };
      return [{ distance: t, point }];
    };
    const result = await liftMultiViewGaussians({ splat: splat as never, worldGeneration: GEN, views, cast });
    assert.equal(result.diagnostics.depthToleranceByView.front, 0.25);
  });

  const plateScene = () => {
    const points: P[] = [];
    for (let x = -0.4; x <= 0.4001; x += 0.1) for (let y = -0.4; y <= 0.4001; y += 0.1) {
      points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, 0]);
    }
    const splat = new SplatMesh(points.map((center) => ({ center })), 0.06);
    splat.updateMatrixWorld(true);
    const snapshot = capture([0, 0, 3], splat);
    const mask = projectedBoundsMask(snapshot, [-0.4, -0.4, 0], [0.4, 0.4, 0]);
    return { points, splat, snapshot, mask };
  };

  test("a duplicate/parent peer (same mask, IoU >= 0.7) is ignored instead of emptying the lift", async () => {
    const { points, splat, snapshot, mask } = plateScene();
    const result = await liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask }],
      peerObjects: [{ objectId: "dining-table", view: "front", snapshot, visible: true, mask }],
      options: { raysPerView: 80 },
    });
    assert.deepEqual(result.diagnostics.duplicatePeerIds, ["dining-table"]);
    assert.equal(result.diagnostics.peerSurfaceHitsRemoved, 0);
    assert.equal(result.diagnostics.rejectedPeerCount, 0);
    assert.ok(result.diagnostics.surfacePointCount > 0);
    assert.ok(result.obb);
    assert.ok(result.indices.length >= points.length * 0.9, `only ${result.indices.length}/${points.length} plate splats kept`);
  });

  test("a non-duplicate co-surface peer wins ambiguous hits, but the consumption cap keeps the target alive", async () => {
    const { splat, snapshot, mask } = plateScene();
    // Parent-sized peer: contains the target (IoU ~0.25), so it is NOT a duplicate; same depth surface.
    const peerMask = projectedBoundsMask(snapshot, [-0.8, -0.8, 0], [0.8, 0.8, 0]);
    const lift = (maxPeerHitConsumptionRatio: number) => liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask }],
      peerObjects: [{ objectId: "floor", view: "front", snapshot, visible: true, mask: peerMask }],
      options: { raysPerView: 80, maxPeerHitConsumptionRatio },
    });

    const uncapped = await lift(1);
    assert.deepEqual(uncapped.diagnostics.duplicatePeerIds, []);
    assert.equal(uncapped.indices.length, 0);
    assert.equal(uncapped.obb, null);
    assert.deepEqual(uncapped.diagnostics.excludedViews, [{ view: "front", reason: "all hits peer-owned" }]);

    const capped = await lift(0.85);
    assert.deepEqual(capped.diagnostics.peerOwnershipCappedViews, ["front"]);
    assert.ok(capped.diagnostics.surfacePointCount > 0);
    assert.ok(capped.diagnostics.peerSurfaceHitsRemoved <= Math.floor(0.85 * capped.diagnostics.sparseHitsPerView.front!));
    assert.deepEqual(capped.diagnostics.excludedViews, []);
    assert.ok(capped.obb);
  });

  test("a view with no hits at all keeps the distinct 'no splat surface hits' reason", async () => {
    const { splat, snapshot } = plateScene();
    // Mask over empty space: rays miss every splat.
    const empty = projectedBoundsMask(snapshot, [1.2, 1.2, 0], [1.4, 1.4, 0]);
    const result = await liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask: empty }],
      options: { raysPerView: 20 },
    });
    assert.deepEqual(result.diagnostics.excludedViews, [{ view: "front", reason: "no splat surface hits inside the mask" }]);
  });

  test("overlapping peer 0.1 behind: the target keeps its exclusive region and none of the peer's surface leaks in", async () => {
    const targetPoints: P[] = [];
    const peerPoints: P[] = [];
    for (let y = -0.3; y <= 0.3001; y += 0.1) {
      const yy = Math.round(y * 10) / 10;
      for (let x = -0.6; x <= 0.2001; x += 0.1) targetPoints.push([Math.round(x * 10) / 10, yy, 0]);
      for (let x = -0.2; x <= 0.6001; x += 0.1) peerPoints.push([Math.round(x * 10) / 10, yy, -0.1]);
    }
    const splat = new SplatMesh([...targetPoints, ...peerPoints].map((center) => ({ center })), 0.06);
    splat.updateMatrixWorld(true);
    const snapshot = capture([0, 0, 3], splat);
    const result = await liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.65, -0.35, 0], [0.25, 0.35, 0]) }],
      peerObjects: [{ objectId: "neighbour", view: "front", snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.25, -0.35, -0.1], [0.65, 0.35, -0.1]) }],
      // Fixed 0.08 tolerance: tighter than the 0.1 gap between the two surfaces, wider than a splat radius.
      options: { raysPerView: 120, bboxPaddingRatio: 0.3, useAdaptiveDepthTolerance: false, depthToleranceSceneUnits: 0.08 },
    });
    const selected = new Set(result.indices);
    assert.deepEqual(result.diagnostics.duplicatePeerIds, [], "overlapping but distinct peers are kept");
    // Target splats clear of the overlap are all kept.
    targetPoints.forEach(([x], i) => { if (x <= -0.3) assert.ok(selected.has(i), `target splat ${i} (x=${x}) should be kept`); });
    // No splat of the peer's own surface (z = -0.1) is claimed by the target.
    peerPoints.forEach((_, i) => assert.ok(!selected.has(targetPoints.length + i), `peer splat ${i} must not be lifted`));
  });

  test("nested peer: a tissue box on the tabletop does not punch a hole; table splats hidden behind it survive via other views", async () => {
    const table: P[] = [];
    for (let x = -0.8; x <= 0.8001; x += 0.1) for (let z = -0.5; z <= 0.5001; z += 0.1) table.push([Math.round(x * 10) / 10, 0, Math.round(z * 10) / 10]);
    const box: P[] = [];
    const ticks = [-0.1, -0.05, 0, 0.05, 0.1];
    for (const x of ticks) for (const z of ticks) for (const y of [0, 0.05, 0.1, 0.15, 0.2]) {
      if (Math.abs(x) === 0.1 || Math.abs(z) === 0.1 || y === 0.2) box.push([x, y, z]);
    }
    const splat = new SplatMesh([...table, ...box].map((center) => ({ center })), 0.06);
    splat.updateMatrixWorld(true);
    const up: P = [0, 1, 0];
    const poses: Array<[ViewObservation["view"], P, P | undefined]> = [
      ["front", [0, 1.2, 2.5], up], ["side", [2.5, 1.2, 0], up], ["top", [0, 3, 0], undefined],
    ];
    const views: ViewObservation[] = [];
    const peerObjects: PeerViewObservation[] = [];
    for (const [view, position, upVector] of poses) {
      const snapshot = capture(position, splat, GEN, upVector);
      views.push({ view, snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.9, -0.07, -0.6], [0.9, 0.07, 0.6]) });
      peerObjects.push({ objectId: "tissue-box", view, snapshot, visible: true, // Masks cover the whole object, splat radius (0.06) included.
      mask: projectedBoundsMask(snapshot, [-0.17, -0.06, -0.17], [0.17, 0.27, 0.17]) });
    }
    const result = await liftMultiViewGaussians({
      splat: splat as never, worldGeneration: GEN, views, peerObjects,
      options: { raysPerView: 150, bboxPaddingRatio: 0.2 },
    });
    const selected = new Set(result.indices);
    assert.deepEqual(result.diagnostics.duplicatePeerIds, []);
    // The splat at (0, 0, -0.3) is hidden behind the box from the front-oblique camera but visible from the top.
    const shadow = table.findIndex(([x, , z]) => x === 0 && z === -0.3);
    assert.ok(shadow >= 0 && selected.has(shadow), "table splat hidden behind the box in one view must survive");
    assert.ok(result.diagnostics.abstainedOccludedCount > 0, "occluded views abstain");
    // The table as a whole keeps high recall (no hole around the box).
    const tableKept = table.filter((_, i) => selected.has(i)).length;
    assert.ok(tableKept >= table.length * 0.85, `table recall ${tableKept}/${table.length}`);
    // The box faces the cameras see (front +z, side +x, top) are not lifted into the table. The far
    // back/left faces are visible to no view, which is the documented hidden-surface limitation.
    box.forEach(([x, y, z], i) => {
      if (y >= 0.1 && (z === 0.1 || x === 0.1 || y === 0.2)) assert.ok(!selected.has(table.length + i), `box splat ${i} (${x}, ${y}, ${z}) must stay with the peer`);
    });
    assert.ok(result.diagnostics.rejectedPeerCount > 0);
  });

  test("sloped plane: a grazing tabletop keeps high splat recall under the adaptive tolerance", async () => {
    const plane: P[] = [];
    for (let x = -0.8; x <= 0.8001; x += 0.1) for (let z = -1; z <= 1.0001; z += 0.1) plane.push([Math.round(x * 10) / 10, 0, Math.round(z * 10) / 10]);
    const splat = new SplatMesh(plane.map((center) => ({ center })), 0.06);
    splat.updateMatrixWorld(true);
    const snapshot = capture([0, 0.9, 3.2], splat, GEN, [0, 1, 0]);
    const result = await liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.9, -0.07, -1.1], [0.9, 0.07, 1.1]) }],
      options: { raysPerView: 150, bboxPaddingRatio: 0.2 },
    });
    const tolerance = result.diagnostics.depthToleranceByView.front!;
    const kept = result.indices.length;
    assert.ok(kept >= plane.length * 0.9, `grazing plane recall ${kept}/${plane.length} (tolerance ${tolerance})`);
  });

  /**
   * Y-up dining table. Left half of the top is compact splats; the right half (x >= 0.3, rim and both right
   * corners included) is a few very wide flat ellipsoids, as on a low-texture white surface. Four legs, a dense
   * floor with wide grazing splats directly beneath the table, and three chairs pulled partway in: seats below
   * the top (y = 0.45), backrests poking above it, boxes overlapping the table in the image.
   */
  const buildDiningScene = () => {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const topY = 0.75;
    const tabletop: P[] = [];
    for (let x = -0.8; x <= 0.8001; x += 0.1) for (let z = -0.4; z <= 0.4001; z += 0.1) tabletop.push([r1(x), topY, r1(z)]);
    const legs: P[] = [];
    for (const x of [-0.7, 0.7]) for (const z of [-0.3, 0.3]) for (let y = 0; y <= 0.7001; y += 0.1) legs.push([x, r1(y), z]);
    const floor: P[] = [];
    for (let x = -1.2; x <= 1.2001; x += 0.1) for (let z = -0.8; z <= 1.0001; z += 0.1) floor.push([r1(x), 0, r1(z)]);
    const chairCenters = [-0.5, 0.35, 0.75];
    const seats: P[] = [];
    const backrests: P[] = [];
    for (const cx of chairCenters) {
      for (let x = cx - 0.1; x <= cx + 0.1001; x += 0.1) {
        for (let z = 0.2; z <= 0.8001; z += 0.1) seats.push([r1(x), 0.45, r1(z)]);
        for (let y = 0.55; y <= 0.95001; y += 0.1) backrests.push([r1(x), r1(y), 0.8]);
      }
    }
    const all = [...tabletop, ...legs, ...floor, ...seats, ...backrests];
    const wideTop = (p: P) => p[0] >= 0.3;
    const underTable = (p: P) => Math.abs(p[0]) <= 0.8 && Math.abs(p[2]) <= 0.4;
    const flat = (sigma: number): [number, number, number] => [sigma, 0.01, sigma * 0.5];
    const splat = new SplatMesh(all.map((center) => {
      if (center[1] === topY && wideTop(center)) return { center, scales: flat(0.5) };
      if (center[1] === 0 && underTable(center)) return { center, scales: flat(0.5) };
      return { center };
    }), 0.06);
    splat.updateMatrixWorld(true);
    const range = (list: P[], offset: number) => list.map((_, i) => offset + i);
    const tabletopIdx = range(tabletop, 0);
    const legIdx = range(legs, tabletop.length);
    const floorStart = tabletop.length + legs.length;
    const floorIdx = range(floor, floorStart);
    const seatIdx = range(seats, floorStart + floor.length);
    const backrestIdx = range(backrests, floorStart + floor.length + seats.length);
    return { splat, tabletop, legs, floor, seats, backrests, tabletopIdx, floorIdx, seatIdx, backrestIdx, legIdx, chairCenters, wideTop, underTable };
  };

  const diningViews = (scene: ReturnType<typeof buildDiningScene>) => {
    const up: P = [0, 1, 0];
    const poses: Array<[ViewObservation["view"], P, P | undefined]> = [
      ["front", [0, 1.6, 3], up], ["side", [3, 1.6, 0], up], ["top", [0, 4, 0], undefined],
    ];
    const views: ViewObservation[] = [];
    const peerObjects: PeerViewObservation[] = [];
    for (const [view, position, upVector] of poses) {
      const snapshot = capture(position, scene.splat, GEN, upVector);
      views.push({ view, snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.8, 0, -0.4], [0.8, 0.78, 0.4]) });
      scene.chairCenters.forEach((cx, i) => peerObjects.push({
        objectId: `chair-${i + 1}`, view, snapshot, visible: true,
        mask: projectedBoundsMask(snapshot, [cx - 0.15, 0.4, 0.2], [cx + 0.15, 0.95, 0.85]),
      }));
    }
    return { views, peerObjects };
  };

  test("dining tabletop: wide flat top ellipsoids (right rim and corners) are kept; the grazing floor beneath and tucked-in chairs are not", async () => {
    const scene = buildDiningScene();
    const { views, peerObjects } = diningViews(scene);

    // Precondition: the right-rim tabletop (corners included) really does project inside a chair peer box.
    const cornerIdx = scene.tabletopIdx.filter((i) => Math.abs(scene.tabletop[i][0]) === 0.8 && Math.abs(scene.tabletop[i][2]) === 0.4);
    assert.equal(cornerIdx.length, 4);
    const overlapping = (view: LiftView, i: number) => peerObjects.some((peer) => {
      if (peer.view !== view) return false;
      const [x, y, z] = scene.tabletop[i];
      const n = projectSnapshotPoint(peer.snapshot, { x, y, z }, GEN).normalized!;
      return peer.mask!.data[Math.min(H - 1, Math.floor(n.v * H)) * W + Math.min(W - 1, Math.floor(n.u * W))] === 1;
    });
    const rightRimOverlap = scene.tabletopIdx.filter((i) => scene.tabletop[i][0] >= 0.6 && (overlapping("front", i) || overlapping("side", i)));
    assert.ok(rightRimOverlap.length >= 4, `only ${rightRimOverlap.length} right-rim tabletop splats overlap a chair box`);

    const result = await liftMultiViewGaussians({ splat: scene.splat as never, worldGeneration: GEN, views, peerObjects });
    const selected = new Set(result.indices);
    const d = result.diagnostics;

    // The whole tabletop is lifted: compact left half, wide right half, and every corner.
    const missing = scene.tabletopIdx.filter((i) => !selected.has(i)).map((i) => scene.tabletop[i].join(","));
    assert.deepEqual(missing, [], "every tabletop splat should be selected");
    for (const i of cornerIdx) assert.ok(selected.has(i), `corner splat ${scene.tabletop[i]} should be selected`);
    const wide = scene.tabletopIdx.filter((i) => scene.wideTop(scene.tabletop[i]));
    assert.ok(wide.length > 0 && wide.every((i) => selected.has(i)), "wide flat top ellipsoids survive the scale fence");
    assert.ok(d.slabScaleExemptCount > 0, "the scale fence really would have pruned them");

    // Floor beneath the table is gone; the separate support slab was detected.
    const floorUnderTable = scene.floorIdx.filter((i) => scene.underTable(scene.floor[i - scene.floorIdx[0]]));
    assert.ok(floorUnderTable.length > 100);
    assert.deepEqual(floorUnderTable.filter((i) => selected.has(i)), [], "no floor splat beneath the table is selected");
    assert.ok(d.rejectedFloorCount >= floorUnderTable.length);
    assert.ok(Math.abs(d.upperSurfaceY! - 0.75) < 0.1, `upperSurfaceY ${d.upperSurfaceY}`);
    assert.ok(d.minHitY! < 0.1, `minHitY ${d.minHitY}`);

    // Tucked-in chairs (seats and backrests) stay out.
    assert.deepEqual([...scene.seatIdx, ...scene.backrestIdx].filter((i) => selected.has(i)), []);
    assert.ok(d.rejectedPeerCount > 0, "peers were genuinely in play");
    assert.equal(d.candidateCount, d.acceptedCount + d.rejectedBackgroundCount + d.rejectedPeerCount + d.rejectedScaleCount + d.rejectedFloorCount + d.rejectedInsufficientVotesCount);
  });

  test("adaptive depth tolerance is floored at 2.5x the median primitive size so grazing views do not abstain", async () => {
    const radius = 0.3; // large enough that the floor exceeds the 0.25 zero-variance fallback and the 1.5x floor (0.45)
    const points: P[] = [];
    for (let x = -0.8; x <= 0.8001; x += 0.2) for (let z = -1; z <= 1.0001; z += 0.2) points.push([Math.round(x * 10) / 10, 0, Math.round(z * 10) / 10]);
    const splat = new SplatMesh(points.map((center) => ({ center })), radius);
    splat.updateMatrixWorld(true);
    const snapshot = capture([0, 0.9, 3.2], splat, GEN, [0, 1, 0]);
    const result = await liftMultiViewGaussians({
      splat: splat as never,
      worldGeneration: GEN,
      views: [{ view: "front", snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.9, -0.3, -1.1], [0.9, 0.3, 1.1]) }],
    });
    assert.ok(result.diagnostics.depthToleranceByView.front! >= 2.5 * radius - 1e-9, `tolerance ${result.diagnostics.depthToleranceByView.front}`);
  });

  test("floor-level object: a wide flat rug has no separate upper slab, so its own splats are not floor-rejected", async () => {
    const points: P[] = [];
    for (let x = -0.8; x <= 0.8001; x += 0.1) for (let z = -0.6; z <= 0.6001; z += 0.1) points.push([Math.round(x * 10) / 10, 0, Math.round(z * 10) / 10]);
    const splat = new SplatMesh(points.map((center) => ({ center, scales: [0.1, 0.01, 0.1] as [number, number, number] })), 0.06);
    splat.updateMatrixWorld(true);
    const views: ViewObservation[] = [];
    for (const [view, position, up] of [["front", [0, 2.5, 2.5], [0, 1, 0]], ["top", [0, 4, 0], undefined]] as Array<[ViewObservation["view"], P, P | undefined]>) {
      const snapshot = capture(position, splat, GEN, up);
      views.push({ view, snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.9, -0.07, -0.7], [0.9, 0.07, 0.7]) });
    }
    const result = await liftMultiViewGaussians({ splat: splat as never, worldGeneration: GEN, views });
    assert.equal(result.diagnostics.rejectedFloorCount, 0);
    assert.ok(result.indices.length >= points.length * 0.9, `rug recall ${result.indices.length}/${points.length}`);
  });

  test("defaults: a box-only view probes closer to the rim than the old 10% inset did", async () => {
    const { splat, snapshot } = plateScene();
    // Gemini-convention box exactly around the plate's projection (u/v extents of the 0.8 x 0.8 plate).
    const mask = projectedBoundsMask(snapshot, [-0.4, -0.4, 0], [0.4, 0.4, 0]);
    let ymin = H, ymax = 0, xmin = W, xmax = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask.data[y * W + x]) {
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    }
    const view: ViewObservation = { view: "front", snapshot, visible: true, mask: null, bboxNormalized: [ymin / H, xmin / W, (ymax + 1) / H, (xmax + 1) / W] };
    const extent = async (options: object) => {
      const r = await liftMultiViewGaussians({ splat: splat as never, worldGeneration: GEN, views: [view], options });
      const xs = r.surfacePoints.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    const current = await extent({});
    const legacy = await extent({ boxInsetRatio: 0.1 });
    assert.ok(current > legacy, `default hit extent ${current} should exceed the 10%-inset extent ${legacy}`);
  });

  test("multi-part object: a sofa keeps its full height unless dominantLayer is requested", async () => {
    const sofa: P[] = [];
    for (let x = -0.6; x <= 0.6001; x += 0.05) for (let z = -0.3; z <= 0.3001; z += 0.05) sofa.push([Math.round(x * 20) / 20, 0.3, Math.round(z * 20) / 20]);
    for (let x = -0.6; x <= 0.6001; x += 0.1) for (let y = 0.4; y <= 0.9001; y += 0.1) sofa.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, -0.3]);
    const splat = new SplatMesh(sofa.map((center) => ({ center })), 0.06);
    splat.updateMatrixWorld(true);
    const poses: Array<[ViewObservation["view"], P]> = [["front", [0, 0.8, 3]], ["side", [3, 0.8, 0]], ["top", [0, 3.5, 0]]];
    const views: ViewObservation[] = poses.map(([view, position]) => {
      const snapshot = capture(position, splat);
      return { view, snapshot, visible: true, mask: projectedBoundsMask(snapshot, [-0.7, 0.24, -0.36], [0.7, 0.96, 0.36]) };
    });
    const lift = (options: object) => liftMultiViewGaussians({ splat: splat as never, worldGeneration: GEN, views, options: { raysPerView: 120, ...options } });
    const full = await lift({});
    const slab = await lift({ dominantLayer: true });
    assert.ok(full.obb && slab.obb);
    assert.equal(full.obb.method, "upright");
    assert.ok(full.obb.obb.size.y >= 0.5, `default OBB height ${full.obb.obb.size.y} should span seat + backrest`);
    assert.ok(slab.obb.obb.size.y < 0.3, `dominantLayer OBB height ${slab.obb.obb.size.y} should collapse to the seat slab`);
  });

  test("the upright OBB spans the accepted Gaussians, not the inset Stage A probe cloud", async () => {
    const splat = buildSplat();
    const result = await run(splat, observations(splat), { boxInsetRatio: 0.3 });
    const accepted = [...result.indices].map((i) => uniqueCube[i]);
    const ys = accepted.map((p) => p[1]);
    assert.ok(result.obb);
    const height = result.obb.obb.size.y;
    // Accepted splats reach the cube's top face (y = 0.5) even though probes are inset.
    assert.ok(Math.max(...ys) === 0.5);
    assert.ok(height > 0.85, `OBB height ${height}`);
  });

  test("scales/quaternion are only cloned for Gaussians that pass the cheap opacity and AABB rejects", async () => {
    const splat = buildSplat();
    const original = splat.forEachSplat.bind(splat);
    let clones = 0;
    const wrapped = new WeakSet<object>();
    splat.forEachSplat = ((cb: Parameters<typeof original>[0]) => original((i, c, sc, q, o, col) => {
      if (!wrapped.has(sc)) {
        wrapped.add(sc);
        const clone = sc.clone.bind(sc);
        sc.clone = () => { clones++; return clone(); };
      }
      cb(i, c, sc, q, o, col);
    })) as typeof splat.forEachSplat;
    const result = await run(splat, observations(splat));
    assert.ok(result.diagnostics.scannedCount > result.diagnostics.candidateCount, "some Gaussians are outside the search box");
    assert.equal(clones, result.diagnostics.candidateCount);
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
