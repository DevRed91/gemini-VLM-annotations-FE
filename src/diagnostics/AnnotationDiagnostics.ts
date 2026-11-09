import * as THREE from "three";
import type { DBSCANClusterReport } from "../GeometricContextManager/GeometricContextManager.ts";
import type { MeasuredObjectCluster } from "../GeometricContextManager/GeometricContextManager.ts";
import type { OBBFitResult } from "../utils/obbFit.ts";
import type { GaussianObjectSelectionResult } from "../utils/gaussianObjectHighlighter.ts";
import { DiagnosticOverlay } from "./overlay.ts";
import {
  buildDetectionGroup,
  buildRequestGroup,
  disposeObjectTree,
} from "./markers.ts";
import {
  applyAnchor,
  applyClustering,
  applyFailure,
  applyLift,
  applyMeasurement,
  applyObb,
  applySampling,
  applySanitize,
  createDetectionDiagnostics,
  summarizeDetection,
  vec3,
  type SampleCellProbe,
} from "./records.ts";
import {
  buildValidationReport,
  captureCameraState,
  captureSplatTransform,
  captureSnapshot,
  captureViewport,
  validateClickReprojection,
  validateSampleReprojections,
  type ClickValidationResult,
  type LiveCapture,
  type SamplesValidationResult,
  type ValidationReport,
} from "./coordinateValidation.ts";
import { CoordinateValidationPanel } from "./validationPanel.ts";
import type {
  AnchorSource,
  AnnotationRequestDiagnostics,
  DetectionDiagnostics,
  NormalizedBox,
  RequestClickRecord,
} from "./types.ts";
import { clusterColors } from "./clusterPalette.ts";

/** Raw click data handed over by the viewer at click time. */
export interface ClickProbe {
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly cameraPosition: THREE.Vector3;
  readonly cameraQuaternion: THREE.Quaternion;
  /** Null when no splat is loaded. */
  readonly ray: THREE.Ray | null;
  readonly intersection: THREE.Intersection | null;
}

/** Keep at most this many full request records (data) in memory. */
const MAX_RECORDS = 20;
/** Keep at most this many visualization groups (3D) alive. */
const MAX_LIVE_GROUPS = 12;

/**
 * Development-only annotation-pipeline diagnostics (Task 1 instrumentation).
 *
 * The viewer only constructs this when `import.meta.env.DEV` is true; every
 * production build sees a null reference and skips all calls. Records are the
 * single source of truth; the 3D group and 2D overlay are rebuilt from them
 * after each pipeline stage, so a failure mid-pipeline still shows the stages
 * that ran. Nothing here feeds back into the annotation pipeline.
 */
export class AnnotationDiagnostics {
  private readonly root = new THREE.Group();
  private readonly overlay = new DiagnosticOverlay();
  private readonly groups = new Map<string, THREE.Group>();
  private requests: AnnotationRequestDiagnostics[] = [];
  private requestCounter = 0;
  private currentRequest: AnnotationRequestDiagnostics | null = null;
  private pendingClick: RequestClickRecord | null = null;
  /** Requests created under the current world; invalidated on world clear. */
  private liveRequests = new WeakSet<AnnotationRequestDiagnostics>();
  private enabled = true;
  private overlayVisible = true;
  /**
   * Task 2.1C: live viewer references used to freeze full camera/viewport
   * state at click time and to capture validation-time state. Null only in
   * headless/legacy constructions; validation then reports the limitation.
   */
  private readonly camera: THREE.Camera | null;
  private readonly canvas: HTMLCanvasElement | null;
  private splat: THREE.Object3D | null = null;
  private readonly validationPanel: CoordinateValidationPanel | null;
  private keyboardHandler: (event: KeyboardEvent) => void = () => {};

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera | null = null,
    canvas: HTMLCanvasElement | null = null,
  ) {
    this.root.name = "annotation-diagnostics";
    scene.add(this.root);
    this.camera = camera;
    this.canvas = canvas;
    this.attachKeyboard();
    // The panel needs live captures; without camera+canvas it stays absent
    // and the console validation API reports the missing snapshot instead.
    this.validationPanel =
      camera && canvas && typeof document !== "undefined"
        ? new CoordinateValidationPanel(this)
        : null;
  }

  // ------------------------------------------------------------------
  // Request lifecycle
  // ------------------------------------------------------------------

  /** Store the click for the next request; camera pose is frozen at click time. */
  recordClick(probe: ClickProbe): void {
    this.pendingClick = {
      normalizedX: probe.normalizedX,
      normalizedY: probe.normalizedY,
      clientX: probe.clientX,
      clientY: probe.clientY,
      cameraPosition: vec3(probe.cameraPosition),
      cameraQuaternion: {
        x: probe.cameraQuaternion.x,
        y: probe.cameraQuaternion.y,
        z: probe.cameraQuaternion.z,
        w: probe.cameraQuaternion.w,
      },
      rayOrigin: probe.ray ? vec3(probe.ray.origin) : null,
      rayDirection: probe.ray ? vec3(probe.ray.direction) : null,
      hit: probe.intersection
        ? { position: vec3(probe.intersection.point), distance: probe.intersection.distance }
        : null,
      // Task 2.1C: freeze the full click-time camera/viewport/splat state.
      // Captured synchronously here, in the same event turn as the click
      // probe, and never overwritten afterwards.
      cameraSnapshot:
        this.camera && this.canvas
          ? captureSnapshot(this.camera, this.canvas, this.splat)
          : null,
    };
  }

  /** Track the current splat so click snapshots can freeze its world transform. */
  setSplat(splat: THREE.Object3D | null): void {
    this.splat = splat;
  }

  /** Begin a request (one click → one Gemini call → N detections). */
  beginRequest(source: "click" | "inject", worldGeneration: number): void {
    const click = source === "click" ? this.pendingClick : null;
    this.pendingClick = null;
    const request: AnnotationRequestDiagnostics = {
      index: ++this.requestCounter,
      startedAt: new Date().toISOString(),
      source,
      worldGeneration,
      click,
      snapshotDataUrl: null,
      response: null,
      detections: [],
    };
    this.requests.push(request);
    this.liveRequests.add(request);
    // Bound memory: drop the oldest full records and all old snapshots.
    while (this.requests.length > MAX_RECORDS) this.requests.shift();
    for (const previous of this.requests) previous.snapshotDataUrl = null;
    this.currentRequest = request;
  }

  /** Attach the captured frame (data URL) to the current request. */
  recordSnapshot(dataUrl: string): void {
    if (this.currentRequest) this.currentRequest.snapshotDataUrl = dataUrl;
  }

  /** Attach the raw parsed /api/annotate response body. */
  recordResponse(response: unknown): void {
    if (this.currentRequest) this.currentRequest.response = response;
  }

  /** Close the current click-request; inject-requests close per detection. */
  closeRequest(): void {
    this.currentRequest = null;
  }

  // ------------------------------------------------------------------
  // Detection lifecycle
  // ------------------------------------------------------------------

  beginDetection(detection: { label: string; box: unknown }): DetectionRecorder {
    if (!this.currentRequest) {
      // Deterministic dev seam (`__sl.inject`) path: synthesize a request.
      this.beginRequest("inject", -1);
    }
    const request = this.currentRequest!;
    const record = createDetectionDiagnostics(detection);
    request.detections.push(record);
    return new DetectionRecorder(this, request, record, request.detections.length - 1);
  }

  /** Final per-detection hook: logs the structured summary and closes inject requests. */
  endDetection(recorder: DetectionRecorder): void {
    if (!this.isLive(recorder)) return;
    console.info(
      `[annotation-diagnostics]\n${summarizeDetection(recorder.request, recorder.record)}`,
    );
    if (recorder.ownsRequest) {
      this.currentRequest = null;
    }
    this.refresh(recorder.request);
  }

  isLive(recorder: DetectionRecorder): boolean {
    return this.liveRequests.has(recorder.request);
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  /** Remove the 3D visualization of one annotation (data records are kept). */
  detachAnnotation(annotationId: string): void {
    for (const [key, group] of [...this.groups]) {
      if (group.name === `annotation-diagnostics:${annotationId}`) {
        disposeObjectTree(group);
        this.groups.delete(key);
      }
    }
  }

  /** Drop everything: records, visuals, overlay. Called on world clear. */
  clear(): void {
    for (const group of this.groups.values()) disposeObjectTree(group);
    this.groups.clear();
    this.requests = [];
    this.liveRequests = new WeakSet();
    this.currentRequest = null;
    this.pendingClick = null;
    this.overlay.clear();
    this.validationPanel?.onRecordsChanged();
  }

  /** Release every listener and DOM node (dev page teardown). */
  dispose(): void {
    window.removeEventListener("keydown", this.keyboardHandler);
    this.validationPanel?.dispose();
    this.clear();
  }

  // ------------------------------------------------------------------
  // Controls (dev keyboard + `__sl` seam)
  // ------------------------------------------------------------------

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isOverlayVisible(): boolean {
    return this.overlayVisible;
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyVisibility();
  }

  toggleOverlay(): boolean {
    this.setOverlayVisible(!this.overlayVisible);
    return this.overlayVisible;
  }

  setOverlayVisible(visible: boolean): void {
    this.overlayVisible = visible;
    this.applyVisibility();
  }

  // ------------------------------------------------------------------
  // Data access
  // ------------------------------------------------------------------

  list(): AnnotationRequestDiagnostics[] {
    return [...this.requests];
  }

  last(): AnnotationRequestDiagnostics | null {
    return this.requests[this.requests.length - 1] ?? null;
  }

  /** Number of live 3D visualization groups (request + detection groups). */
  get liveGroupCount(): number {
    return this.groups.size;
  }

  /** Total diagnostic objects currently in the scene. */
  get visualObjectCount(): number {
    let count = 0;
    this.root.traverse((child) => {
      if (child !== this.root) count++;
    });
    return count;
  }

  get overlayCanvasId(): string {
    return this.overlay.canvas.id;
  }

  get overlayHasContent(): boolean {
    return this.overlay.hasRenderedContent;
  }

  /** Palette probe: the first `count` cluster colours (distinct by design). */
  clusterColors(count: number): number[] {
    return clusterColors(count);
  }

  // ------------------------------------------------------------------
  // Coordinate validation (Task 2.1C, Feature F console API)
  // ------------------------------------------------------------------

  /**
   * Freeze the current (validation-time) camera/viewport/splat state. Used
   * for the click-vs-now comparison and for the report; never written back
   * into any click record.
   */
  captureLiveState(): LiveCapture | null {
    if (!this.camera || !this.canvas) return null;
    return {
      capturedAt: new Date().toISOString(),
      camera: captureCameraState(this.camera),
      viewport: captureViewport(this.canvas),
      splat: captureSplatTransform(this.splat),
    };
  }

  /** Replay the click-hit reprojection of one request through its click-time camera. */
  validateReprojection(requestIndex?: number): ClickValidationResult {
    const request = this.resolveRequest(requestIndex);
    if (!request) {
      return {
        requestIndex: requestIndex ?? -1,
        status: "unavailable",
        reason: "no diagnostic request with that index",
        cameraSource: null,
        original: null,
        hit: null,
        rayConsistency: null,
        projected: null,
        errors: null,
        spaceHypothesis: null,
      };
    }
    return validateClickReprojection(request);
  }

  /** Reproject every valid sampling hit of one request through its click-time camera. */
  validateSamples(requestIndex?: number, detectionIndex?: number): SamplesValidationResult {
    const request = this.resolveRequest(requestIndex);
    if (!request) {
      return {
        requestIndex: requestIndex ?? -1,
        cameraSource: null,
        status: "unavailable",
        reason: "no diagnostic request with that index",
        totalCells: 0,
        hitCells: 0,
        missCells: 0,
        projectedCells: 0,
        behindCameraCells: 0,
        cameraUnavailableCells: 0,
        rayInconsistentCells: 0,
        normalizedErrorStats: null,
        pixelErrorStats: null,
        rows: [],
      };
    }
    return validateSampleReprojections(request, { detectionIndex });
  }

  /** Full JSON-serializable validation report (console: exportValidation()). */
  exportValidation(requestIndex?: number): ValidationReport | null {
    const request = this.resolveRequest(requestIndex);
    if (!request) return null;
    return buildValidationReport(request, this.captureLiveState());
  }

  /** Show/hide the Coordinate Validation Panel (also bound to the V key). */
  toggleValidationPanel(): boolean {
    if (!this.validationPanel) {
      console.warn("[annotation-diagnostics] validation panel unavailable (no camera/canvas)");
      return false;
    }
    return this.validationPanel.toggle();
  }

  private resolveRequest(requestIndex?: number): AnnotationRequestDiagnostics | null {
    if (requestIndex !== undefined) {
      return this.requests.find((request) => request.index === requestIndex) ?? null;
    }
    return this.last();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private attachKeyboard(): void {
    this.keyboardHandler = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "d") {
        this.toggle();
      } else if (key === "o") {
        this.toggleOverlay();
      } else if (key === "v") {
        this.toggleValidationPanel();
      }
    };
    window.addEventListener("keydown", this.keyboardHandler);
  }

  private applyVisibility(): void {
    this.root.visible = this.enabled;
    this.overlay.setVisible(this.enabled && this.overlayVisible);
  }

  private groupKey(request: AnnotationRequestDiagnostics, detectionIndex: number | null): string {
    return detectionIndex === null
      ? `req:#${request.index}`
      : `det:#${request.index}:${detectionIndex}`;
  }

  private replaceGroup(key: string, group: THREE.Group | null): void {
    const existing = this.groups.get(key);
    if (existing) {
      disposeObjectTree(existing);
      this.groups.delete(key);
    }
    if (!group) return;
    this.groups.set(key, group);
    group.visible = this.enabled;
    this.root.add(group);
    // Bound live groups; evict the oldest.
    while (this.groups.size > MAX_LIVE_GROUPS) {
      const [oldestKey, oldestGroup] = this.groups.entries().next().value!;
      disposeObjectTree(oldestGroup);
      this.groups.delete(oldestKey);
    }
  }

  /**
   * Rebuild the visualization for one request from its records. Called after
   * each pipeline stage (via DetectionRecorder) and when a detection ends.
   */
  refresh(request: AnnotationRequestDiagnostics): void {
    try {
      const clickGroup = buildRequestGroup(request);
      this.replaceGroup(this.groupKey(request, null), clickGroup);
      request.detections.forEach((record, index) => {
        this.replaceGroup(this.groupKey(request, index), buildDetectionGroup(record));
      });
    } catch (error) {
      console.error("[annotation-diagnostics] failed to rebuild 3D visualization:", error);
    }
    try {
      void this.overlay.render(request).catch((error: unknown) => {
        console.error("[annotation-diagnostics] failed to render overlay:", error);
      });
    } catch (error) {
      console.error("[annotation-diagnostics] failed to render overlay:", error);
    }
  }
}

/**
 * Stage recorder for one detection. Handed to the viewer, which reports each
 * pipeline stage as it runs. All methods are safe to call after the world has
 * been cleared: stale recorders become no-ops.
 */
export class DetectionRecorder {
  readonly ownsRequest: boolean;

  constructor(
    private readonly owner: AnnotationDiagnostics,
    readonly request: AnnotationRequestDiagnostics,
    readonly record: DetectionDiagnostics,
    readonly detectionIndex: number,
  ) {
    // Auto-created (inject) requests are closed when this detection ends.
    this.ownsRequest = request.source === "inject" && request.detections.length === 1;
  }

  sanitize(sanitizedBox: NormalizedBox | null): void {
    if (!this.owner.isLive(this)) return;
    applySanitize(this.record, sanitizedBox);
  }

  sampling(gridSize: number, probes: readonly SampleCellProbe[]): void {
    if (!this.owner.isLive(this)) return;
    applySampling(this.record, gridSize, probes);
  }

  clustering(
    sampledPoints: readonly THREE.Vector3[],
    report: DBSCANClusterReport | null,
    params: { eps: number; minPts: number },
  ): void {
    if (!this.owner.isLive(this)) return;
    applyClustering(this.record, sampledPoints, report, params);
    this.ownerRefresh();
  }

  measurement(measured: MeasuredObjectCluster): void {
    if (!this.owner.isLive(this)) return;
    applyMeasurement(this.record, measured);
  }

  obb(fit: OBBFitResult): void {
    if (!this.owner.isLive(this)) return;
    applyObb(this.record, fit);
    this.ownerRefresh();
  }

  lift(selection: GaussianObjectSelectionResult | null, note: string | null): void {
    if (!this.owner.isLive(this)) return;
    applyLift(this.record, selection, note);
  }

  anchor(position: THREE.Vector3, source: AnchorSource): void {
    if (!this.owner.isLive(this)) return;
    applyAnchor(this.record, position, source);
    this.ownerRefresh();
  }

  attach(annotationId: string): void {
    if (!this.owner.isLive(this)) return;
    this.record.annotationId = annotationId;
  }

  failure(stage: string, reason: string): void {
    if (!this.owner.isLive(this)) return;
    applyFailure(this.record, stage, reason);
    this.ownerRefresh();
  }

  private ownerRefresh(): void {
    // Stage-completion refreshes keep the visualization in step with the
    // record; the final refresh happens in endDetection.
    this.owner.refresh(this.request);
  }
}
