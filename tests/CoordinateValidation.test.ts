import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import {
  aggregateStats,
  analyseSplatRaycastSpace,
  buildValidationReport,
  captureCameraState,
  captureSplatTransform,
  checkRayConsistency,
  diffCameraStates,
  pixelError,
  projectPoint,
  testSpaceHypothesis,
  validateClickReprojection,
  validateSampleReprojections,
} from "../src/diagnostics/coordinateValidation.ts";
import { applySampling, createDetectionDiagnostics, applySanitize } from "../src/diagnostics/records.ts";
import type { SampleCellProbe } from "../src/diagnostics/records.ts";
import type {
  AnnotationRequestDiagnostics,
  ClickCameraSnapshot,
  SplatTransformRecord,
  Vec3Record,
  ViewportRecord,
} from "../src/diagnostics/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Camera at the origin looking down -Z (identity pose), fov 90°, aspect 1.
 * For this camera m00 = m11 = 1, so ndc.x = x / (-z_view) and
 * ndc.y = y / (-z_view) — every expectation below is hand-derived from that.
 */
function originCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateMatrixWorld(true);
  return camera;
}

function viewport(width: number, height: number): ViewportRecord {
  return {
    rectLeft: 0,
    rectTop: 0,
    rectWidth: width,
    rectHeight: height,
    cssWidth: width,
    cssHeight: height,
    bufferWidth: width * 2,
    bufferHeight: height * 2,
    devicePixelRatio: 2,
  };
}

function snapshot(
  camera: THREE.Camera,
  splat: THREE.Object3D | null = null,
  view: ViewportRecord = viewport(800, 600),
): ClickCameraSnapshot {
  return {
    camera: captureCameraState(camera),
    viewport: view,
    splat: captureSplatTransform(splat),
  };
}

/**
 * World point at ray parameter `distance` along the camera ray through the
 * given normalized screen coordinate. Any point on that ray projects back to
 * exactly (u, v) — central projection — so such a hit must reproject with
 * zero error.
 */
function pointAt(u: number, v: number, distance: number, camera: THREE.Camera): Vec3Record {
  const nearPlane = new THREE.Vector3(u * 2 - 1, -(v * 2 - 1), -1).unproject(camera);
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const direction = nearPlane.sub(origin).normalize();
  const point = origin.addScaledVector(direction, distance);
  return { x: point.x, y: point.y, z: point.z };
}

function clickRecord(
  u: number,
  v: number,
  hit: Vec3Record,
  cameraSnapshot: ClickCameraSnapshot | null,
  ray?: { origin: Vec3Record; direction: Vec3Record; distance: number },
): AnnotationRequestDiagnostics["click"] {
  return {
    normalizedX: u,
    normalizedY: v,
    clientX: Math.round(u * 800),
    clientY: Math.round(v * 600),
    cameraPosition: { x: 0, y: 0, z: 0 },
    cameraQuaternion: { x: 0, y: 0, z: 0, w: 1 },
    rayOrigin: ray?.origin ?? null,
    rayDirection: ray?.direction ?? null,
    hit: { position: hit, distance: ray?.distance ?? 2 },
    cameraSnapshot,
  };
}

function request(click: AnnotationRequestDiagnostics["click"]): AnnotationRequestDiagnostics {
  return {
    index: 1,
    startedAt: "2026-11-09T00:00:00.000Z",
    source: "click",
    worldGeneration: 0,
    click,
    snapshotDataUrl: null,
    response: null,
    detections: [],
  };
}

function cellProbe(
  row: number,
  col: number,
  u: number,
  v: number,
  hitPoint: THREE.Vector3 | null,
): SampleCellProbe {
  const origin = new THREE.Vector3(0, 0, 0);
  const direction = hitPoint ? hitPoint.clone().normalize() : new THREE.Vector3(0, 0, -1);
  return {
    row,
    col,
    normalizedX: u,
    normalizedY: v,
    rayOrigin: origin,
    rayDirection: direction,
    intersection: hitPoint
      ? {
          distance: hitPoint.length(),
          point: hitPoint,
        } as THREE.Intersection
      : null,
  };
}

function requestWithSampling(
  clickSnapshot: ClickCameraSnapshot | null,
  probes: SampleCellProbe[],
): AnnotationRequestDiagnostics {
  const detection = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
  applySanitize(detection, [0, 0, 1, 1]);
  applySampling(detection, Math.sqrt(probes.length), probes);
  return {
    ...request(clickRecord(0.5, 0.5, { x: 0, y: 0, z: -2 }, clickSnapshot)),
    detections: [detection],
  };
}

// ---------------------------------------------------------------------------
// 1. Known world point → known screen coordinate (hand-computed)
// ---------------------------------------------------------------------------

describe("projection math (Feature B steps 5-8)", () => {
  const camera = originCamera();
  const state = captureCameraState(camera);

  test("origin camera: hand-computed frustum points project to exact coordinates", () => {
    // fov 90°, aspect 1 ⇒ ndc.x = x/(-z), ndc.y = y/(-z).
    const centre = projectPoint({ x: 0, y: 0, z: -2 }, state);
    assert.ok(centre.normalized);
    assert.ok(Math.abs(centre.normalized.u - 0.5) < 1e-12);
    assert.ok(Math.abs(centre.normalized.v - 0.5) < 1e-12);

    const right = projectPoint({ x: 1, y: 0, z: -2 }, state);
    assert.ok(Math.abs(right.normalized!.u - 0.75) < 1e-12); // ndc.x = 1/2
    assert.ok(Math.abs(right.normalized!.v - 0.5) < 1e-12);

    const up = projectPoint({ x: 0, y: 1, z: -2 }, state);
    assert.ok(Math.abs(up.normalized!.u - 0.5) < 1e-12);
    // NDC y is bottom-up but normalized v is top-down (verified against
    // splatRay's ndcY = -(normalizedY*2-1) and the DOM label projection).
    assert.ok(Math.abs(up.normalized!.v - 0.25) < 1e-12);
  });

  test("agrees with THREE.Vector3.project on an off-axis camera (independent path)", () => {
    const moved = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
    moved.position.set(1.2, -0.7, 3.4);
    moved.lookAt(-0.3, 0.2, -1.1);
    moved.updateMatrixWorld(true);
    const movedState = captureCameraState(moved);
    const point = new THREE.Vector3(-0.44, 0.31, -0.9);
    const expected = point.clone().project(moved);
    const outcome = projectPoint({ x: point.x, y: point.y, z: point.z }, movedState);
    assert.ok(outcome.normalized && outcome.ndc);
    assert.ok(Math.abs(outcome.ndc.x - expected.x) < 1e-9, "ndc.x must match THREE");
    assert.ok(Math.abs(outcome.ndc.y - expected.y) < 1e-9, "ndc.y must match THREE");
    assert.ok(Math.abs(outcome.normalized.u - (expected.x * 0.5 + 0.5)) < 1e-9);
    assert.ok(Math.abs(outcome.normalized.v - (-expected.y * 0.5 + 0.5)) < 1e-9);
  });

  test("points behind the camera are flagged, not mirrored", () => {
    const behind = projectPoint({ x: 0, y: 0, z: 2 }, state);
    assert.equal(behind.behindCamera, true);
    assert.equal(behind.normalized, null);
    assert.equal(behind.ndc, null);
    assert.equal(behind.outsideClipVolume, true);
  });

  test("outside-clip-volume detection", () => {
    const outside = projectPoint({ x: 3, y: 0, z: -2 }, state);
    assert.equal(outside.behindCamera, false);
    assert.equal(outside.outsideClipVolume, true); // ndc.x = 1.5
    const inside = projectPoint({ x: 0.5, y: 0.5, z: -2 }, state);
    assert.equal(inside.outsideClipVolume, false);
  });

  test("non-identity camera world matrix is inverted for the view transform", () => {
    const moved = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    moved.position.set(0, 0, 5); // looking down -Z toward the origin
    moved.updateMatrixWorld(true);
    const movedState = captureCameraState(moved);
    const outcome = projectPoint({ x: 0, y: 1, z: 3 }, movedState);
    // View space: (0, 1, -2) ⇒ ndc.y = 0.5 ⇒ v = 0.25.
    assert.ok(Math.abs(outcome.normalized!.u - 0.5) < 1e-12);
    assert.ok(Math.abs(outcome.normalized!.v - 0.25) < 1e-12);
    assert.ok(Math.abs(outcome.viewZ - -2) < 1e-12);
  });
});

// ---------------------------------------------------------------------------
// 2. Click-hit reprojection
// ---------------------------------------------------------------------------

describe("click-hit reprojection (Feature B)", () => {
  test("a self-consistent click reprojects with ~zero error", () => {
    const camera = originCamera();
    const u = 0.3;
    const v = 0.4;
    const hit = pointAt(u, v, 2, camera);
    const hitVec = new THREE.Vector3(hit.x, hit.y, hit.z);
    const click = clickRecord(u, v, hit, snapshot(camera), {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: hitVec.x / 2, y: hitVec.y / 2, z: hitVec.z / 2 },
      distance: 2,
    });
    const result = validateClickReprojection(request(click));
    assert.equal(result.status, "ok");
    assert.equal(result.cameraSource, "click-snapshot");
    assert.ok(result.errors);
    assert.ok(result.errors.normalized < 1e-9, `normalized error ${result.errors.normalized}`);
    assert.ok(result.errors.pixels < 1e-6);
    assert.equal(result.spaceHypothesis?.verdict, "consistent-with-world");
    assert.ok((result.rayConsistency?.offset ?? 1) < 1e-6);
  });

  test("a displaced hit reports the exact expected error", () => {
    const camera = originCamera();
    // Click at u=0.3 on the z=-2 plane is x=-0.8; displace the hit by +0.5 in x.
    const click = clickRecord(0.3, 0.4, { x: -0.3, y: 0.4, z: -2 }, snapshot(camera));
    const result = validateClickReprojection(request(click));
    assert.ok(result.projected?.normalized);
    // ndc.x = -0.3/2 ⇒ u = 0.5 - 0.075 = 0.425 ⇒ dx = 0.125.
    assert.ok(Math.abs(result.projected.normalized.u - 0.425) < 1e-12);
    assert.ok(Math.abs(result.errors!.dx - 0.125) < 1e-12);
    assert.ok(Math.abs(result.errors!.dy) < 1e-12);
    assert.ok(Math.abs(result.errors!.normalized - 0.125) < 1e-12);
    // 800px wide canvas ⇒ 0.125 × 800 = 100 px exactly.
    assert.ok(Math.abs(result.errors!.pixels - 100) < 1e-9);
  });

  test("a click-time snapshot is never replaced by the live camera", () => {
    const clickCamera = originCamera();
    const hit = pointAt(0.3, 0.4, 2, clickCamera);
    const click = clickRecord(0.3, 0.4, hit, snapshot(clickCamera));
    // The report is built while the live camera has moved AND rotated: the
    // click validation must still use the frozen click-time snapshot.
    const moved = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    moved.position.set(4, -2, 1);
    moved.rotateY(Math.PI / 2);
    moved.updateMatrixWorld(true);
    const report = buildValidationReport(request(click), {
      capturedAt: "2026-11-09T00:00:01.000Z",
      ...snapshot(moved),
    });
    assert.ok(report.clickValidation.errors);
    assert.ok(report.clickValidation.errors.normalized < 1e-9, "frozen snapshot must be used");
    assert.equal(report.clickValidation.cameraSource, "click-snapshot");
    assert.equal(report.cameraDiff?.cameraMoved, true);
  });
});

// ---------------------------------------------------------------------------
// 3. Sampling-hit reprojection + aggregates
// ---------------------------------------------------------------------------

describe("sampling-hit reprojection (Feature C)", () => {
  function buildMixedRequest(): AnnotationRequestDiagnostics {
    const camera = originCamera();
    // Origin camera (fov 90, aspect 1): u = 0.5 + x/4, v = 0.5 + y/4 on z=-2.
    // Cell (0.25, 0.25): exact hit (-1, 1, -2) → zero error.
    // Cell (0.75, 0.25): hit (0.5, 1, -2) → u 0.625 (du 0.125), v 0.25 (dv 0).
    // 0.125 normalized × 800 px = exactly 100 px.
    return requestWithSampling(snapshot(camera), [
      cellProbe(0, 0, 0.25, 0.25, new THREE.Vector3(-1, 1, -2)),
      cellProbe(0, 1, 0.75, 0.25, new THREE.Vector3(0.5, 1, -2)),
      cellProbe(1, 0, 0.25, 0.75, new THREE.Vector3(0, 0, 5)), // behind camera
      cellProbe(1, 1, 0.75, 0.75, null), // miss
    ]);
  }

  test("counts hits, misses, behind-camera, and never drops rows", () => {
    const result = validateSampleReprojections(buildMixedRequest());
    assert.equal(result.status, "ok");
    assert.equal(result.totalCells, 4);
    assert.equal(result.hitCells, 3);
    assert.equal(result.missCells, 1);
    assert.equal(result.projectedCells, 2);
    assert.equal(result.behindCameraCells, 1);
    assert.equal(result.rows.length, 4, "every cell stays in the table");
    assert.deepEqual(result.rows.map((row) => row.status), ["ok", "ok", "behind-camera", "miss"]);
  });

  test("aggregate statistics are computed over projected hits only", () => {
    const result = validateSampleReprojections(buildMixedRequest());
    const stats = result.normalizedErrorStats!;
    assert.equal(stats.count, 2);
    assert.ok(Math.abs(stats.max - 0.125) < 1e-9);
    assert.ok(Math.abs(stats.median - 0.0625) < 1e-6);
    const pixel = result.pixelErrorStats!;
    assert.ok(Math.abs(pixel.max - 100) < 1e-6, "0.125 × 800");
    assert.ok(Math.abs(pixel.median - 50) < 1e-3);
  });

  test("ray-inconsistent hits are flagged", () => {
    const camera = originCamera();
    const probes = [
      {
        ...cellProbe(0, 0, 0.5, 0.5, new THREE.Vector3(0, 0, -2)),
        intersection: { distance: 2, point: new THREE.Vector3(0.5, 0.5, -2) } as THREE.Intersection,
      },
    ];
    const result = validateSampleReprojections(requestWithSampling(snapshot(camera), probes));
    assert.equal(result.rayInconsistentCells, 1);
    assert.equal(result.rows[0].status, "ray-inconsistent");
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. Camera movement / rotation between click and validation
// ---------------------------------------------------------------------------

describe("camera-state diff (Feature A)", () => {
  test("camera movement is detected and quantified", () => {
    const clickCamera = originCamera();
    const moved = originCamera();
    moved.position.set(1, 0, 0);
    const diff = diffCameraStates(snapshot(clickCamera), snapshot(moved));
    assert.equal(diff.cameraMoved, true);
    assert.ok(Math.abs(diff.positionDeltaMagnitude - 1) < 1e-9);
    assert.ok(diff.rotationDeltaRad < 1e-9);
  });

  test("camera rotation is detected and quantified", () => {
    const clickCamera = originCamera();
    const rotated = originCamera();
    rotated.rotateY(Math.PI / 2);
    const diff = diffCameraStates(snapshot(clickCamera), snapshot(rotated));
    assert.equal(diff.cameraMoved, true);
    assert.ok(Math.abs(diff.positionDeltaMagnitude) < 1e-12);
    assert.ok(Math.abs(diff.rotationDeltaRad - Math.PI / 2) < 1e-9);
  });

  test("identical states report no movement", () => {
    const camera = originCamera();
    const diff = diffCameraStates(snapshot(camera), snapshot(camera));
    assert.equal(diff.cameraMoved, false);
    assert.equal(diff.worldMatrixMaxAbsDelta, 0);
    assert.equal(diff.projectionMatrixMaxAbsDelta, 0);
  });

  test("viewport and DPR changes are reported", () => {
    const camera = originCamera();
    const diff = diffCameraStates(
      snapshot(camera, null, viewport(800, 600)),
      snapshot(camera, null, viewport(1600, 1200)),
    );
    assert.equal(diff.viewportWidthDelta, 800);
    assert.equal(diff.viewportHeightDelta, 600);
    assert.equal(diff.cameraMoved, false, "viewport resize alone is not camera movement");
  });
});

// ---------------------------------------------------------------------------
// 6. Invalid or missing camera state
// ---------------------------------------------------------------------------

describe("invalid or missing camera state", () => {
  test("inject requests (no click) are reported unavailable", () => {
    const result = validateClickReprojection(request(null));
    assert.equal(result.status, "unavailable");
    assert.match(result.reason ?? "", /no click record/);
  });

  test("records without a snapshot report the limitation instead of substituting", () => {
    const hitVec = new THREE.Vector3(-0.8, 0.4, -2);
    const click = clickRecord(0.3, 0.4, { x: -0.8, y: 0.4, z: -2 }, null, {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: hitVec.x / hitVec.length(), y: hitVec.y / hitVec.length(), z: hitVec.z / hitVec.length() },
      distance: hitVec.length(),
    });
    const result = validateClickReprojection(request(click));
    assert.equal(result.status, "unavailable");
    assert.match(result.reason ?? "", /snapshot/);
    assert.match(result.reason ?? "", /projection matrix/);
    // Ray consistency still works without a camera — it needs no projection.
    assert.ok(result.rayConsistency);
    assert.ok(result.rayConsistency.offset < 0.01);
  });

  test("sample validation degrades to ray consistency without a snapshot", () => {
    const detection = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    applySanitize(detection, [0, 0, 1, 1]);
    applySampling(detection, 1, [cellProbe(0, 0, 0.5, 0.5, new THREE.Vector3(0, 0, -2))]);
    const req: AnnotationRequestDiagnostics = {
      ...request(clickRecord(0.5, 0.5, { x: 0, y: 0, z: -2 }, null)),
      detections: [detection],
    };
    const result = validateSampleReprojections(req);
    assert.equal(result.status, "unavailable");
    assert.match(result.reason ?? "", /snapshot/);
    assert.equal(result.cameraUnavailableCells, 1);
    assert.equal(result.projectedCells, 0);
    assert.equal(result.rows[0].status, "camera-unavailable");
    assert.ok(result.rows[0].rayConsistencyOffset !== null);
  });

  test("clicks without a hit are reported unavailable", () => {
    const camera = originCamera();
    const click: AnnotationRequestDiagnostics["click"] = {
      normalizedX: 0.3,
      normalizedY: 0.4,
      clientX: 240,
      clientY: 240,
      cameraPosition: { x: 0, y: 0, z: 0 },
      cameraQuaternion: { x: 0, y: 0, z: 0, w: 1 },
      rayOrigin: { x: 0, y: 0, z: 0 },
      rayDirection: { x: 0, y: 0, z: -1 },
      hit: null,
      cameraSnapshot: snapshot(camera),
    };
    const result = validateClickReprojection(request(click));
    assert.equal(result.status, "unavailable");
    assert.match(result.reason ?? "", /did not intersect/);
  });
});

// ---------------------------------------------------------------------------
// 7. Behind-camera points (aggregates keep them visible)
// ---------------------------------------------------------------------------

describe("behind-camera points", () => {
  test("click hit behind the camera is flagged with undefined projection", () => {
    const camera = originCamera();
    const click = clickRecord(0.5, 0.5, { x: 0, y: 0, z: 5 }, snapshot(camera));
    const result = validateClickReprojection(request(click));
    assert.equal(result.status, "ok");
    assert.equal(result.projected?.behindCamera, true);
    assert.equal(result.projected?.normalized, null);
    assert.equal(result.errors, null);
    assert.equal(result.spaceHypothesis?.verdict, "inconsistent-with-both");
  });
});

// ---------------------------------------------------------------------------
// 8 & 10. Viewport differences and pixel-error calculation
// ---------------------------------------------------------------------------

describe("pixel error and viewport handling", () => {
  const view = viewport(800, 600);

  test("pixel error uses the recorded viewport dimensions per axis", () => {
    assert.ok(Math.abs(pixelError(0.01, 0, view) - 8) < 1e-12); // 0.01 × 800
    assert.ok(Math.abs(pixelError(0, 0.01, view) - 6) < 1e-12); // 0.01 × 600
    assert.ok(Math.abs(pixelError(0.003, 0.004, viewport(1000, 1000)) - 5) < 1e-12);
  });

  test("pixel error scales with the click-time viewport, not the current one", () => {
    const camera = originCamera();
    const clickSmall = clickRecord(0.3, 0.4, { x: -0.3, y: 0.4, z: -2 }, snapshot(camera, null, viewport(800, 600)));
    const clickBig = clickRecord(0.3, 0.4, { x: -0.3, y: 0.4, z: -2 }, snapshot(camera, null, viewport(1600, 1200)));
    const small = validateClickReprojection(request(clickSmall)).errors!;
    const big = validateClickReprojection(request(clickBig)).errors!;
    // Same normalized error (0.125), double the pixels on the bigger canvas.
    assert.ok(Math.abs(small.normalized - big.normalized) < 1e-12);
    assert.ok(Math.abs(big.pixels - 2 * small.pixels) < 1e-9);
    assert.ok(Math.abs(small.pixels - 100) < 1e-9);
  });

  test("aggregateStats uses nearest-rank p95 and a true median", () => {
    const stats = aggregateStats([0.1, 0.2, 0.3, 0.4, 1.0])!;
    assert.ok(Math.abs(stats.mean - 0.4) < 1e-12);
    assert.ok(Math.abs(stats.median - 0.3) < 1e-12);
    assert.ok(Math.abs(stats.max - 1.0) < 1e-12);
    assert.ok(Math.abs(stats.p95 - 1.0) < 1e-12); // ceil(0.95×5)=5th value
    const even = aggregateStats([0.2, 0.4])!;
    assert.ok(Math.abs(even.median - 0.3) < 1e-12);
    assert.equal(aggregateStats([]), null);
  });
});

// ---------------------------------------------------------------------------
// 9. Coordinate-space transformation handling (Feature E)
// ---------------------------------------------------------------------------

describe("coordinate-space hypotheses (Feature E)", () => {
  const camera = originCamera();
  const state = captureCameraState(camera);
  const tolerance = 0.005;

  test("a world-space hit reprojects consistently as world space", () => {
    const hit = pointAt(0.5, 0.5, 2, camera);
    const hypothesis = testSpaceHypothesis(hit, 0.5, 0.5, state, null, tolerance);
    assert.equal(hypothesis.verdict, "consistent-with-world");
    assert.ok((hypothesis.worldError ?? 1) < 1e-9);
  });

  test("a splat-local hit is identified as splat-local, not silently corrected", () => {
    // The splat sits at (0, -1.5, 0). The true world hit reprojects to the
    // click; the record mistakenly stores the splat-LOCAL point.
    const trueWorld = pointAt(0.5, 0.5, 2, camera);
    const localStored: Vec3Record = {
      x: trueWorld.x,
      y: trueWorld.y + 1.5,
      z: trueWorld.z,
    };
    const splat = new THREE.Object3D();
    splat.position.set(0, -1.5, 0);
    splat.updateMatrixWorld(true);
    const hypothesis = testSpaceHypothesis(localStored, 0.5, 0.5, state, captureSplatTransform(splat), tolerance);
    assert.ok((hypothesis.worldError ?? 0) > 0.1, "world interpretation must fail");
    assert.ok((hypothesis.splatLocalError ?? 1) < 1e-9, "splat-local interpretation must succeed");
    assert.equal(hypothesis.verdict, "consistent-with-splat-local");
  });

  test("behind-camera points are inconsistent with both hypotheses", () => {
    const hypothesis = testSpaceHypothesis({ x: 0, y: 0, z: 5 }, 0.5, 0.5, state, null, tolerance);
    assert.equal(hypothesis.worldError, null);
    assert.equal(hypothesis.verdict, "inconsistent-with-both");
  });

  test("Spark raycast space analysis flags non-rigid splat transforms", () => {
    const rigid = new THREE.Object3D();
    rigid.position.set(0, -1.5, 0);
    rigid.updateMatrixWorld(true);
    const rigidAnalysis = analyseSplatRaycastSpace(captureSplatTransform(rigid));
    assert.equal(rigidAnalysis.scaleIsUnit, true);
    assert.equal(rigidAnalysis.sparkRaycastWorldSpaceSafe, true);
    assert.match(rigidAnalysis.note, /world space/);

    const scaled = new THREE.Object3D();
    scaled.scale.set(2, 2, 2);
    scaled.updateMatrixWorld(true);
    const scaledAnalysis = analyseSplatRaycastSpace(captureSplatTransform(scaled));
    assert.equal(scaledAnalysis.scaleIsUnit, false);
    assert.equal(scaledAnalysis.sparkRaycastWorldSpaceSafe, false);
    assert.match(scaledAnalysis.note, /NOT rigid/);

    assert.match(analyseSplatRaycastSpace(null).note, /no splat/);
  });

  test("ray consistency catches a hit that is off its own recorded ray", () => {
    const consistent = checkRayConsistency(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      2,
      { x: 0, y: 0, z: -2 },
    );
    assert.ok(consistent && consistent.offset < 1e-12);
    const inconsistent = checkRayConsistency(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      2,
      { x: 1, y: 0, z: -2 },
    );
    assert.ok(inconsistent && inconsistent.offset > 0.9);
  });
});

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

describe("validation report (Feature F)", () => {
  test("the full report is plain JSON and self-describing", () => {
    const camera = originCamera();
    const hit = pointAt(0.5, 0.5, 2, camera);
    const click = clickRecord(0.5, 0.5, hit, snapshot(camera));
    const report = buildValidationReport(request(click), {
      capturedAt: "2026-11-09T00:00:01.000Z",
      ...snapshot(camera),
    });
    const parsed = JSON.parse(JSON.stringify(report));
    assert.equal(parsed.requestIndex, 1);
    assert.equal(parsed.clickValidation.status, "ok");
    assert.ok(parsed.cameraDiff);
    assert.ok(parsed.coordinateSpaces.sparkRaycast.includes("mesh-local"));
    assert.ok(parsed.splatAnalysis);
    assert.ok(parsed.clickTimeCamera && parsed.validationTimeCamera);
  });

  test("sample rows keep their per-detection grouping across detections", () => {
    const camera = originCamera();
    const first = createDetectionDiagnostics({ label: "rug", box: [0, 0, 1, 1] });
    applySanitize(first, [0, 0, 1, 1]);
    applySampling(first, 1, [cellProbe(0, 0, 0.5, 0.5, new THREE.Vector3(0, 0, -2))]);
    const second = createDetectionDiagnostics({ label: "chair", box: [0, 0, 1, 1] });
    applySanitize(second, [0, 0, 1, 1]);
    applySampling(second, 1, [cellProbe(0, 0, 0.6, 0.6, new THREE.Vector3(0, 0, -2))]);
    const req: AnnotationRequestDiagnostics = {
      ...request(clickRecord(0.5, 0.5, { x: 0, y: 0, z: -2 }, snapshot(camera))),
      detections: [first, second],
    };
    const result = validateSampleReprojections(req);
    assert.equal(result.totalCells, 2);
    assert.deepEqual(result.rows.map((row) => row.detectionIndex), [0, 1]);
    // A single-detection query restricts to that detection.
    const single = validateSampleReprojections(req, { detectionIndex: 1 });
    assert.equal(single.totalCells, 1);
    assert.equal(single.rows[0].detectionIndex, 1);
  });
});

// Type-level export check: SplatTransformRecord shape used by the panel.
describe("splat transform capture", () => {
  test("decomposes matrixWorld into position/quaternion/scale", () => {
    const splat = new THREE.Object3D();
    splat.position.set(0, -1.5, 0);
    splat.updateMatrixWorld(true);
    const record: SplatTransformRecord = captureSplatTransform(splat)!;
    assert.deepEqual(record.position, { x: 0, y: -1.5, z: 0 });
    assert.deepEqual(record.scale, { x: 1, y: 1, z: 1 });
    assert.equal(record.worldMatrix.length, 16);
  });
});
