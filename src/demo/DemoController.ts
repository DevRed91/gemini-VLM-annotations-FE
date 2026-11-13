import * as THREE from "three";
import type { AnnotationDiagnostics } from "../diagnostics/AnnotationDiagnostics.ts";
import type { DetectionDiagnostics } from "../diagnostics/types.ts";
import { generateSnapshotRay, type ViewSnapshot } from "../viewer/ViewSnapshot.ts";
import { bindSnapshot, snapshotSplatRay, type LiveWorldState, type SnapshotBinding } from "../viewer/SnapshotBinding.ts";
import {
  CostMeter,
  cameraDrift,
  formatDrift,
  gridCells,
  maxRayDeviation,
  meanPairedDistance,
  provisionalBox,
  type GridCell,
  type NormalizedBox,
  type Vec3,
} from "./driftMath.ts";
import { Hud, type HudModel, type SettledHudModel } from "./Hud.ts";
import { ConfirmGate, DiagnosticsGuard } from "./guards.ts";
import { HELPER_WARNING, describeHelpers, detectAnnotationHelpers, type HelperDetection } from "./helperDetection.ts";
import { splatRaycastReadiness, type SplatReadinessInput } from "./readiness.ts";
import { SceneFCaptions, SceneFPanel, type SceneFMode, type SceneFSlotId, type ScenePose } from "./sceneCaptions.ts";
import { poseChange, type CameraSample } from "./settle.ts";
import { SettledMeasurer, type CastResult, type SettledMeasurement } from "./settledMeasurement.ts";
import { SettledOverlay } from "./SettledOverlay.ts";
import { PresentationPanel } from "./PresentationPanel.ts";
import {
  CAPTURE_SLOTS,
  PresentationCaptureStore,
  sceneLabelFromUrl,
  slotTitle,
  type CaptureSlotId,
  type PresentationCapture,
} from "./presentationCaptures.ts";
import {
  createInferenceSeam,
  type InferenceConfig,
  type InferenceEvent,
  type InferenceMode,
  type InferenceSeam,
} from "./inferenceSeam.ts";
import { RayOverlay, type RayEntry } from "./RayOverlay.ts";
import { STAGE_NAMES, StageOverlay, type StageLevel } from "./StageOverlay.ts";

/**
 * The slice of SplatViewer the demo needs. Several members are private in
 * TypeScript; they are reached through one cast in bootstrap.ts, and the demo
 * only READS them (plus: wrapping captureViewSnapshot, and the camera pose
 * restore performed by reset()).
 */
export interface DemoHost {
  camera: THREE.PerspectiveCamera;
  cameraRig: THREE.Group;
  cameraOrientTarget: THREE.Quaternion | null;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  currentSplat: (THREE.Object3D & SplatReadinessInput) | null;
  splatLoaded: boolean;
  /** URL of the loaded world, used only to label the presentation view. */
  currentWorldUrl?: string | null;
  isSelecting: boolean;
  annotationDiagnostics: AnnotationDiagnostics | null;
  objectHighlighter: { list(): unknown[] } | null;
  /** Live annotations (read-only here). */
  annotations: { apartmentId: string; helper?: THREE.Object3D }[];
  /** Persisted scene annotation records (read-only here). */
  annotationMetadataStore: { list(): { annotationId: string }[] } | null;
  captureViewSnapshot(): ViewSnapshot;
  splatRay(x: number, y: number): { ray: THREE.Ray; intersection: THREE.Intersection | null } | null;
  clearAllSelections(): Promise<void>;
  liveWorldState(): LiveWorldState;
}

export interface DemoOptions {
  /**
   * Presentation mode (?present=1): hides the engineering HUD and shows the
   * three-slot capture UI. Everything else in the demo behaves as normal.
   */
  presentation?: boolean;
  /** Click-to-inference dispatch; the annotation and measurement tools stay active when false. */
  inferenceEnabled?: boolean;
  mode?: InferenceMode;
  delayMs?: number;
  handBox?: NormalizedBox;
  /**
   * "ray" (DEFAULT): live rays are derived from the camera only; no splat
   * intersection per frame. "hits": legacy opt-in that casts every frame
   * (~35 ms per ray on office_space.sog) and is NOT used by default.
   */
  liveMode?: "hits" | "ray";
  /** Settle duration for the settled nine-ray measurement (default 300 ms). */
  settleMs?: number;
  /** `SplatMesh.isStaticInitialized`; bootstrap passes the real Spark flag. */
  staticInitialized?: () => boolean;
  /** Where Scene F pose bindings persist; default window.localStorage. */
  storage?: import("./sceneCaptions.ts").KeyValueStorage | null;
  /** Minimum ms between live-ray updates; 0 = every rendered frame. */
  liveIntervalMs?: number;
}

export interface PoseRecord {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  rig: { position: [number, number, number]; quaternion: [number, number, number, number] };
  cameraLocalQuaternion: [number, number, number, number];
}

const GRID = 3;
const HUD_INTERVAL_MS = 100;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function vec(v: THREE.Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

interface ActiveSnapshot {
  readonly binding: SnapshotBinding;
  readonly capturedAt: string;
  clickX: number;
  clickY: number;
  box: NormalizedBox;
  boxSource: "provisional (click-centred)" | "detection box" | "hand-specified box";
  cells: GridCell[];
  hits: (THREE.Vector3 | null)[];
  requestIndex: number | null;
  productionDeviation: { max: number; rays: number } | null;
}

export class DemoController {
  readonly overlay: RayOverlay;
  readonly stages = new StageOverlay();
  readonly root = new THREE.Group();
  readonly poses: PoseRecord[] = [];
  private readonly hud: Hud;
  private readonly seam: InferenceSeam;
  private readonly cost = new CostMeter();
  private readonly raycaster = new THREE.Raycaster();
  private readonly originalFetch: typeof fetch;
  private readonly ownCaptureWrapper: () => ViewSnapshot;
  /** Production frame capture with the demo overlays hidden; no annotation side effects. */
  private readonly captureCleanFrame: () => ViewSnapshot;
  private readonly presentationStore = new PresentationCaptureStore();
  private presentationPanel: PresentationPanel | null = null;
  private readonly cleanups: Array<() => void> = [];
  private active: ActiveSnapshot | null = null;
  private pendingSnapshot: ViewSnapshot | null = null;
  private lastClick: { x: number; y: number } | null = null;
  private lastPointer: { clientX: number; clientY: number } | null = null;
  private readonly measurer: SettledMeasurer;
  private readonly settledOverlay = new SettledOverlay();
  private readonly gate: ConfirmGate;
  private readonly diagnosticsGuard: DiagnosticsGuard;
  private readonly captions: SceneFCaptions;
  private readonly captionPanel: SceneFPanel;
  private readonly staticInitialized: () => boolean;
  private settledKey = "none";
  private settledDriftCache: { sequence: number; text: string } | null = null;
  private helperState: HelperDetection;
  private helperReadAt = -Infinity;
  private clearResult = "";
  private readonly sampleBuffer = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  private liveHits: (THREE.Vector3 | null)[] = [];
  private liveHitCount = 0;
  private lastLiveAt = -Infinity;
  private lastHudAt = -Infinity;
  private requestText = "idle";
  private liveMode: "hits" | "ray";
  private readonly inferenceEnabled: boolean;
  private liveIntervalMs: number;
  private snapshotVisible = true;
  private liveVisible = true;
  private homePose: PoseRecord;
  private disposed = false;
  /** Everything the demo ever captured/reset, for cleanup tests and the guide. */
  readonly counters = { captures: 0, resets: 0, adopted: 0, staleRejections: 0, presentationCaptures: 0 };

  private readonly host: DemoHost;

  constructor(host: DemoHost, options: DemoOptions = {}) {
    this.host = host;
    this.inferenceEnabled = options.inferenceEnabled ?? true;
    this.liveMode = options.liveMode ?? "ray";
    this.staticInitialized = options.staticInitialized ?? (() => true);
    this.liveIntervalMs = options.liveIntervalMs ?? 0;
    this.homePose = this.readPose();

    // Diagnostics markers start OFF for the recording and are restored to
    // their previous state on dispose. D still toggles them (production's own
    // handler, untouched). The production default is never changed.
    this.diagnosticsGuard = new DiagnosticsGuard(host.annotationDiagnostics);
    this.diagnosticsGuard.install();
    this.cleanups.push(() => this.diagnosticsGuard.restore());

    this.gate = new ConfirmGate(() => performance.now());
    this.helperState = this.readHelpers();
    this.measurer = new SettledMeasurer({
      sample: () => this.sampleCamera(),
      isReady: () => this.splatReadiness().ready,
      cast: (x, y) => this.castOnce(x, y),
      nowMs: () => performance.now(),
      wallClockIso: () => new Date().toISOString(),
      helperCount: () => this.readHelpers().helperCount,
      settle: options.settleMs !== undefined ? { stableMs: options.settleMs } : undefined,
    });

    let storage: import("./sceneCaptions.ts").KeyValueStorage | null = null;
    try {
      storage = options.storage !== undefined ? options.storage : window.localStorage;
    } catch {
      storage = null;
    }
    this.captions = new SceneFCaptions(storage);

    this.originalFetch = window.fetch.bind(window);
    this.seam = createInferenceSeam(
      {
        fetch: this.originalFetch,
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        now: () => performance.now(),
        onEvent: (event) => this.onInferenceEvent(event),
      },
      // Only pass options that were actually given: createInferenceSeam spreads this
      // over its defaults, so an explicit `undefined` would erase the default value.
      Object.fromEntries(
        Object.entries({ mode: options.mode, delayMs: options.delayMs, handBox: options.handBox }).filter(([, v]) => v !== undefined),
      ),
    );
    window.fetch = this.seam.fetch;
    this.cleanups.push(() => {
      window.fetch = this.originalFetch;
    });

    this.root.name = "demo-root";
    this.overlay = new RayOverlay(GRID * GRID, () => this.onFrame());
    this.root.add(this.overlay.group, this.stages.group, this.settledOverlay.group);
    host.scene.add(this.root);
    this.cleanups.push(() => {
      this.settledOverlay.dispose();
      this.overlay.dispose();
      this.stages.dispose();
      this.root.removeFromParent();
    });

    // Intercept every production snapshot capture: (1) hide the demo geometry
    // so it can never appear in the image sent to Gemini, (2) remember the exact
    // frozen snapshot production bound its sampling rays to.
    const original = host.captureViewSnapshot.bind(host);
    this.captureCleanFrame = () => {
      const wasVisible = this.root.visible;
      this.root.visible = false;
      try {
        return original();
      } finally {
        this.root.visible = wasVisible;
      }
    };
    this.ownCaptureWrapper = () => {
      const snapshot = this.captureCleanFrame();
      this.pendingSnapshot = snapshot;
      this.counters.captures++;
      return snapshot;
    };
    host.captureViewSnapshot = this.ownCaptureWrapper;
    this.cleanups.push(() => {
      delete (host as Partial<DemoHost>).captureViewSnapshot;
    });

    this.hud = new Hud({
      setMode: (mode) => this.setMode(mode),
      capture: () => this.capture(),
      reset: () => void this.reset(),
      requestClear: () => this.requestClearAnnotations(),
      confirmClear: () => void this.confirmClearAnnotations(),
      cancelClear: () => this.cancelClearAnnotations(),
    });
    this.cleanups.push(() => this.hud.dispose());

    if (options.presentation) {
      // Engineering HUD hidden only here; normal demo mode never reaches this.
      this.hud.setVisible(false);
      this.presentationPanel = new PresentationPanel({ capture: (slot) => void this.capturePresentationSlot(slot) });
      this.cleanups.push(() => {
        this.presentationPanel?.dispose();
        this.presentationPanel = null;
        this.presentationStore.clear();
      });
    }

    this.captionPanel = new SceneFPanel(this.captions, { bindLast: (slot) => this.bindLastPose(slot) });
    this.cleanups.push(() => this.captionPanel.dispose());

    this.installListeners();
    this.refreshHud(true);
  }

  // ---------------------------------------------------------------- config

  setMode(mode: InferenceMode, patch: Partial<InferenceConfig> = {}): void {
    this.seam.update({ ...patch, mode });
    this.refreshHud(true);
  }

  configure(patch: Partial<InferenceConfig>): void {
    this.seam.update(patch);
    this.refreshHud(true);
  }

  config(): Readonly<InferenceConfig> {
    return this.seam.config();
  }

  setLiveRays(options: { mode?: "hits" | "ray"; intervalMs?: number }): void {
    if (options.mode) this.liveMode = options.mode;
    if (options.intervalMs !== undefined) this.liveIntervalMs = options.intervalMs;
    this.cost.reset();
  }

  setHomePose(pose: PoseRecord = this.readPose()): void {
    this.homePose = pose;
  }

  // --------------------------------------------------------------- capture

  /**
   * Shift+S: dispatch a real click on the canvas so the production click
   * handler performs the capture, request and pipeline. Requires the
   * Annotation Tool; otherwise production ignores the click.
   */
  capture(): boolean {
    if (!this.host.isSelecting) {
      this.refreshHud(true);
      return false;
    }
    const canvas = this.host.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const pointer = this.lastPointer;
    const clientX = pointer ? pointer.clientX : rect.left + rect.width / 2;
    const clientY = pointer ? pointer.clientY : rect.top + rect.height / 2;
    canvas.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY, view: window }),
    );
    return true;
  }

  /**
   * Presentation capture: ONE synchronous render + readback through the same
   * ViewSnapshot path production uses, so the stored JPEG, camera pose and
   * projection all describe the same frame. Assigned to exactly the slot the
   * presenter chose; other slots are untouched and nothing is classified.
   * The annotation pipeline (pending snapshot, counters.captures) is not involved.
   */
  capturePresentationSlot(slot: CaptureSlotId): PresentationCapture | null {
    const panel = this.presentationPanel;
    if (!panel || this.disposed) return null;
    if (!this.host.currentSplat || !this.host.splatLoaded) {
      panel.warn("Scene is still loading — try again in a moment");
      return null;
    }
    try {
      const snapshot = this.captureCleanFrame();
      const capture = this.presentationStore.assign(slot, snapshot, Date.now());
      this.counters.presentationCaptures++;
      this.syncPresentation();
      panel.confirm(slot, `${slotTitle(slot)} view captured`);
      return capture;
    } catch (error) {
      panel.warn(`Capture failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Re-render the presentation UI from the store; drops captures from a replaced world. */
  private syncPresentation(): void {
    const panel = this.presentationPanel;
    if (!panel) return;
    this.presentationStore.dropOtherWorlds(this.host.liveWorldState().worldGeneration);
    panel.render({
      sceneLabel: sceneLabelFromUrl(this.host.currentWorldUrl),
      captures: this.presentationStore.slots(),
    });
  }

  private adoptPendingSnapshot(): void {
    const snapshot = this.pendingSnapshot;
    const click = this.lastClick;
    this.pendingSnapshot = null;
    if (!snapshot || !click) return;
    let binding: SnapshotBinding;
    try {
      binding = bindSnapshot(snapshot, this.host.liveWorldState());
    } catch (error) {
      this.counters.staleRejections++;
      this.requestText = `snapshot rejected: ${(error as Error).message}`;
      return;
    }
    this.counters.adopted++;
    this.stages.clear();
    const diag = this.host.annotationDiagnostics;
    const request = diag?.last();
    const box = this.seamBoxFor(click);
    this.active = {
      binding,
      capturedAt: new Date().toLocaleTimeString(),
      clickX: click.x,
      clickY: click.y,
      box: box.box,
      boxSource: box.source,
      cells: [],
      hits: [],
      requestIndex: request && request.source === "click" ? request.index : null,
      productionDeviation: null,
    };
    this.cost.reset();
    this.liveHits = [];
    this.requestText = !this.inferenceEnabled
      ? "disabled by demo config"
      : this.seam.config().mode === 3
        ? "scripted box (no model call)"
        : "request sent…";
    this.rebuildSnapshotRays();
    this.overlay.setSnapshotVisible(this.snapshotVisible);
    this.overlay.setLiveVisible(this.liveVisible);
    this.lastLiveAt = -Infinity;
    this.refreshHud(true);
  }

  /** Mode 3 knows its box before the request returns; other modes start provisional. */
  private seamBoxFor(click: { x: number; y: number }): { box: NormalizedBox; source: ActiveSnapshot["boxSource"] } {
    const cfg = this.seam.config();
    if (cfg.mode === 3) {
      const [ymin, xmin, ymax, xmax] = cfg.handBox;
      return { box: [clamp01(ymin), clamp01(xmin), clamp01(ymax), clamp01(xmax)], source: "hand-specified box" };
    }
    return { box: provisionalBox(click.x, click.y), source: "provisional (click-centred)" };
  }

  /** Green rays: the production snapshot ray function on the frozen binding. */
  private rebuildSnapshotRays(): void {
    const active = this.active;
    if (!active) return;
    const live = this.host.liveWorldState();
    active.cells = gridCells(active.box, GRID);
    const entries: RayEntry[] = [];
    active.hits = [];
    for (const cell of active.cells) {
      const cast = snapshotSplatRay(active.binding, live, cell.x, cell.y);
      const hit = cast.intersection?.point.clone() ?? null;
      active.hits.push(hit);
      entries.push({ origin: cast.ray.origin.clone(), direction: cast.ray.direction.clone(), hit });
    }
    const camera = active.binding.snapshot.camera.position;
    this.overlay.setSnapshotRays(entries, new THREE.Vector3(camera.x, camera.y, camera.z));
    this.overlay.setSnapshotVisible(this.snapshotVisible);
    // New comparison target: any earlier settled result was for other cells.
    this.measurer.setCells(active.cells);
    this.syncSettled();
  }

  // -------------------------------------------------------------- inference

  private onInferenceEvent(event: InferenceEvent): void {
    switch (event.type) {
      case "request":
        this.requestText = "request pending…";
        break;
      case "response": {
        const detection = event.detections.find((d) => d.box);
        const origin = event.synthetic ? "scripted" : `Gemini ${(event.latencyMs / 1000).toFixed(2)} s`;
        this.requestText = `${origin} → ${event.detections.length} object(s)`;
        if (detection?.box && this.active) {
          const [ymin, xmin, ymax, xmax] = detection.box.map(clamp01) as unknown as NormalizedBox;
          this.active.box = [ymin, xmin, ymax, xmax];
          this.active.boxSource = event.synthetic ? "hand-specified box" : "detection box";
          this.rebuildSnapshotRays();
        }
        break;
      }
      case "held":
        this.requestText = `HELD ${(event.delayMs / 1000).toFixed(1)} s (artificial delay) — move the camera`;
        break;
      case "released":
        this.requestText = "released → pipeline applying";
        break;
      case "cancelled":
        this.requestText = "cancelled by reset";
        break;
      case "error":
        this.requestText = `error: ${event.message}`;
        break;
    }
    this.refreshHud(true);
  }

  // ------------------------------------------------------------- per frame

  /** Runs inside the viewer's own render loop (RayOverlay tick); never renders. */
  private onFrame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const active = this.active;
    if (active && this.overlay.isLiveVisible() && now - this.lastLiveAt >= this.liveIntervalMs) {
      this.lastLiveAt = now;
      this.updateLiveRays(active);
    }
    // Settle detection runs on the sampled camera state every frame, so it
    // sees keyboard, pointer, touch and programmatic motion alike. It casts
    // into the splat ONLY on the frame a settle completes.
    this.measurer.tick();
    this.syncSettled();
    if (now - this.lastHudAt >= HUD_INTERVAL_MS) this.refreshHud(false);
  }

  // ---------------------------------------------------------- settled state

  /** Current camera state as the detector sees it (world pose + projection). */
  private sampleCamera(): CameraSample {
    const { camera } = this.host;
    const { p, q, s } = this.sampleBuffer;
    camera.matrixWorld.decompose(p, q, s);
    return {
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      fov: camera.fov,
      aspect: camera.aspect,
      zoom: camera.zoom,
      near: camera.near,
      far: camera.far,
    };
  }

  private splatReadiness() {
    return splatRaycastReadiness(this.host.currentSplat, this.host.splatLoaded, this.staticInitialized());
  }

  /** One production-legacy splat cast (viewer.splatRay) in the shape the measurer wants. */
  private castOnce(x: number, y: number): CastResult | null {
    const cast = this.host.splatRay(x, y);
    if (!cast) return null;
    const hit = cast.intersection?.point;
    return {
      origin: [cast.ray.origin.x, cast.ray.origin.y, cast.ray.origin.z],
      direction: [cast.ray.direction.x, cast.ray.direction.y, cast.ray.direction.z],
      hit: hit ? [hit.x, hit.y, hit.z] : null,
    };
  }

  /** Mirror the measurer into the 3D overlay (current -> show, stale/none -> hide). */
  private syncSettled(): void {
    const m = this.measurer.latest();
    const key = m ? `${m.sequence}:${m.status}` : "none";
    if (key === this.settledKey) return;
    this.settledKey = key;
    if (m && m.status === "current" && this.active) {
      this.settledOverlay.show(
        m.hits.map((h) => (h ? new THREE.Vector3(h[0], h[1], h[2]) : null)),
        this.active.hits,
      );
    } else {
      this.settledOverlay.clear();
    }
    this.refreshHud(true);
  }

  private updateLiveRays(active: ActiveSnapshot): void {
    const started = performance.now();
    const entries: RayEntry[] = [];
    this.liveHits = [];
    this.liveHitCount = 0;
    for (const cell of active.cells) {
      let origin: THREE.Vector3;
      let direction: THREE.Vector3;
      let hit: THREE.Vector3 | null = null;
      if (this.liveMode === "hits") {
        // Legacy live-camera path, deliberately NOT the production sampler.
        const cast = this.host.splatRay(cell.x, cell.y);
        if (!cast) continue;
        origin = cast.ray.origin.clone();
        direction = cast.ray.direction.clone();
        hit = cast.intersection?.point.clone() ?? null;
      } else {
        this.raycaster.setFromCamera(new THREE.Vector2(cell.x * 2 - 1, -(cell.y * 2 - 1)), this.host.camera);
        origin = this.raycaster.ray.origin.clone();
        direction = this.raycaster.ray.direction.clone();
      }
      if (hit) this.liveHitCount++;
      this.liveHits.push(hit);
      entries.push({ origin, direction, hit });
    }
    this.overlay.updateLive(entries);
    this.cost.record(performance.now() - started);
  }

  // ------------------------------------------------------------------- HUD

  private pollPipeline(active: ActiveSnapshot): DetectionDiagnostics | null {
    const diag = this.host.annotationDiagnostics;
    if (!diag || active.requestIndex === null) return null;
    const request = diag.list().find((r) => r.index === active.requestIndex);
    const record = request?.detections[request.detections.length - 1] ?? null;
    if (!record) return null;
    if (record.sampling && !active.productionDeviation) {
      this.verifyProductionRays(active, record);
    }
    return record;
  }

  /** Re-derive every recorded production ray from our copy of the snapshot. */
  private verifyProductionRays(active: ActiveSnapshot, record: DetectionDiagnostics): void {
    const cells = record.sampling?.cells ?? [];
    if (cells.length === 0 || cells.some((c) => !c.rayOrigin || !c.rayDirection)) return;
    const generation = active.binding.snapshot.worldGeneration;
    const ours = cells.map((c) => {
      const ray = generateSnapshotRay(active.binding.snapshot, c.normalizedX, c.normalizedY, generation);
      return {
        origin: [ray.origin.x, ray.origin.y, ray.origin.z] as Vec3,
        direction: [ray.direction.x, ray.direction.y, ray.direction.z] as Vec3,
      };
    });
    const theirs = cells.map((c) => ({
      origin: [c.rayOrigin!.x, c.rayOrigin!.y, c.rayOrigin!.z] as Vec3,
      direction: [c.rayDirection!.x, c.rayDirection!.y, c.rayDirection!.z] as Vec3,
    }));
    active.productionDeviation = { max: maxRayDeviation(ours, theirs), rays: cells.length };
  }

  private refreshHud(force: boolean): void {
    if (this.disposed) return;
    const now = performance.now();
    if (!force && now - this.lastHudAt < HUD_INTERVAL_MS) return;
    this.lastHudAt = now;
    this.syncPresentation();
    const cfg = this.seam.config();
    const active = this.active;
    const record = active ? this.pollPipeline(active) : null;
    if (record) this.stages.setRecordIfChanged(record);

    const drift = active
      ? formatDrift(cameraDrift(active.binding.snapshot.camera.worldMatrix, this.host.camera.matrixWorld.elements))
      : null;

    const snapHits = active ? active.hits.filter(Boolean).length : 0;
    const settled = this.measurer.latest();
    // Only a CURRENT settled measurement is a valid comparison.
    const displacement = active && settled?.status === "current" && settled.hits.length === active.hits.length
      ? meanPairedDistance(
          active.hits.map((h) => (h ? vec(h) : null)),
          settled.hits.map((h) => (h ? ([h[0], h[1], h[2]] as Vec3) : null)),
        )
      : null;
    const cost = this.cost.summary();
    const helpers = this.readHelpers(force);
    const armed = this.gate.isArmed();

    const model: HudModel = {
      mode: cfg.mode,
      modeLabel: modeLabel(cfg),
      modeNote: modeNote(cfg),
      inferenceEnabled: this.inferenceEnabled,
      annotationToolOn: this.host.isSelecting,
      snapshot: active
        ? {
            dataUrl: active.binding.snapshot.image.dataUrl,
            id: active.binding.snapshot.id,
            capturedAt: active.capturedAt,
            generation: active.binding.snapshot.worldGeneration,
            imageSize: `${active.binding.snapshot.image.width}×${active.binding.snapshot.image.height}`,
          }
        : null,
      drift,
      snapshotRays: active
        ? `${snapHits}/${active.hits.length} hit · ${active.boxSource}`
        : "–",
      snapshotHits: active ? `${snapHits} position(s) · frozen at ${active.capturedAt}` : "–",
      liveRays: active && this.overlay.isLiveVisible()
        ? this.liveMode === "hits"
          ? `${this.liveHitCount}/${active.cells.length} hit · LEGACY splat cast every frame`
          : `${active.cells.length} camera rays · no splat intersection`
        : "hidden",
      displacement: displacement
        ? `${displacement.mean.toFixed(3)} m mean (${displacement.pairs} pairs)`
        : settled?.status === "stale"
          ? "– (settled result is STALE)"
          : "–",
      liveCost: cost.count
        ? `${cost.meanMs.toFixed(3)} ms mean · ${cost.maxMs.toFixed(3)} max · ${this.liveIntervalMs ? `every ${this.liveIntervalMs} ms` : "every frame"}`
        : "–",
      settled: this.describeSettled(settled, active),
      helperWarning: helpers.warn ? HELPER_WARNING : null,
      helperSummary: describeHelpers(helpers),
      clear: {
        armed,
        armedLabel: `Confirm: reset + delete ${helpers.annotationCount} annotation(s)`,
        result: this.clearResult,
      },
      request: this.requestText,
      pipeline: this.describePipeline(record),
      productionMatch: active?.productionDeviation
        ? `max dev ${active.productionDeviation.max.toExponential(1)} over ${active.productionDeviation.rays} rays`
        : "–",
      stage: STAGE_NAMES[this.stages.stage()],
    };
    this.hud.update(model);
    if (this.captionPanel.currentMode() !== "hidden") this.captionPanel.update(this.readPose());
  }

  private describeSettled(m: SettledMeasurement | null, active: ActiveSnapshot | null): SettledHudModel {
    const status = this.measurer.status();
    if (!m) {
      const readiness = this.splatReadiness();
      const text =
        status === "no-snapshot"
          ? { status: "NO SNAPSHOT", note: "Capture a snapshot (Shift+S); the camera must then settle." }
          : status === "waiting-for-splat"
            ? { status: "WAITING FOR SPLAT", note: `Camera settled; waiting for ${readiness.waitingFor ?? "splat"} before casting.` }
            : { status: "WAITING FOR CAMERA", note: "Waiting for the camera to hold still (≈ 0.3 s), then 9 splat casts, once." };
      return { ...text, tone: "wait", hits: "–", measuredAt: "–", cost: "–", pose: "–", contamination: "" };
    }
    const hitCount = m.hits.filter(Boolean).length;
    const p = m.pose.position;
    const base = {
      hits: `${hitCount}/${m.hits.length} hit`,
      measuredAt: `${new Date(m.measuredAtIso).toLocaleTimeString()} (#${m.sequence})`,
      cost: `${m.durationMs.toFixed(0)} ms for ${m.hits.length} casts`,
      pose: `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)}) · ${this.driftAtCapture(m, active)}`,
      contamination:
        m.helperCountAtMeasurement > 0
          ? `⚠ ${m.helperCountAtMeasurement} annotation helper(s) were in the scene: hits may be helper geometry, not splat.`
          : "",
    };
    if (m.status === "stale") {
      return {
        ...base,
        status: "STALE",
        tone: "stale",
        hits: `${base.hits} · as of ${new Date(m.measuredAtIso).toLocaleTimeString()}`,
        note: `${m.staleReason ?? "out of date"} — kept for reference only, NOT a current hit comparison.`,
      };
    }
    return {
      ...base,
      status: "CURRENT",
      tone: "current",
      note: "Static: measured once when the camera settled; not recomputed per frame. Does not mean the helper-raycast issue is fixed.",
    };
  }

  /** Camera offset from the snapshot pose at measurement time (cached per measurement). */
  private driftAtCapture(m: SettledMeasurement, active: ActiveSnapshot | null): string {
    if (!active) return "no snapshot";
    if (this.settledDriftCache?.sequence === m.sequence) return this.settledDriftCache.text;
    const matrix = new THREE.Matrix4().fromArray(active.binding.snapshot.camera.worldMatrix as unknown as number[]);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    matrix.decompose(position, quaternion, new THREE.Vector3());
    const reference: CameraSample = {
      ...m.pose,
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    };
    const change = poseChange(reference, m.pose);
    const text = `Δ snapshot ${change.position.toFixed(3)} m / ${((change.orientation * 180) / Math.PI).toFixed(2)}°`;
    this.settledDriftCache = { sequence: m.sequence, text };
    return text;
  }

  private describePipeline(record: DetectionDiagnostics | null): string {
    if (!record) return "–";
    const parts: string[] = [];
    if (record.sampling) parts.push(`${record.sampling.gridSize}² grid ${record.sampling.hitCount} hits`);
    if (record.clustering) parts.push(`${record.clustering.clusters.length} cluster(s)`);
    if (record.obb) parts.push(`OBB ${record.obb.method}`);
    if (record.lift) parts.push(`${record.lift.selectedSplats} Gaussians`);
    else if (record.obb && record.liftNote) parts.push("highlight off");
    if (record.failures.length) parts.push(`FAIL ${record.failures[record.failures.length - 1].stage}`);
    return parts.join(" · ") || "running…";
  }

  // -------------------------------------------------------------- toggles

  toggleHud(): boolean {
    this.hud.setVisible(!this.hud.isVisible());
    return this.hud.isVisible();
  }

  toggleSnapshotRays(): boolean {
    this.snapshotVisible = !this.snapshotVisible;
    this.overlay.setSnapshotVisible(this.snapshotVisible);
    return this.snapshotVisible;
  }

  toggleLiveRays(): boolean {
    this.liveVisible = !this.liveVisible;
    this.overlay.setLiveVisible(this.liveVisible && this.active !== null);
    this.lastLiveAt = -Infinity;
    return this.liveVisible;
  }

  cycleStages(): StageLevel {
    const level = this.stages.cycle();
    this.refreshHud(true);
    return level;
  }

  // ----------------------------------------------------------------- reset

  /**
   * Repeatable reset (Shift+R): cancels any held request, clears every demo
   * visual and readout, restores the home camera pose. Annotations are NEVER
   * touched here; clearing them is a separate, confirmed action
   * (requestClearAnnotations -> confirmClearAnnotations).
   */
  async reset(): Promise<void> {
    this.resetDemoState();
    this.refreshHud(true);
  }

  private resetDemoState(): void {
    this.counters.resets++;
    this.gate.cancel();
    this.seam.cancelPending();
    this.overlay.clearSnapshotRays();
    this.overlay.updateLive([]);
    this.overlay.setLiveVisible(false);
    this.stages.clear();
    this.active = null;
    this.pendingSnapshot = null;
    this.lastClick = null;
    this.liveHits = [];
    this.liveHitCount = 0;
    this.cost.reset();
    this.requestText = "idle";
    this.clearResult = "";
    this.measurer.reset();
    this.settledDriftCache = null;
    this.syncSettled();
    this.restorePose(this.homePose);
  }

  // --------------------------------------------- reset + clear annotations

  /** Step 1: arm the confirmation. Deletes nothing. */
  requestClearAnnotations(): void {
    this.gate.arm();
    this.refreshHud(true);
  }

  cancelClearAnnotations(): void {
    this.gate.cancel();
    this.refreshHud(true);
  }

  /**
   * Step 2: only if armed (and within the window), reset the demo AND call the
   * viewer's clearAllSelections(), then re-read annotation state and report
   * whether anything survived. Returns "not-armed" without side effects when
   * there was no prior request.
   */
  async confirmClearAnnotations(): Promise<
    { status: "not-armed" } | { status: "cleared"; before: number; after: number; complete: boolean }
  > {
    if (!this.gate.confirm()) {
      this.refreshHud(true);
      return { status: "not-armed" };
    }
    const before = this.readHelpers(true).annotationCount;
    this.resetDemoState();
    try {
      await this.host.clearAllSelections();
    } catch (error) {
      this.clearResult = `clear FAILED: ${(error as Error).message}`;
      this.refreshHud(true);
      throw error;
    }
    const after = this.readHelpers(true);
    const complete = after.annotationCount === 0 && after.storedAnnotations === 0 && this.host.annotations.length === 0;
    this.clearResult = complete
      ? `cleared ${before} annotation(s) · verified 0 remain`
      : `CLEAR INCOMPLETE: ${after.annotationCount} annotation(s) / ${after.storedAnnotations} stored record(s) remain`;
    this.refreshHud(true);
    return { status: "cleared", before, after: after.annotationCount, complete };
  }

  /** Re-read helpers/annotations (throttled unless forced). */
  private readHelpers(force = true): HelperDetection {
    const now = performance.now();
    if (!force && now - this.helperReadAt < 500 && this.helperState) return this.helperState;
    this.helperReadAt = now;
    let storedRecords: { annotationId: string }[] = [];
    try {
      storedRecords = this.host.annotationMetadataStore?.list() ?? [];
    } catch {
      storedRecords = [];
    }
    this.helperState = detectAnnotationHelpers({
      splatChildren: this.host.currentSplat ? this.host.currentSplat.children : null,
      annotations: this.host.annotations,
      storedRecords,
    });
    return this.helperState;
  }

  // ------------------------------------------------------------------ pose

  readPose(): PoseRecord {
    const { camera, cameraRig } = this.host;
    camera.updateWorldMatrix(true, false);
    const p = camera.getWorldPosition(new THREE.Vector3());
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    return {
      position: [p.x, p.y, p.z],
      quaternion: [q.x, q.y, q.z, q.w],
      fov: camera.fov,
      rig: {
        position: cameraRig.position.toArray() as [number, number, number],
        quaternion: cameraRig.quaternion.toArray() as [number, number, number, number],
      },
      cameraLocalQuaternion: camera.quaternion.toArray() as [number, number, number, number],
    };
  }

  private restorePose(pose: PoseRecord): void {
    const { camera, cameraRig } = this.host;
    this.host.cameraOrientTarget = null;
    cameraRig.position.fromArray(pose.rig.position);
    cameraRig.quaternion.fromArray(pose.rig.quaternion);
    camera.quaternion.fromArray(pose.cameraLocalQuaternion);
    camera.updateWorldMatrix(true, false);
  }

  // ------------------------------------------------------------- Scene F

  /** hidden → setup → clean → hidden. Static captions only; never moves the camera. */
  cycleCaptions(): SceneFMode {
    return this.captionPanel.cycle();
  }

  /** Bind a logged (Shift+P) pose to a Scene F slot. Defaults to the most recent log. */
  bindScenePose(slot: SceneFSlotId, pose: ScenePose | undefined = this.poses[this.poses.length - 1]): boolean {
    if (!pose) return false;
    this.captions.bind(slot, pose);
    return true;
  }

  private bindLastPose(slot: SceneFSlotId): boolean {
    return this.bindScenePose(slot);
  }

  logPose(): PoseRecord {
    const pose = this.readPose();
    this.poses.push(pose);
    console.log(`[demo] pose #${this.poses.length}`, JSON.stringify(pose));
    void navigator.clipboard?.writeText(JSON.stringify(pose)).catch(() => {});
    return pose;
  }

  // ------------------------------------------------------------- listeners

  private installListeners(): void {
    const canvas = this.host.renderer.domElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || !event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const handlers: Record<string, () => void> = {
        KeyG: () => this.toggleHud(),
        KeyR: () => void this.reset(),
        KeyS: () => this.capture(),
        KeyV: () => this.toggleSnapshotRays(),
        KeyL: () => this.toggleLiveRays(),
        KeyP: () => this.logPose(),
        KeyT: () => this.cycleStages(),
        KeyF: () => this.cycleCaptions(),
        // Presentation mode only: Shift+1/2/3 assign the current view to Front/Side/Rear.
        ...(this.presentationPanel
          ? Object.fromEntries(CAPTURE_SLOTS.map((slot) => [slot.key, () => void this.capturePresentationSlot(slot.id)]))
          : {}),
      };
      const handler = handlers[event.code];
      if (!handler) return;
      // Capture phase + stopImmediatePropagation: keeps Shift+V away from the
      // diagnostics "v" toggle (which ignores Shift) and Shift+S away from
      // Spark's backward movement.
      event.preventDefault();
      event.stopImmediatePropagation();
      handler();
      this.refreshHud(true);
    };
    window.addEventListener("keydown", onKeyDown, true);
    this.cleanups.push(() => window.removeEventListener("keydown", onKeyDown, true));

    const onPointerMove = (event: PointerEvent) => {
      this.lastPointer = { clientX: event.clientX, clientY: event.clientY };
    };
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    this.cleanups.push(() => canvas.removeEventListener("pointermove", onPointerMove));

    // Click ordering: window capture (record position, forget stale snapshot)
    // -> production's canvas listener (captures via our wrapper) -> window
    // bubble (adopt the snapshot production just captured).
    const onClickCapture = (event: MouseEvent) => {
      if (event.target !== canvas) return;
      const rect = canvas.getBoundingClientRect();
      this.lastClick = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
      this.pendingSnapshot = null;
    };
    const onClickBubble = (event: MouseEvent) => {
      if (event.target !== canvas) return;
      this.adoptPendingSnapshot();
    };
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("click", onClickBubble, false);
    this.cleanups.push(() => {
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("click", onClickBubble, false);
    });
  }

  // ------------------------------------------------------------ inspection

  /** Plain-data view of the current demo state, for validators and the guide. */
  state() {
    const active = this.active;
    return {
      mode: this.seam.config().mode,
      inferenceEnabled: this.inferenceEnabled,
      hasSnapshot: active !== null,
      snapshotId: active?.binding.snapshot.id ?? null,
      box: active?.box ?? null,
      boxSource: active?.boxSource ?? null,
      cells: active?.cells ?? [],
      snapshotHits: active?.hits.map((h) => (h ? vec(h) : null)) ?? [],
      liveHits: this.liveHits.map((h) => (h ? vec(h) : null)),
      drift: active
        ? cameraDrift(active.binding.snapshot.camera.worldMatrix, this.host.camera.matrixWorld.elements)
        : null,
      productionDeviation: active?.productionDeviation ?? null,
      liveCost: this.cost.summary(),
      liveMode: this.liveMode,
      snapshotRaysVisible: this.snapshotVisible,
      liveRaysVisible: this.liveVisible,
      settled: this.measurer.latest(),
      settledStatus: this.measurer.status(),
      splatCasts: this.measurer.castCount(),
      readiness: this.splatReadiness(),
      helpers: this.helperState,
      diagnosticsEnabled: this.host.annotationDiagnostics?.isEnabled ?? null,
      liveIntervalMs: this.liveIntervalMs,
      overlayVisible: this.root.visible,
      presentation: this.presentationPanel
        ? { captures: this.presentationStore.slots(), count: this.presentationStore.count() }
        : null,
      pendingRequests: this.seam.pendingCount(),
      stage: this.stages.stage(),
      request: this.requestText,
      counters: { ...this.counters },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.seam.cancelPending();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }
}

function modeLabel(cfg: Readonly<InferenceConfig>): string {
  switch (cfg.mode) {
    case 1:
      return "LIVE GEMINI RESPONSE";
    case 2:
      return `REAL RESPONSE · ARTIFICIAL ${(cfg.delayMs / 1000).toFixed(1)} s DELAY`;
    case 3:
      return "HAND-SPECIFIED BOX · NO MODEL CALL";
  }
}

function modeNote(cfg: Readonly<InferenceConfig>): string {
  switch (cfg.mode) {
    case 1:
      return "Real request to the annotation backend; response applied as received.";
    case 2:
      return "The harness holds the real response to keep the camera moving while 'inference' is pending. The delay is injected, not model latency.";
    case 3:
      return `Scripted box [${cfg.handBox.map((v) => v.toFixed(2)).join(", ")}] replaces the model. Sampling, DBSCAN, OBB and lifting are the real pipeline.`;
  }
}
