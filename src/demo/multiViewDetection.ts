import type { CaptureSlotId, PresentationCapture } from "./presentationCaptures.ts";

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

export interface MultiViewDetectionRequest {
  readonly views: readonly {
    readonly view: CaptureSlotId;
    readonly captureId: string;
    readonly capturedAt: string;
    readonly snapshotId: string;
    readonly imageWidth: number;
    readonly imageHeight: number;
    readonly image: string;
  }[];
}

export interface MultiViewFetchDeps {
  readonly fetch: typeof fetch;
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
  const body: MultiViewDetectionRequest = {
    views: captures.map((capture) => ({
      view: capture.slot,
      captureId: capture.id,
      capturedAt: capture.capturedAtIso,
      snapshotId: capture.snapshot.id,
      imageWidth: capture.snapshot.image.width,
      imageHeight: capture.snapshot.image.height,
      image: capture.snapshot.image.dataUrl,
    })),
  };
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
