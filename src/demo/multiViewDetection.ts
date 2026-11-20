import { Matrix4, Quaternion, Vector3 } from "three";
import type { CaptureSlotId, PresentationCapture } from "./presentationCaptures.ts";
import type { ViewSnapshot } from "../viewer/ViewSnapshot.ts";

export interface NormalizedDetectionBox {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
}

export interface MultiViewObservation {
  readonly view: CaptureSlotId;
  readonly visible: boolean;
  readonly box: NormalizedDetectionBox | null;
}

export interface MultiViewObjectDetection {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly observations: readonly MultiViewObservation[];
}

export interface SelectedMultiViewObject {
  readonly objectId: string;
  readonly label: string;
  readonly description: string;
  readonly observations: readonly MultiViewObservation[];
  /** Other detections from the same response, retained for geometric ownership checks. */
  readonly peerDetections: readonly MultiViewObjectDetection[];
  /** Original snapshots retain their images, dimensions, camera and scene metadata. */
  readonly captures: readonly PresentationCapture[];
  readonly confirmedAtIso: string;
}

const views = new Set<CaptureSlotId>(["front", "side", "top"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseBox(value: unknown): NormalizedDetectionBox | null {
  if (!isRecord(value) || !isUnit(value.xMin) || !isUnit(value.yMin) || !isUnit(value.xMax) || !isUnit(value.yMax)) return null;
  if (value.xMin >= value.xMax || value.yMin >= value.yMax) return null;
  return Object.freeze({ xMin: value.xMin, yMin: value.yMin, xMax: value.xMax, yMax: value.yMax });
}

/**
 * Validate the backend response without repairing malformed detections.
 * Boxes use normalized top-left image coordinates: x grows right and y grows down.
 */
export function parseMultiViewDetectionResponse(value: unknown): readonly MultiViewObjectDetection[] {
  if (!isRecord(value) || !Array.isArray(value.objects)) throw new TypeError("Gemini response must contain an objects array");
  const ids = new Set<string>();
  return Object.freeze(value.objects.map((entry, objectIndex) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() ||
        typeof entry.label !== "string" || !entry.label.trim() ||
        typeof entry.description !== "string" || !entry.description.trim() ||
        !Array.isArray(entry.observations)) {
      throw new TypeError(`Gemini object ${objectIndex + 1} is malformed`);
    }
    if (ids.has(entry.id)) throw new TypeError(`Gemini returned duplicate object id: ${entry.id}`);
    ids.add(entry.id);
    const seenViews = new Set<string>();
    const observations = entry.observations.map((item, observationIndex) => {
      if (!isRecord(item) || typeof item.view !== "string" || !views.has(item.view as CaptureSlotId) ||
          typeof item.visible !== "boolean" || seenViews.has(item.view)) {
        throw new TypeError(`Gemini object ${entry.id} has an invalid observation at index ${observationIndex}`);
      }
      seenViews.add(item.view);
      if (!item.visible) {
        if (item.box !== null) throw new TypeError(`Gemini object ${entry.id} has a box for an invisible observation`);
        return Object.freeze({ view: item.view as CaptureSlotId, visible: false, box: null });
      }
      const box = parseBox(item.box);
      if (!box) throw new TypeError(`Gemini object ${entry.id} has an invalid ${item.view} bounding box`);
      return Object.freeze({ view: item.view as CaptureSlotId, visible: true, box });
    });
    if (observations.length < 1 || observations.length > 3) throw new TypeError(`Gemini object ${entry.id} must have one to three observations`);
    if (!observations.some((observation) => observation.visible)) throw new TypeError(`Gemini object ${entry.id} has no visible detection`);
    return Object.freeze({ id: entry.id, label: entry.label.trim(), description: entry.description.trim(), observations: Object.freeze(observations) });
  }));
}

/** CSS percentages relative to an uncropped image element's own box. */
export function detectionBoxStyle(box: NormalizedDetectionBox): Pick<CSSStyleDeclaration, "left" | "top" | "width" | "height"> {
  return {
    left: `${box.xMin * 100}%`,
    top: `${box.yMin * 100}%`,
    width: `${(box.xMax - box.xMin) * 100}%`,
    height: `${(box.yMax - box.yMin) * 100}%`,
  };
}

export function observationForView(object: MultiViewObjectDetection, view: CaptureSlotId): MultiViewObservation | null {
  return object.observations.find((observation) => observation.view === view) ?? null;
}

/** Serialized request budget; Netlify's buffered ingress limit is 6 MB, so keep a safety margin. */
export const MULTI_VIEW_BODY_BUDGET_BYTES = 4_800_000;
const REQUEST_JPEG_QUALITIES = [0.85, 0.75, 0.65] as const;
const REQUEST_SCALES = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25] as const;
const MIN_REQUEST_LONG_SIDE = 160;

type Vec3Tuple = readonly [number, number, number];
type QuatTuple = readonly [number, number, number, number];

/**
 * Concise camera grounding for one view. World space is the viewer's Three.js space
 * (right-handed, +Y up, camera looks along local -Z). `orientation` is the camera-to-world
 * quaternion [x, y, z, w]; `splat` is the splat-local to world transform, decomposed.
 */
export interface MultiViewCameraPayload {
  readonly position: Vec3Tuple;
  readonly orientation: QuatTuple;
  readonly projection: {
    readonly kind: "perspective" | "orthographic" | "unsupported";
    readonly fovYDegrees?: number;
    readonly aspect?: number;
    readonly width?: number;
    readonly height?: number;
    readonly near?: number;
    readonly far?: number;
  };
  readonly splat: { readonly position: Vec3Tuple; readonly orientation: QuatTuple; readonly scale: Vec3Tuple } | null;
}

export interface MultiViewDetectionRequest {
  readonly views: readonly {
    readonly view: CaptureSlotId;
    readonly captureId: string;
    readonly capturedAt: string;
    readonly snapshotId: string;
    /** Dimensions of `image` (the bounded request copy); aspect ratio equals the original snapshot's. */
    readonly imageWidth: number;
    readonly imageHeight: number;
    readonly image: string;
    readonly camera?: MultiViewCameraPayload;
  }[];
}

export interface RequestImage {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** A decoded source image that can be re-encoded repeatedly at different sizes/qualities. */
export interface DecodedRequestImage {
  encodeJpeg(width: number, height: number, quality: number): string;
  dispose(): void;
}

export interface MultiViewFetchDeps {
  readonly fetch: typeof fetch;
  /** Decode a snapshot data URL for re-encoding. Defaults to a browser canvas loader; null when unavailable. */
  readonly loadImage?: ((dataUrl: string) => Promise<DecodedRequestImage>) | null;
  /** Structured telemetry sink; defaults to console.info. Never receives base64 image data. */
  readonly log?: (message: string, details: Record<string, unknown>) => void;
}

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const finitePositive = (n: number) => Number.isFinite(n) && n > 0;

function cameraProjection(snapshot: ViewSnapshot): MultiViewCameraPayload["projection"] {
  const kind = snapshot.camera.projectionKind;
  const m = snapshot.camera.projectionMatrix;
  if (m.length !== 16 || !m.every(Number.isFinite)) return { kind };
  if (kind === "perspective" && finitePositive(m[0]) && finitePositive(m[5]) && Math.abs(m[11] + 1) < 1e-6) {
    const near = m[14] / (m[10] - 1);
    const far = m[14] / (m[10] + 1);
    return {
      kind,
      fovYDegrees: round((2 * Math.atan(1 / m[5]) * 180) / Math.PI, 3),
      aspect: round(m[5] / m[0]),
      ...(finitePositive(near) ? { near: round(near) } : {}),
      ...(finitePositive(far) ? { far: round(far) } : {}),
    };
  }
  if (kind === "orthographic" && finitePositive(Math.abs(m[0])) && finitePositive(Math.abs(m[5])) && m[10] !== 0) {
    const near = (m[14] + 1) / m[10];
    const far = (m[14] - 1) / m[10];
    return {
      kind,
      width: round(2 / m[0]),
      height: round(2 / m[5]),
      ...(Number.isFinite(near) ? { near: round(near) } : {}),
      ...(Number.isFinite(far) ? { far: round(far) } : {}),
    };
  }
  return { kind };
}

/** Compact, finite-number camera metadata for the backend; never includes raw 16-float matrices. */
export function buildCameraPayload(snapshot: ViewSnapshot): MultiViewCameraPayload {
  let splat: MultiViewCameraPayload["splat"] = null;
  const matrix = snapshot.splat?.matrixWorld;
  if (matrix && matrix.length === 16 && matrix.every(Number.isFinite)) {
    const position = new Vector3();
    const orientation = new Quaternion();
    const scale = new Vector3();
    new Matrix4().fromArray(matrix as number[]).decompose(position, orientation, scale);
    splat = {
      position: [round(position.x), round(position.y), round(position.z)],
      orientation: [round(orientation.x, 5), round(orientation.y, 5), round(orientation.z, 5), round(orientation.w, 5)],
      scale: [round(scale.x), round(scale.y), round(scale.z)],
    };
  }
  const { position, orientation } = snapshot.camera;
  return {
    position: [round(position.x), round(position.y), round(position.z)],
    orientation: [round(orientation.x, 5), round(orientation.y, 5), round(orientation.z, 5), round(orientation.w, 5)],
    projection: cameraProjection(snapshot),
    splat,
  };
}

function describeDataUrl(dataUrl: string): { mimeType: string; base64Chars: number; decodedImageBytes: number } {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/.exec(dataUrl);
  const payload = dataUrl.slice(match ? match[0].length : 0);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return {
    mimeType: match?.[1] ?? "unknown",
    base64Chars: payload.length,
    decodedImageBytes: Math.max(0, Math.floor((payload.length * 3) / 4) - padding),
  };
}

function buildBody(captures: readonly PresentationCapture[], images: readonly RequestImage[]): MultiViewDetectionRequest {
  return {
    views: captures.map((capture, index) => ({
      view: capture.slot,
      captureId: capture.id,
      capturedAt: capture.capturedAtIso,
      snapshotId: capture.snapshot.id,
      imageWidth: images[index].width,
      imageHeight: images[index].height,
      image: images[index].dataUrl,
      camera: buildCameraPayload(capture.snapshot),
    })),
  };
}

const bodyBytes = (body: MultiViewDetectionRequest) => new TextEncoder().encode(JSON.stringify(body)).byteLength;
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(2);

/** Browser loader: decodes with an <img> and re-encodes through a reused canvas. Null outside a DOM. */
function browserImageLoader(): ((dataUrl: string) => Promise<DecodedRequestImage>) | null {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  return async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement("canvas");
    return {
      encodeJpeg(width, height, quality) {
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Cannot re-encode snapshot for Gemini: 2D canvas is unavailable");
        context.imageSmoothingQuality = "high";
        context.drawImage(img, 0, 0, width, height);
        return canvas.toDataURL("image/jpeg", quality);
      },
      dispose() { canvas.width = canvas.height = 0; },
    };
  };
}

/**
 * Build the request body from bounded JPEG copies of the snapshots (the originals are untouched).
 * Starts at the original size and quality 0.85, then steps quality down before shrinking
 * resolution (aspect preserved, so normalized boxes stay valid) until the serialized JSON fits.
 */
export async function buildBudgetedMultiViewBody(
  captures: readonly PresentationCapture[],
  deps: Pick<MultiViewFetchDeps, "loadImage">,
  budgetBytes = MULTI_VIEW_BODY_BUDGET_BYTES,
): Promise<{ body: MultiViewDetectionRequest; bodyBytes: number; jpegQuality: number | null; scale: number }> {
  const loader = deps.loadImage === undefined ? browserImageLoader() : deps.loadImage;
  if (!loader) {
    // No canvas available (non-browser): the originals are the only images we have.
    const body = buildBody(captures, captures.map((c) => ({ dataUrl: c.snapshot.image.dataUrl, width: c.snapshot.image.width, height: c.snapshot.image.height })));
    const bytes = bodyBytes(body);
    if (bytes > budgetBytes) throw new Error(`Multi-view request is ${megabytes(bytes)} MB, over the ${megabytes(budgetBytes)} MB limit, and images cannot be re-encoded in this environment`);
    return { body, bodyBytes: bytes, jpegQuality: null, scale: 1 };
  }
  const decoded: DecodedRequestImage[] = [];
  try {
    for (const capture of captures) decoded.push(await loader(capture.snapshot.image.dataUrl));
    let smallest = 0;
    let last = { width: 0, height: 0, quality: REQUEST_JPEG_QUALITIES[0] as number };
    for (const scale of REQUEST_SCALES) {
      const sizes = captures.map(({ snapshot }) => ({
        width: Math.max(1, Math.round(snapshot.image.width * scale)),
        height: Math.max(1, Math.round(snapshot.image.height * scale)),
      }));
      if (scale < 1 && Math.max(...sizes.map((size) => Math.max(size.width, size.height))) < MIN_REQUEST_LONG_SIDE) break;
      for (const quality of REQUEST_JPEG_QUALITIES) {
        const images = decoded.map((image, index) => ({ ...sizes[index], dataUrl: image.encodeJpeg(sizes[index].width, sizes[index].height, quality) }));
        const body = buildBody(captures, images);
        const bytes = bodyBytes(body);
        if (bytes <= budgetBytes) return { body, bodyBytes: bytes, jpegQuality: quality, scale };
        smallest = bytes;
        last = { ...sizes[0], quality };
      }
    }
    throw new Error(
      `Multi-view request is still ${megabytes(smallest)} MB after downscaling to ${last.width}x${last.height} at JPEG quality ${last.quality}; ` +
      `the limit is ${megabytes(budgetBytes)} MB. Capture the views in a smaller viewport and retry.`,
    );
  } finally {
    for (const image of decoded) image.dispose();
  }
}

export interface MultiViewWorkflowState {
  readonly detections: readonly MultiViewObjectDetection[];
  readonly detectionResultAvailable: boolean;
  readonly detectionLoading: boolean;
  readonly detectionError: string;
  readonly reviewOpen: boolean;
  readonly selectedObjectId: string | null;
  readonly selectedObject: SelectedMultiViewObject | null;
  readonly selectionConfirmed: boolean;
}

/** Small state machine for retry, review, and the explicit downstream handoff. */
export class MultiViewDetectionWorkflow {
  private detections: readonly MultiViewObjectDetection[] = [];
  private detectionResultAvailable = false;
  private detectionLoading = false;
  private detectionError = "";
  private reviewOpen = false;
  private selectedObjectId: string | null = null;
  private selectedObject: SelectedMultiViewObject | null = null;
  private selectionConfirmed = false;
  private requestSequence = 0;
  private activeRequest = 0;

  state(): MultiViewWorkflowState {
    return {
      detections: this.detections,
      detectionResultAvailable: this.detectionResultAvailable,
      detectionLoading: this.detectionLoading,
      detectionError: this.detectionError,
      reviewOpen: this.reviewOpen,
      selectedObjectId: this.selectedObjectId,
      selectedObject: this.selectedObject,
      selectionConfirmed: this.selectionConfirmed,
    };
  }

  canSend(captures: readonly (PresentationCapture | null)[]): boolean {
    return captures.length === 3 && captures.every((capture, index) => capture?.slot === (["front", "side", "top"] as const)[index]);
  }

  beginRequest(): number | null {
    if (this.detectionLoading) return null;
    this.detectionLoading = true;
    this.detectionError = "";
    this.reviewOpen = false;
    this.selectedObjectId = null;
    this.selectedObject = null;
    this.selectionConfirmed = false;
    this.activeRequest = ++this.requestSequence;
    return this.activeRequest;
  }

  resolveRequest(requestId: number, detections: readonly MultiViewObjectDetection[]): boolean {
    if (!this.detectionLoading || requestId !== this.activeRequest) return false;
    this.detections = detections;
    this.detectionResultAvailable = true;
    this.detectionLoading = false;
    this.reviewOpen = true;
    return true;
  }

  rejectRequest(requestId: number, error: string): boolean {
    if (!this.detectionLoading || requestId !== this.activeRequest) return false;
    this.detectionLoading = false;
    this.detectionError = error;
    this.reviewOpen = false;
    return true;
  }

  showError(error: string): void {
    this.detectionError = error;
  }

  invalidate(): void {
    this.activeRequest = ++this.requestSequence;
    this.detections = [];
    this.detectionResultAvailable = false;
    this.detectionLoading = false;
    this.detectionError = "";
    this.reviewOpen = false;
    this.selectedObjectId = null;
    this.selectedObject = null;
    this.selectionConfirmed = false;
  }

  select(id: string): boolean {
    if (!this.detections.some((object) => object.id === id)) return false;
    this.selectedObjectId = id;
    this.selectedObject = null;
    this.selectionConfirmed = false;
    return true;
  }

  /** Let the user retry after a failed or cancelled downstream placement. */
  cancelConfirmation(): void {
    this.selectedObject = null;
    this.selectionConfirmed = false;
  }

  confirm(captures: readonly (PresentationCapture | null)[], confirmedAtIso = new Date().toISOString()): SelectedMultiViewObject | null {
    if (!this.canSend(captures)) return null;
    const object = this.detections.find((entry) => entry.id === this.selectedObjectId);
    if (!object) return null;
    const retainedCaptures = captures as readonly PresentationCapture[];
    this.selectedObject = Object.freeze({
      objectId: object.id,
      label: object.label,
      description: object.description,
      observations: object.observations,
      peerDetections: Object.freeze(this.detections.filter((entry) => entry.id !== object.id)),
      captures: Object.freeze([...retainedCaptures]),
      confirmedAtIso,
    });
    this.selectionConfirmed = true;
    return this.selectedObject;
  }

  closeReview(): void {
    this.reviewOpen = false;
  }

  openReview(): void {
    if (this.detectionResultAvailable) this.reviewOpen = true;
  }
}

export async function requestMultiViewDetections(
  endpoint: string,
  captures: readonly PresentationCapture[],
  headers: Readonly<Record<string, string>>,
  deps: MultiViewFetchDeps,
): Promise<readonly MultiViewObjectDetection[]> {
  const expected: readonly CaptureSlotId[] = ["front", "side", "top"];
  if (captures.length !== 3 || expected.some((view, index) => captures[index]?.slot !== view)) {
    throw new TypeError("Capture Front, Side and Top before sending to Gemini");
  }
  const budgeted = await buildBudgetedMultiViewBody(captures, deps);
  const body = budgeted.body;
  (deps.log ?? ((message, details) => console.info(message, details)))("[multiview] request", {
    endpoint,
    bodyBytes: budgeted.bodyBytes,
    budgetBytes: MULTI_VIEW_BODY_BUDGET_BYTES,
    jpegQuality: budgeted.jpegQuality,
    scale: budgeted.scale,
    order: body.views.map((view) => view.view),
    views: body.views.map((view) => ({ view: view.view, width: view.imageWidth, height: view.imageHeight, ...describeDataUrl(view.image) })),
  });
  const response = await deps.fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `Gemini request failed (${response.status})`;
    throw new Error(message);
  }
  return parseMultiViewDetectionResponse(data);
}
