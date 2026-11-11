import * as THREE from "three";

export type Matrix4Record = readonly number[];

export interface SnapshotVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SnapshotQuaternion {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export interface ViewSnapshotCamera {
  /** World-space camera position and orientation used for the rendered frame. */
  readonly position: SnapshotVector3;
  readonly orientation: SnapshotQuaternion;
  readonly worldMatrix: Matrix4Record;
  readonly inverseWorldMatrix: Matrix4Record;
  readonly projectionMatrix: Matrix4Record;
  readonly projectionKind: "perspective" | "orthographic" | "unsupported";
}

export interface ViewSnapshotViewport {
  /** Canvas rectangle in CSS pixels, relative to the browser viewport. */
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly devicePixelRatio: number;
}

export interface ViewSnapshot {
  readonly id: string;
  readonly worldGeneration: number;
  readonly image: {
    /** One synchronous readback of the canvas that was just rendered. */
    readonly dataUrl: string;
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
  };
  readonly camera: ViewSnapshotCamera;
  readonly viewport: ViewSnapshotViewport;
  /** World transform of the splat drawn in the frame, or null if none was loaded. */
  readonly splat: { readonly matrixWorld: Matrix4Record } | null;
}

export interface SnapshotProjection {
  readonly clip: readonly [number, number, number, number];
  readonly ndc: SnapshotVector3 | null;
  readonly normalized: { readonly u: number; readonly v: number } | null;
  /** CSS pixel position in browser viewport coordinates. */
  readonly pixel: { readonly x: number; readonly y: number } | null;
  readonly behindCamera: boolean;
  readonly outsideClipVolume: boolean;
}

export interface SnapshotRay {
  readonly origin: SnapshotVector3;
  readonly direction: SnapshotVector3;
}

let fallbackIdSequence = 0;

function newSnapshotId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackIdSequence += 1;
  return `view-${Date.now().toString(36)}-${fallbackIdSequence.toString(36)}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function captureCamera(camera: THREE.Camera): ViewSnapshotCamera {
  const worldMatrix = Array.from(camera.matrixWorld.elements);
  const inverseWorldMatrix = Array.from(camera.matrixWorldInverse.elements);
  const projectionMatrix = Array.from(camera.projectionMatrix.elements);
  const position = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  camera.matrixWorld.decompose(position, orientation, scale);
  const projectionKind = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
    ? "perspective"
    : (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? "orthographic"
      : "unsupported";
  return {
    position: { x: position.x, y: position.y, z: position.z },
    orientation: {
      x: orientation.x,
      y: orientation.y,
      z: orientation.z,
      w: orientation.w,
    },
    worldMatrix,
    inverseWorldMatrix,
    projectionMatrix,
    projectionKind,
  };
}

/**
 * Render and synchronously freeze the exact frame into plain immutable data.
 * Three.js render is synchronous; no task or promise boundary occurs between
 * that render, copying its camera/splat matrices, and reading the canvas.
 */
export function captureViewSnapshot(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  splat: THREE.Object3D | null,
  worldGeneration: number,
): ViewSnapshot {
  if (!Number.isInteger(worldGeneration) || worldGeneration < 0) {
    throw new RangeError("worldGeneration must be a non-negative integer");
  }

  renderer.render(scene, camera);
  const canvas = renderer.domElement;
  // Capture state before reading the image; all operations remain in this
  // synchronous call stack, so no animation frame can intervene.
  const cameraState = captureCamera(camera);
  const rect = canvas.getBoundingClientRect();
  const viewport: ViewSnapshotViewport = {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    devicePixelRatio: globalThis.devicePixelRatio || 1,
  };
  const splatState = splat
    ? { matrixWorld: Array.from(splat.matrixWorld.elements) }
    : null;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
  const comma = dataUrl.indexOf(",");
  const mimeType = comma > 5 ? dataUrl.slice(5, dataUrl.indexOf(";", 5) < 0 ? comma : dataUrl.indexOf(";", 5)) : "";

  const snapshot: ViewSnapshot = {
    id: newSnapshotId(),
    worldGeneration,
    image: {
      dataUrl,
      mimeType,
      width: canvas.width,
      height: canvas.height,
    },
    camera: cameraState,
    viewport,
    splat: splatState,
  };
  validateViewSnapshot(snapshot, worldGeneration);
  return deepFreeze(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateVector(value: unknown, name: string): asserts value is SnapshotVector3 {
  if (!isRecord(value) || !finiteNumber(value.x) || !finiteNumber(value.y) || !finiteNumber(value.z)) {
    throw new TypeError(`Invalid ViewSnapshot: ${name} must contain finite x, y, and z values`);
  }
}

function validateMatrix(value: unknown, name: string): asserts value is Matrix4Record {
  if (!Array.isArray(value) || value.length !== 16 || !value.every(finiteNumber)) {
    throw new TypeError(`Invalid ViewSnapshot: ${name} must contain 16 finite values`);
  }
}

function multiplyMatrix4(a: readonly number[], b: readonly number[]): number[] {
  const result = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) result[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return result;
}

/** Validate structure, numeric integrity, and optionally the current world generation. */
export function validateViewSnapshot(
  value: unknown,
  currentWorldGeneration?: number,
): asserts value is ViewSnapshot {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new TypeError("Invalid ViewSnapshot: snapshot ID is missing");
  }
  if (!Number.isInteger(value.worldGeneration) || (value.worldGeneration as number) < 0) {
    throw new TypeError("Invalid ViewSnapshot: world generation is invalid");
  }
  if (currentWorldGeneration !== undefined && value.worldGeneration !== currentWorldGeneration) {
    throw new Error(
      `Stale ViewSnapshot: captured generation ${String(value.worldGeneration)}, current generation ${currentWorldGeneration}`,
    );
  }
  if (!isRecord(value.image) || typeof value.image.dataUrl !== "string" || !value.image.dataUrl.startsWith("data:image/")) {
    throw new TypeError("Invalid ViewSnapshot: canvas image is missing or invalid");
  }
  if (
    !finiteNumber(value.image.width) || value.image.width <= 0 ||
    !finiteNumber(value.image.height) || value.image.height <= 0 ||
    typeof value.image.mimeType !== "string" || !value.image.mimeType.startsWith("image/")
  ) {
    throw new TypeError("Invalid ViewSnapshot: image dimensions or MIME type are invalid");
  }
  if (!isRecord(value.camera)) throw new TypeError("Invalid ViewSnapshot: camera data is missing");
  validateVector(value.camera.position, "camera.position");
  validateVector(value.camera.orientation, "camera.orientation");
  const orientation = value.camera.orientation as unknown as SnapshotQuaternion;
  if (!finiteNumber(orientation.w)) throw new TypeError("Invalid ViewSnapshot: camera orientation is incomplete");
  const orientationLength = Math.hypot(orientation.x, orientation.y, orientation.z, orientation.w);
  if (Math.abs(orientationLength - 1) > 1e-3) {
    throw new TypeError("Invalid ViewSnapshot: camera orientation is not normalized");
  }
  validateMatrix(value.camera.worldMatrix, "camera.worldMatrix");
  validateMatrix(value.camera.inverseWorldMatrix, "camera.inverseWorldMatrix");
  validateMatrix(value.camera.projectionMatrix, "camera.projectionMatrix");
  if (Math.abs((value.camera.worldMatrix as number[])[12] - value.camera.position.x) > 1e-3 ||
      Math.abs((value.camera.worldMatrix as number[])[13] - value.camera.position.y) > 1e-3 ||
      Math.abs((value.camera.worldMatrix as number[])[14] - value.camera.position.z) > 1e-3) {
    throw new TypeError("Invalid ViewSnapshot: camera position disagrees with its world matrix");
  }
  if (!new Set(["perspective", "orthographic", "unsupported"]).has(String(value.camera.projectionKind))) {
    throw new TypeError("Invalid ViewSnapshot: camera projection kind is invalid");
  }
  const identity = multiplyMatrix4(value.camera.worldMatrix as number[], value.camera.inverseWorldMatrix as number[]);
  if (identity.some((component, index) => Math.abs(component - (index % 5 === 0 ? 1 : 0)) > 1e-3)) {
    throw new TypeError("Invalid ViewSnapshot: camera world and inverse matrices disagree");
  }
  if (!isRecord(value.viewport) || !isRecord(value.viewport.rect)) {
    throw new TypeError("Invalid ViewSnapshot: viewport data is missing");
  }
  for (const key of ["left", "top", "width", "height"] as const) {
    if (!finiteNumber(value.viewport.rect[key])) throw new TypeError(`Invalid ViewSnapshot: viewport rect ${key} is invalid`);
  }
  const rectWidth = value.viewport.rect.width;
  const rectHeight = value.viewport.rect.height;
  if (!finiteNumber(rectWidth) || !finiteNumber(rectHeight) || rectWidth <= 0 || rectHeight <= 0) {
    throw new TypeError("Invalid ViewSnapshot: viewport rectangle has no area");
  }
  for (const key of ["cssWidth", "cssHeight", "drawingBufferWidth", "drawingBufferHeight", "devicePixelRatio"] as const) {
    if (!finiteNumber(value.viewport[key]) || value.viewport[key] <= 0) {
      throw new TypeError(`Invalid ViewSnapshot: viewport ${key} is invalid`);
    }
  }
  if (
    value.image.width !== value.viewport.drawingBufferWidth ||
    value.image.height !== value.viewport.drawingBufferHeight
  ) {
    throw new TypeError("Invalid ViewSnapshot: image and drawing-buffer dimensions differ");
  }
  // Reject non-invertible projections during validation, before ray generation.
  invertMatrix4(value.camera.projectionMatrix as number[]);
  if (value.splat !== null) {
    if (!isRecord(value.splat)) throw new TypeError("Invalid ViewSnapshot: splat transform is invalid");
    validateMatrix(value.splat.matrixWorld, "splat.matrixWorld");
  }
}

function multiplyMatrixVector(
  matrix: readonly number[],
  vector: readonly [number, number, number, number],
): [number, number, number, number] {
  return [
    matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8] * vector[2] + matrix[12] * vector[3],
    matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9] * vector[2] + matrix[13] * vector[3],
    matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2] + matrix[14] * vector[3],
    matrix[3] * vector[0] + matrix[7] * vector[1] + matrix[11] * vector[2] + matrix[15] * vector[3],
  ];
}

/** Project a world point using only the frozen snapshot and captured generation. */
export function projectSnapshotPoint(
  snapshot: ViewSnapshot,
  point: SnapshotVector3,
  currentWorldGeneration: number,
): SnapshotProjection {
  validateViewSnapshot(snapshot, currentWorldGeneration);
  validateVector(point, "point");
  const view = multiplyMatrixVector(snapshot.camera.inverseWorldMatrix, [point.x, point.y, point.z, 1]);
  const clip = multiplyMatrixVector(snapshot.camera.projectionMatrix, view);
  const tuple: [number, number, number, number] = [clip[0], clip[1], clip[2], clip[3]];
  if (!(clip[3] > 0)) {
    return Object.freeze({
      clip: Object.freeze(tuple), ndc: null, normalized: null, pixel: null,
      behindCamera: true, outsideClipVolume: true,
    });
  }
  const ndc = { x: clip[0] / clip[3], y: clip[1] / clip[3], z: clip[2] / clip[3] };
  const normalized = { u: 0.5 + ndc.x * 0.5, v: 0.5 - ndc.y * 0.5 };
  const pixel = {
    x: snapshot.viewport.rect.left + normalized.u * snapshot.viewport.rect.width,
    y: snapshot.viewport.rect.top + normalized.v * snapshot.viewport.rect.height,
  };
  const outsideClipVolume = Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1;
  return deepFreeze({ clip: tuple, ndc, normalized, pixel, behindCamera: false, outsideClipVolume });
}

function invertMatrix4(matrix: readonly number[]): number[] {
  const rows = Array.from({ length: 4 }, (_, row) => [
    ...Array.from({ length: 4 }, (_, col) => matrix[col * 4 + row]),
    ...Array.from({ length: 4 }, (_, col) => Number(row === col)),
  ]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-15) throw new TypeError("Invalid ViewSnapshot: projection matrix is singular");
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    for (let j = 0; j < 8; j++) rows[col][j] /= divisor;
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = rows[row][col];
      for (let j = 0; j < 8; j++) rows[row][j] -= factor * rows[col][j];
    }
  }
  return Array.from({ length: 16 }, (_, index) => rows[index % 4][4 + Math.floor(index / 4)]);
}

function unproject(
  inverseProjection: readonly number[],
  worldMatrix: readonly number[],
  x: number,
  y: number,
  z: number,
): SnapshotVector3 {
  const cameraPoint = multiplyMatrixVector(inverseProjection, [x, y, z, 1]);
  if (Math.abs(cameraPoint[3]) < 1e-15) throw new TypeError("Invalid ViewSnapshot: screen point unprojects to infinity");
  const worldPoint = multiplyMatrixVector(worldMatrix, [
    cameraPoint[0] / cameraPoint[3], cameraPoint[1] / cameraPoint[3], cameraPoint[2] / cameraPoint[3], 1,
  ]);
  if (Math.abs(worldPoint[3]) < 1e-15) throw new TypeError("Invalid ViewSnapshot: world point is at infinity");
  return { x: worldPoint[0] / worldPoint[3], y: worldPoint[1] / worldPoint[3], z: worldPoint[2] / worldPoint[3] };
}

/** Generate a unit world-space ray using only the frozen camera matrices. */
export function generateSnapshotRay(
  snapshot: ViewSnapshot,
  normalizedX: number,
  normalizedY: number,
  currentWorldGeneration: number,
): SnapshotRay {
  validateViewSnapshot(snapshot, currentWorldGeneration);
  if (!finiteNumber(normalizedX) || !finiteNumber(normalizedY) || normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
    throw new RangeError("normalized screen coordinates must be finite values between 0 and 1");
  }
  if (snapshot.camera.projectionKind === "unsupported") {
    throw new TypeError("ViewSnapshot ray generation requires a perspective or orthographic camera");
  }
  const ndcX = normalizedX * 2 - 1;
  const ndcY = 1 - normalizedY * 2;
  const inverseProjection = invertMatrix4(snapshot.camera.projectionMatrix);
  const near = unproject(inverseProjection, snapshot.camera.worldMatrix, ndcX, ndcY, -1);
  const far = unproject(inverseProjection, snapshot.camera.worldMatrix, ndcX, ndcY, 1);
  const origin = snapshot.camera.projectionKind === "perspective" ? snapshot.camera.position : near;
  const vector = snapshot.camera.projectionKind === "perspective"
    ? { x: near.x - origin.x, y: near.y - origin.y, z: near.z - origin.z }
    : { x: far.x - near.x, y: far.y - near.y, z: far.z - near.z };
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!(length > 0) || !Number.isFinite(length)) throw new TypeError("Invalid ViewSnapshot: generated ray direction is invalid");
  return deepFreeze({
    origin: { ...origin },
    direction: { x: vector.x / length, y: vector.y / length, z: vector.z / length },
  });
}
