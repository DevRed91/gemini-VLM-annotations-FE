import * as THREE from "three";

import type { LiveWorldState } from "../viewer/SnapshotBinding.ts";
import type { SegmentRequest, SegmentResponse, PixelBox } from "./contract.ts";
import {
  DEFAULT_VARIANTS,
  exportExperiment,
  runExperiment,
  type ExperimentResult,
  type VariantId,
  type ViewInput,
} from "./experiment.ts";
import {
  createSplatCaster,
  probeOffsets,
  refineAnchor,
  type AnchorRefinement,
  type CastFn,
} from "./geometry.ts";

/** The slice of SplatViewer this tool reads (private in TS; one cast in bootstrap). */
export interface SegmentationHost {
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  currentSplat: THREE.Object3D | null;
  splatLoaded: boolean;
  liveWorldState(): LiveWorldState;
}

export interface SegmentationDeps {
  readonly host: SegmentationHost;
  /** The presentation captures (Front/Side/Top), in slot order; empty slots omitted. */
  readonly getCaptures: () => ViewInput[];
  readonly segment: (request: SegmentRequest) => Promise<SegmentResponse>;
  readonly detectBox: (view: ViewInput, projected: { x: number; y: number }) => Promise<PixelBox | null>;
  /** Overridable for tests; defaults to a direct (helper-proof) splat caster. */
  readonly makeCaster?: (splat: THREE.Object3D) => CastFn;
  /** Radius of the probe ring around the click, in CSS pixels. */
  readonly probeRadiusPx?: number;
}

export interface AnchorPick {
  readonly refinement: AnchorRefinement;
  /** Click position, fractions of the canvas (top-left origin). */
  readonly click: { u: number; v: number };
  readonly cameraPosition: { x: number; y: number; z: number };
  readonly pickedAt: string;
  /** The worldGeneration the anchor belongs to; an anchor from another world is dropped. */
  readonly worldGeneration: number;
}

export interface SegmentationState {
  readonly picking: boolean;
  readonly running: boolean;
  readonly status: string;
  readonly anchor: AnchorPick | null;
  readonly captureCount: number;
  readonly result: ExperimentResult | null;
  readonly views: readonly ViewInput[];
  readonly text: string;
  readonly variants: readonly VariantId[];
  readonly occlusionPolicy: "send" | "skip";
}

export class SegmentationController {
  private readonly deps: SegmentationDeps;
  private picking = false;
  private running = false;
  private status = "Capture Front / Side / Top (Shift+1/2/3), then pick an anchor.";
  private anchor: AnchorPick | null = null;
  private result: ExperimentResult | null = null;
  private views: ViewInput[] = [];
  private text = "";
  private variants: VariantId[] = [...DEFAULT_VARIANTS];
  private occlusionPolicy: "send" | "skip" = "send";
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private readonly onClick = (event: MouseEvent) => this.handleClick(event);

  constructor(deps: SegmentationDeps) {
    this.deps = deps;
    window.addEventListener("click", this.onClick, true);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  state(): SegmentationState {
    return {
      picking: this.picking,
      running: this.running,
      status: this.status,
      anchor: this.anchorIfCurrent(),
      captureCount: this.deps.getCaptures().length,
      result: this.result,
      views: this.views,
      text: this.text,
      variants: this.variants,
      occlusionPolicy: this.occlusionPolicy,
    };
  }

  /** An anchor is a world-space point; it means nothing once the world has been replaced. */
  private anchorIfCurrent(): AnchorPick | null {
    if (this.anchor && this.anchor.worldGeneration !== this.deps.host.liveWorldState().worldGeneration) {
      this.anchor = null;
      this.result = null;
      this.status = "World changed: anchor and results discarded.";
    }
    return this.anchor;
  }

  configure(patch: { text?: string; variants?: VariantId[]; occlusionPolicy?: "send" | "skip" }): void {
    if (patch.text !== undefined) this.text = patch.text;
    if (patch.variants) this.variants = [...patch.variants];
    if (patch.occlusionPolicy) this.occlusionPolicy = patch.occlusionPolicy;
    this.emit();
  }

  setPicking(on: boolean): void {
    this.picking = on;
    if (on) this.status = "Click the target object in the scene (the click is consumed: no Gemini request).";
    this.emit();
  }

  private handleClick(event: MouseEvent): void {
    if (!this.picking || this.disposed) return;
    const canvas = this.deps.host.renderer.domElement;
    if (event.target !== canvas) return;
    // Consume the click so the production annotation handler never sees it.
    event.stopImmediatePropagation();
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    this.pickAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height, rect);
  }

  /**
   * Pick the 3D anchor at canvas fraction (u, v). Synchronous on purpose: the
   * camera cannot move between the click and the nine probe rays, so no
   * snapshot is needed. Casts directly into the splat (annotation helpers
   * cannot interfere). Costs ~35 ms per ray on large scenes.
   */
  pickAt(u: number, v: number, rect?: { width: number; height: number }): AnchorPick | null {
    const { host } = this.deps;
    this.picking = false;
    const splat = host.currentSplat;
    if (!splat || !host.splatLoaded) {
      this.status = "Scene not ready: no splat loaded.";
      this.emit();
      return null;
    }
    host.camera.updateMatrixWorld();
    const cast = (this.deps.makeCaster ?? createSplatCaster)(splat);
    const radiusPx = this.deps.probeRadiusPx ?? 6;
    const w = rect?.width ?? host.renderer.domElement.clientWidth ?? 1;
    const h = rect?.height ?? host.renderer.domElement.clientHeight ?? 1;
    const raycaster = new THREE.Raycaster();
    const hits: { x: number; y: number; z: number }[] = [];
    const offsets = probeOffsets(radiusPx / w, radiusPx / h);
    for (const [du, dv] of offsets) {
      const pu = Math.min(1, Math.max(0, u + du));
      const pv = Math.min(1, Math.max(0, v + dv));
      raycaster.setFromCamera(new THREE.Vector2(pu * 2 - 1, -(pv * 2 - 1)), host.camera);
      const first = cast(raycaster.ray.origin, raycaster.ray.direction)[0];
      if (first) hits.push(first.point);
    }
    const refinement = refineAnchor(hits, offsets.length);
    if (!refinement) {
      this.status = "No splat hit under the click (scene may still be settling, or the click hit empty space).";
      this.emit();
      return null;
    }
    const position = host.camera.getWorldPosition(new THREE.Vector3());
    this.anchor = {
      refinement,
      click: { u, v },
      cameraPosition: { x: position.x, y: position.y, z: position.z },
      pickedAt: new Date().toISOString(),
      worldGeneration: host.liveWorldState().worldGeneration,
    };
    this.result = null;
    this.status = refinement.stable
      ? "Anchor set. Run to project it into the captured views."
      : `Anchor set but UNSTABLE (${refinement.hitCount}/${refinement.probeCount} rays hit, spread ${refinement.spread.toFixed(3)}): the click may be on a floater or an edge.`;
    this.emit();
    return this.anchor;
  }

  async run(): Promise<ExperimentResult | null> {
    if (this.running) return null;
    const anchor = this.anchorIfCurrent();
    const { host } = this.deps;
    if (!anchor) {
      this.status = "Pick an anchor first.";
      this.emit();
      return null;
    }
    const views = this.deps.getCaptures();
    if (views.length === 0) {
      this.status = "No captures: press Shift+1/2/3 in presentation mode (?demo=1&present=1).";
      this.emit();
      return null;
    }
    const splat = host.currentSplat;
    if (!splat || !host.splatLoaded) {
      this.status = "Scene not ready.";
      this.emit();
      return null;
    }
    this.running = true;
    this.views = views;
    this.emit();
    try {
      const result = await runExperiment(
        views,
        {
          anchor: anchor.refinement.anchor,
          text: this.text,
          variants: this.variants,
          occlusionPolicy: this.occlusionPolicy,
        },
        {
          live: host.liveWorldState(),
          cast: (this.deps.makeCaster ?? createSplatCaster)(splat),
          segment: this.deps.segment,
          detectBox: this.deps.detectBox,
          onProgress: (message) => {
            this.status = message;
            this.emit();
          },
        },
      );
      this.result = result;
      const mock = result.views.some((v) => v.variants.some((x) => x.mock));
      this.status = mock
        ? "Done. MOCK provider: masks are synthetic and say nothing about SAM 3."
        : "Done.";
      return result;
    } catch (error) {
      this.status = `Run failed: ${(error as Error).message}`;
      return null;
    } finally {
      this.running = false;
      this.emit();
    }
  }

  clear(): void {
    this.anchor = null;
    this.result = null;
    this.views = [];
    this.picking = false;
    this.status = "Cleared.";
    this.emit();
  }

  /** JSON-safe export of the last run plus the anchor provenance. Contains no images or masks. */
  exportResult(): unknown {
    return {
      anchor: this.anchor,
      result: this.result ? exportExperiment(this.result) : null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("click", this.onClick, true);
    this.listeners.clear();
  }
}
