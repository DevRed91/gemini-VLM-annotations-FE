/// <reference types="vite/client" />

import * as THREE from "three";
import {
  SparkControls,
  SparkRenderer,
  SplatMesh,
  dyno,
} from "@sparkjsdev/spark";
import {
  getMobileInput,
  getMobileLook,
  initMobileControls,
  isMobileDevice,
} from "./utils/mobileJoystick";
import { HoverTint, OBB } from "./utils/hoverTint";
import { fitOBB, obbWorldToLocal } from "./utils/obbFit";
import { SpatialObjectRegistry } from "./utils/spatialObjectRegistry";
import { searchObjects } from "./spatial/ObjectMatcher";
import type { SearchOptions, SearchQuery } from "./spatial/types";
import {
  parseAnnotationMetadata,
  type AnnotationMetadata,
} from "./spatial/AnnotationMetadata";
import {
  createSceneAnnotationMetadataStore,
  createSceneAnnotationRecord,
  type SceneAnnotationMetadataStore,
  type SceneAnnotationRecord,
} from "./spatial/AnnotationMetadataStore";
import { ChatController } from "./chat/ChatController";
import { ChatPanel } from "./chat/ChatPanel";
import { ChatAnnotationSelection } from "./viewer/ChatAnnotationSelection";
import { deriveSearchAttributes } from "./chat/LocalQueryParser";
import GeometricContextManager from "./GeometricContextManager/GeometricContextManager";
import type { DBSCANClusterReport } from "./GeometricContextManager/GeometricContextManager";
import { AnnotationDiagnostics } from "./diagnostics/AnnotationDiagnostics";
import type { DetectionRecorder } from "./diagnostics/AnnotationDiagnostics";
import type { SampleCellProbe } from "./diagnostics/records";
import type { NormalizedBox } from "./diagnostics/types";
import { GaussianObjectHighlighter } from "./utils/gaussianObjectHighlighter";
import { defaultGaussianMaskColor } from "./utils/gaussianMaskManager";
import { isNonLodSplat } from "./utils/gaussianIndexSupport";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ||
  "/api";
const BYPASS_TUNNEL_REMINDER =
  (import.meta.env.VITE_BYPASS_TUNNEL_REMINDER as string | undefined) === "true";
// Experimental Gaussian tinting is opt-in; annotation pins stay visible while OBB wireframes are hidden.
const ENABLE_GAUSSIAN_HIGHLIGHTING =
  (import.meta.env.VITE_ENABLE_GAUSSIAN_HIGHLIGHTING as string | undefined) === "true";

function buildAnnotateEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");

  if (normalized.endsWith("/annotate")) {
    return normalized;
  }
  if (normalized.endsWith("/api")) {
    return `${normalized}/annotate`;
  }
  if (normalized.startsWith("http")) {
    return `${normalized}/api/annotate`;
  }
  return `${normalized}/annotate`;
}

/**
 * Screen-space sample-grid resolution for a sanitized detection box.
 * Unchanged production formula (was inline in samplePointsFromBox); extracted
 * so the dev diagnostics can report the same value the sampler used.
 */
function computeSampleGridSize(box: AnnotationDetection["box"], nonLod: boolean): number {
  const [ymin, xmin, ymax, xmax] = box;
  const area = (xmax - xmin) * (ymax - ymin);
  const minGridSize = 6;
  const maxGridSize = nonLod ? 25 : 6;
  return Math.max(
    minGridSize,
    Math.min(maxGridSize, Math.round(minGridSize + (maxGridSize - minGridSize) * Math.sqrt(area))),
  );
}

interface AnnotationDetection {
  label: string;
  description?: string;
  metadata?: unknown;
  box: [ymin: number, xmin: number, ymax: number, xmax: number];
}

interface DimensionSet {
  width: number;
  height: number;
  depth: number;
}

interface ViewerAnnotation {
  element: HTMLElement;
  position: THREE.Vector3;
  apartmentId: string;
  worldObb?: OBB;
  helper?: THREE.LineSegments;
  fallbackTint?: HoverTint;
  selectionOwner?: GaussianObjectHighlighter;
  selectionId?: number;
  helperBaseColor?: THREE.Color;
  worldGeneration: number;
}

export class SplatViewer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private spark: SparkRenderer;
  private controls: SparkControls;
  private cube!: THREE.Mesh;
  private currentSplat: SplatMesh | null = null;
  private isMobile: boolean = isMobileDevice();
  private cameraRig = new THREE.Group();
  private animateT = dyno.dynoFloat(0);
  private baseTime = 0;
  private splatLoaded = false;
  private annotations: ViewerAnnotation[] = [];
  private isSelecting = false;
  private annotationLoadingEl: HTMLElement | null = null;
  private objectHighlighter: GaussianObjectHighlighter | null = null;
  private worldGeneration = 0;
  private annotationSequence = 0;
  /**
   * Per-world semantic inventory (Phase 0, registry integration). Created with
   * each successful `loadWorld`, dropped with the world's resources; see
   * `docs/chat-object-search-phase-0-registry.md` for the data contract.
   */
  private spatialRegistry: SpatialObjectRegistry | null = null;
  private annotationMetadataStore: SceneAnnotationMetadataStore | null = null;
  /**
   * Task 1 development-only pipeline diagnostics (dev builds only). Null in
   * production, so every stage call below is skipped. Never feeds back into
   * the annotation pipeline; see src/diagnostics/AnnotationDiagnostics.ts.
   */
  private annotationDiagnostics: AnnotationDiagnostics | null = null;
  private chatController: ChatController | null = null;
  private readonly chatAnnotationSelection = new ChatAnnotationSelection();
  private cameraOrientTarget: THREE.Quaternion | null = null;
  private readonly disposedSplats = new WeakSet<SplatMesh>();
  private readonly geometricContext = new GeometricContextManager();
  private apartments: { id: string; obb: OBB; source?: THREE.Object3D; geomSize?: THREE.Vector3 }[] = [];
  private readonly shaderErrors: string[] = [];
  private static readonly CHAT_SELECTED_COLOR = new THREE.Color(0x38bdf8);

  public lastClusterFit: {
    world: OBB;
    local: OBB;
    points: THREE.Vector3[];
    method: string;
    objectId?: number;
  } | null = null;

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.01,
      1000,
    );
    this.cameraRig = new THREE.Group();
    this.cameraRig.add(this.camera);
    this.cameraRig.position.set(0, 0, -3);
    this.cameraRig.rotateY(Math.PI);
    this.scene.add(this.cameraRig);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    if (import.meta.env.DEV) {
      this.renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
        this.shaderErrors.push([
          gl.getProgramInfoLog(program),
          gl.getShaderInfoLog(vertexShader),
          gl.getShaderInfoLog(fragmentShader),
        ].filter(Boolean).join("\n"));
      };
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    document.body.appendChild(this.renderer.domElement);
    this.controls = new SparkControls({ canvas: this.renderer.domElement });

    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);
    if (import.meta.env.DEV) {
      this.annotationDiagnostics = new AnnotationDiagnostics(this.scene);
    }
    this.cube = this.addBox();
    this.addGroundPlane();
    // Transform, scale, and rotation gizmo disabled for now.
    // this.transformControls = new TransformControls(
    //   this.camera,
    //   this.renderer.domElement,
    // );
    // this.transformControls.attach(this.cube);
    // this.scene.add(this.transformControls.getHelper());
    // this.transformControls.addEventListener("dragging-changed", (event) => {
    //   this.controls.pointerControls.enable = !event.value;
    // });
    this.setMobileControls();
    this.setupEventListeners();
    this.setupAnnotationUI();
    this.setupChatUI();
    // this.setupSelectionBox();
    this.setupClickInteraction();
    this.setupLoadingUI();
    // Demo: treat the green box as an apartment unit. Replace with real OBBs.
    this.registerApartment("demo-cube", this.cube, new THREE.Vector3(0.13, 1, 0.1));
    this.startAnimationLoop();
  }

  private setupLoadingUI() {
    const loadingEl = document.createElement("div");
    loadingEl.className = "annotation-loading hidden";
    loadingEl.innerHTML = `
      <div class="annotation-loading__spinner"></div>
      <span>Fetching annotation...</span>
    `;
    document.body.appendChild(loadingEl);
    this.annotationLoadingEl = loadingEl;
  }

  private setAnnotationLoading(isLoading: boolean) {
    if (!this.annotationLoadingEl) return;
    this.annotationLoadingEl.classList.toggle("hidden", !isLoading);
  }

  private setupEventListeners() {
    window.addEventListener("resize", () => this.onWindowResize());
    window.addEventListener("keydown", (event) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === "Enter") {
        console.log("Cube position:", this.cube.position.toArray());
        console.log("Cube scale:", this.cube.scale.toArray());
      }
      // TransformControls mode shortcuts disabled with the gizmo.
      // if (event.key.toLowerCase() === "s") this.transformControls.setMode("scale");
      // if (event.key.toLowerCase() === "t") this.transformControls.setMode("translate");
      // if (event.key.toLowerCase() === "r") this.transformControls.setMode("rotate");
    });
  }

  private onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private startAnimationLoop() {
    let lastTime = performance.now();
    this.renderer.setAnimationLoop((time) => {
      this.controls.update(this.cameraRig);
      this.stepCameraOrient();
      this.camera.updateMatrixWorld();
      // this.lockCameraHeightToGround();
      const MOVE_SPEED = 2.0;
      const deltaTime = (time - lastTime) / 1000;
      lastTime = time;
      if (this.splatLoaded) {
        this.baseTime += 1 / 60;
        this.animateT.value = this.baseTime;
      } else {
        this.animateT.value = 0;
      }

      this.updateMobileControls(deltaTime, MOVE_SPEED);
      this.updateAnnotationLabels();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private setupClickInteraction() {
    this.renderer.domElement.addEventListener("click", (e) => {
      // Only trigger if a specific tool is active (optional)
      if (!this.isSelecting) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const clickCast = this.splatRay(x, y);
      const clickWorldPos = clickCast?.intersection?.point ?? null;

      console.log(`User clicked at: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      this.annotationDiagnostics?.recordClick({
        normalizedX: x,
        normalizedY: y,
        clientX: e.clientX,
        clientY: e.clientY,
        cameraPosition: this.camera.getWorldPosition(new THREE.Vector3()),
        cameraQuaternion: this.camera.getWorldQuaternion(new THREE.Quaternion()),
        ray: clickCast?.ray ?? null,
        intersection: clickCast?.intersection ?? null,
      });

      // Trigger the new coordinate-based request
      this.requestAnnotationFromGemini(x, y, clickWorldPos);
    });
  }

  /** Register an apartment OBB. Pass a source object to keep the OBB synced to it. */
  public registerApartment(id: string, source: THREE.Object3D, geomSize: THREE.Vector3): void;
  public registerApartment(id: string, obb: OBB): void;
  public registerApartment(id: string, a: THREE.Object3D | OBB, geomSize?: THREE.Vector3) {
    if (a instanceof OBB) {
      this.apartments.push({ id, obb: a });
    } else {
      this.apartments.push({ id, obb: OBB.fromObject3D(a, geomSize!), source: a, geomSize });
    }
  }

  private setupAnnotationUI() {
    const btn = document.getElementById("annotationToolButton");
    if (btn) {
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        // FIX: Toggle the state
        this.isSelecting = btn.classList.contains("active");
      });
    }
  }

  private setupChatUI(): void {
    const panel = new ChatPanel(
      (message) => { void this.chatController?.submitQuery(message); },
      () => this.chatController?.clearConversation(),
      (annotationId) => {
        this.chatController?.selectAnnotation(annotationId);
        this.orientCameraToAnnotation(annotationId);
      },
      (annotationIds) => this.chatController?.selectAnnotations(annotationIds),
      () => this.chatController?.clearSelection(),
    );
    this.chatController = new ChatController(
      () => this.spatialRegistry?.list() ?? null,
      (state) => panel.render(state),
      searchObjects,
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      {
        setChatSelection: (annotationIds) => this.setChatSelection(annotationIds),
        clearChatSelection: () => this.clearChatSelection(),
      },
    );
  }
  private updateAnnotationLabels() {
    this.annotations.forEach((ann) => {
      // Check if element exists
      if (!ann.element) return;

      // Project 3D point to NDC
      const pos = ann.position.clone().project(this.camera);

      // Hide if behind camera (pos.z > 1) or out of frustum
      if (pos.z > 1) {
        ann.element.style.display = "none";
      } else {
        ann.element.style.display = "block";
        // Convert NDC (-1 to 1) to screen pixels
        const x = (pos.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-pos.y * 0.5 + 0.5) * window.innerHeight;
        ann.element.style.left = `${x}px`;
        ann.element.style.top = `${y}px`;
      }
    });
  }

  private updateMobileControls(deltaTime: number, moveSpeed: number) {
    if (!this.isMobile) {
      return;
    }

    const input = getMobileInput();
    const look = getMobileLook();
    const LOOK_SPEED = 0.005;

    if (look.x !== 0 || look.y !== 0) {
      this.cameraRig.rotateY(-look.x * LOOK_SPEED);
      this.camera.rotateX(-look.y * LOOK_SPEED);

      const maxPitch = Math.PI / 2.1;
      this.camera.rotation.x = Math.max(
        -maxPitch,
        Math.min(maxPitch, this.camera.rotation.x),
      );
    }

    if (input.x !== 0 || input.y !== 0) {
      const move = new THREE.Vector3(input.x, 0, input.y);
      move.multiplyScalar(moveSpeed * deltaTime);
      move.applyQuaternion(this.cameraRig.quaternion);
      move.y = 0; // Stay grounded — don't let pitch affect vertical position
      this.cameraRig.position.add(move);
    }
  }

  private setMobileControls() {
    // const info = document.getElementById('info');

    if (this.isMobile) {
      initMobileControls({
        joystickSize: 140,
        knobSize: 60,
        marginLeft: 40,
        marginBottom: 40,
      });
    }
  }

  private addGroundPlane() {
    const geometry = new THREE.PlaneGeometry(100, 100);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    const plane = new THREE.Mesh(geometry, material);
    plane.name = "GroundPlane";
    plane.rotation.x = -Math.PI / 2; // horizontal floor
    plane.position.set(0, -1.7, 0);
    plane.visible = true;
    plane.receiveShadow = false;

    this.scene.add(plane);
  }

  private addBox(): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(0.13, 1, 0.1);
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const box = new THREE.Mesh(geometry, material);
    box.name = "GreenBox";
    box.position.set(-0.6797355047276763, -1.108790598191884, -1.3153952040011012);
    box.scale.set(-2.8098998190647926, 0.25, 2.6582629401302826);
    this.scene.add(box);
    return box;
  }

  private disposeSplat(splat: SplatMesh): void {
    if (this.disposedSplats.has(splat)) return;
    this.disposedSplats.add(splat);
    splat.removeFromParent();
    splat.dispose();
  }

  private removeAnnotationVisual(
    annotation: ViewerAnnotation,
    options: { removeMetadata?: boolean } = {},
  ): void {
    const removeMetadata = options.removeMetadata ?? true;
    this.removeChatSelectionId(annotation.apartmentId);
    // Unregister happens here so single deletes, clear-all, and world switches
    // all leave the registry without the removed annotation's spatial object.
    this.spatialRegistry?.remove(annotation.apartmentId);
    if (removeMetadata) {
      try {
        this.annotationMetadataStore?.remove(annotation.apartmentId);
      } catch (error) {
        console.error(`[annotation-metadata] Failed to remove ${annotation.apartmentId}:`, error);
      }
    }
    this.chatController?.inventoryChanged();
    annotation.element.remove();
    this.apartments = this.apartments.filter((item) => item.id !== annotation.apartmentId);
    // Dev diagnostics: drop this annotation's 3D diagnostic objects (records stay).
    this.annotationDiagnostics?.detachAnnotation(annotation.apartmentId);
    if (annotation.helper) {
      annotation.helper.removeFromParent();
      annotation.helper.geometry.dispose();
      const materials = Array.isArray(annotation.helper.material)
        ? annotation.helper.material
        : [annotation.helper.material];
      for (const material of materials) material.dispose();
      annotation.helper = undefined;
    }
    annotation.fallbackTint?.dispose();
    annotation.fallbackTint = undefined;
  }

  private clearAnnotationVisuals(options: { removeMetadata?: boolean } = {}): void {
    for (const annotation of this.annotations) this.removeAnnotationVisual(annotation, options);
    this.annotations = [];
  }

  private clearWorldResources(): void {
    this.clearChatSelection();
    // Dev diagnostics: worlds never share records or visualization objects.
    this.annotationDiagnostics?.clear();
    // Annotations unregister (while the registry is still alive) one by one,
    // then the per-world registry itself is dropped with the world. Persisted
    // records stay scene-keyed so the same scene can be restored on reload.
    this.clearAnnotationVisuals({ removeMetadata: false });
    this.spatialRegistry = null;
    this.annotationMetadataStore = null;
    this.objectHighlighter?.dispose();
    this.objectHighlighter = null;
    if (this.currentSplat) this.disposeSplat(this.currentSplat);
    this.currentSplat = null;
    this.splatLoaded = false;
    this.lastClusterFit = null;
  }

  public async clearAllSelections(): Promise<void> {
    this.clearChatSelection();
    const owner = this.objectHighlighter;
    this.clearAnnotationVisuals({ removeMetadata: true });
    this.lastClusterFit = null;
    await owner?.clearAll();
  }

  public setChatSelection(annotationIds: readonly string[]): void {
    const validIds = new Set(this.annotations.map((annotation) => annotation.apartmentId));
    this.chatAnnotationSelection.set(annotationIds, validIds);
    this.updateChatSelectionVisuals();
  }

  /** Smoothly turns the camera (in place) to face an annotation's tag. */
  public orientCameraToAnnotation(annotationId: string): void {
    const annotation = this.annotations.find((a) => a.apartmentId === annotationId);
    if (!annotation) return;
    this.cameraRig.updateMatrixWorld(true);
    const eye = new THREE.Vector3();
    this.camera.getWorldPosition(eye);
    const dir = annotation.position.clone().sub(eye);
    const horizontal = Math.hypot(dir.x, dir.z);
    if (dir.lengthSq() < 1e-8) return;
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.atan2(dir.y, horizontal);
    // SparkControls stores yaw+pitch on the rig quaternion (YXZ order).
    this.cameraOrientTarget = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pitch, yaw, 0, "YXZ"),
    );
  }

  private stepCameraOrient(): void {
    const target = this.cameraOrientTarget;
    if (!target) return;
    this.cameraRig.quaternion.slerp(target, 0.15);
    if (this.cameraRig.quaternion.angleTo(target) < 1e-3) {
      this.cameraRig.quaternion.copy(target);
      this.cameraOrientTarget = null;
    }
  }

  public clearChatSelection(): void {
    if (!this.chatAnnotationSelection.clear()) return;
    this.updateChatSelectionVisuals();
  }

  public getChatSelection(): string[] {
    return this.chatAnnotationSelection.getSelectedIds();
  }

  private removeChatSelectionId(annotationId: string): void {
    if (!this.chatAnnotationSelection.remove(annotationId)) return;
    this.updateChatSelectionVisuals();
  }

  private updateChatSelectionVisuals(): void {
    for (const annotation of this.annotations) {
      const selected = this.chatAnnotationSelection.has(annotation.apartmentId);
      annotation.element.classList.toggle("annotation-container--chat-selected", selected);
      if (!annotation.helper) continue;

      if (!annotation.helperBaseColor) {
        const material = annotation.helper.material as THREE.LineBasicMaterial;
        annotation.helperBaseColor = material.color.clone();
      }
      const material = annotation.helper.material as THREE.LineBasicMaterial;
      material.color.copy(selected
        ? SplatViewer.CHAT_SELECTED_COLOR
        : annotation.helperBaseColor);
    }
  }

  public async removeAnnotation(annotation: ViewerAnnotation): Promise<void> {
    const index = this.annotations.indexOf(annotation);
    if (index < 0) return;
    this.annotations.splice(index, 1);
    this.removeAnnotationVisual(annotation);
    if (annotation.selectionOwner && annotation.selectionId !== undefined) {
      await annotation.selectionOwner.clear(annotation.selectionId);
    }
  }

  public async loadWorld(url: string): Promise<boolean> {
    const generation = ++this.worldGeneration;
    this.chatController?.setSceneStatus("loading");
    this.clearWorldResources();

    const splat = new SplatMesh({ url });
    splat.quaternion.set(1, 0, 0, 0);
    splat.position.set(0, -1.5, 0);
    this.currentSplat = splat;
    this.scene.add(splat);

    try {
      await splat.initialized;
      if (generation !== this.worldGeneration) {
        this.disposeSplat(splat);
        return false;
      }

      const highlighter = ENABLE_GAUSSIAN_HIGHLIGHTING && isNonLodSplat(splat)
        ? await GaussianObjectHighlighter.create(splat)
        : null;
      if (generation !== this.worldGeneration) {
        highlighter?.dispose();
        this.disposeSplat(splat);
        return false;
      }

      this.objectHighlighter = highlighter;
      // Fresh scene inventory per world. Semantic metadata is loaded from the
      // scene-keyed JSON store after the world is ready, so another world can
      // never leak into this registry.
      this.spatialRegistry = new SpatialObjectRegistry();
      this.annotationMetadataStore = this.createAnnotationMetadataStore(url);
      const storedAnnotations = this.loadStoredAnnotations();
      // Persisted IDs seed the monotonic sequence; a page/session reload can
      // therefore never reuse an existing annotation ID for this scene.
      this.annotationSequence = Math.max(
        this.annotationSequence,
        this.annotationMetadataStore?.maxAnnotationSequence() ?? 0,
      );
      for (const record of storedAnnotations) this.restoreStoredAnnotation(record);
      this.splatLoaded = true;
      this.chatController?.setSceneStatus("ready");
      return true;
    } catch (error) {
      if (generation !== this.worldGeneration) {
        this.disposeSplat(splat);
        return false;
      }
      if (this.currentSplat === splat) this.clearWorldResources();
      else this.disposeSplat(splat);
      if (generation === this.worldGeneration) this.chatController?.setSceneStatus("unavailable");
      throw error;
    }
  }
  /**
   * Core splat raycast shared by the click path and box sampling. Returns the
   * camera ray plus the nearest intersection, or null when no splat is loaded.
   */
  private splatRay(
    normalizedX: number,
    normalizedY: number,
  ): { ray: THREE.Ray; intersection: THREE.Intersection | null } | null {
    // 1. Convert normalized 0-1 to NDC (-1 to 1)
    const ndcX = normalizedX * 2 - 1;
    const ndcY = -(normalizedY * 2 - 1);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    // 2. Intersect with the SplatMesh
    if (this.currentSplat) {
      const intersects = raycaster.intersectObject(this.currentSplat);
      return {
        ray: raycaster.ray,
        intersection: intersects.length > 0 ? intersects[0] : null,
      };
    }
    return null;
  }

  private getAnnotationPosition(
    normalizedX: number,
    normalizedY: number,
  ): THREE.Vector3 | null {
    return this.splatRay(normalizedX, normalizedY)?.intersection?.point ?? null;
  }
  // Create a simple UI helper function
  // private createAnnotationElement(position: THREE.Vector3, label: string) {
  //   const div = document.createElement("div");
  //   div.className = "annotation-label";
  //   div.innerText = label;
  //   div.style.position = "absolute";
  //   div.style.zIndex = "1000"; // Ensure it's on top of canvas
  //   div.style.pointerEvents = "none"; // So clicks pass through
  //   div.style.backgroundColor = "rgba(0,0,0,0.6)";
  //   div.style.color = "white";
  //   div.style.padding = "4px 8px";
  //   div.style.borderRadius = "4px";
  //   document.body.appendChild(div);

  //   this.annotations.push({ element: div, position });
  // }
  private createAnnotationElement(
    position: THREE.Vector3,
    label: string,
    options: {
      annotationId?: string;
      description?: string;
      metadata?: AnnotationMetadata;
      dimensions?: DimensionSet;
      worldObb?: OBB;
      localObb?: OBB;
      selectionOwner?: GaussianObjectHighlighter;
      selectionId?: number;
      persistMetadata?: boolean;
    } = {},
  ): ViewerAnnotation {
    const container = document.createElement("div");
    container.className = "annotation-container";
    const pin = document.createElement("div");
    pin.className = "annotation-pin";
    const labelButton = document.createElement("button");
    labelButton.type = "button";
    labelButton.className = "annotation-label";
    labelButton.textContent = label;

    const card = document.createElement("div");
    card.className = "annotation-card";
    card.style.display = "none";
    const title = document.createElement("h3");
    title.textContent = label;
    card.appendChild(title);
    if (options.dimensions) {
      const dimensions = document.createElement("p");
      dimensions.textContent = [
        options.dimensions.width,
        options.dimensions.height,
        options.dimensions.depth,
      ].map((value) => `${value.toFixed(2)}m`).join(" × ");
      card.appendChild(dimensions);
    }
    if (options.description) {
      const description = document.createElement("p");
      description.textContent = options.description;
      card.appendChild(description);
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-btn";
    closeBtn.textContent = "Close";
    card.appendChild(closeBtn);

    const toggleCard = (event: MouseEvent) => {
      event.stopPropagation();
      card.style.display = card.style.display === "none" ? "block" : "none";
    };
    pin.onclick = toggleCard;
    labelButton.onclick = toggleCard;
    container.append(pin, labelButton, card);

    const requestedAnnotationId = options.annotationId?.trim();
    if (requestedAnnotationId && !/^annotation-\d+$/.test(requestedAnnotationId)) {
      throw new TypeError(`Invalid persisted annotation ID: ${requestedAnnotationId}`);
    }
    if (requestedAnnotationId) {
      const sequence = Number(/annotation-(\d+)$/.exec(requestedAnnotationId)?.[1]);
      if (Number.isFinite(sequence)) {
        this.annotationSequence = Math.max(this.annotationSequence, sequence);
      }
    } else {
      this.annotationSequence += 1;
    }
    const annotation: ViewerAnnotation = {
      element: container,
      position: position.clone(),
      apartmentId: requestedAnnotationId ?? `annotation-${this.annotationSequence}`,
      selectionOwner: options.selectionOwner,
      selectionId: options.selectionId,
      worldGeneration: this.worldGeneration,
    };
    // Close only hides the card; the annotation and its data stay in the scene.
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      card.style.display = "none";
    });

    if (options.worldObb && options.localObb) {
      const colorId = ((options.selectionId ?? this.annotationSequence) - 1) % 255 + 1;
      const color = defaultGaussianMaskColor(colorId);
      annotation.worldObb = new OBB(options.worldObb);
      this.registerApartment(annotation.apartmentId, annotation.worldObb);

      if (this.currentSplat) {
        const box = new THREE.BoxGeometry(
          options.localObb.size.x,
          options.localObb.size.y,
          options.localObb.size.z,
        );
        const edges = new THREE.EdgesGeometry(box);
        box.dispose();
        const helperMaterial = new THREE.LineBasicMaterial({
          color: new THREE.Color().setRGB(...color),
        });
        const helper = new THREE.LineSegments(edges, helperMaterial);
        helper.position.copy(options.localObb.position);
        helper.quaternion.copy(options.localObb.quaternion);
        helper.visible = false;
        this.currentSplat.add(helper);
        annotation.helper = helper;
        annotation.helperBaseColor = helperMaterial.color.clone();

        if (ENABLE_GAUSSIAN_HIGHLIGHTING && !options.selectionOwner) {
          const fallback = new HoverTint(this.currentSplat, {
            space: "splat",
            color,
            strength: 0.65,
            feather: 0,
          });
          fallback.setHovered(options.localObb);
          annotation.fallbackTint = fallback;
        }
      }
    }

    document.body.appendChild(container);
    this.annotations.push(annotation);
    const effectiveDescription = options.description ?? options.metadata?.description;
    this.registerAnnotation(annotation, {
      label,
      description: effectiveDescription,
      metadata: options.metadata,
      clusterObb: Boolean(annotation.worldObb),
    });
    if (options.persistMetadata !== false) {
      this.persistAnnotationMetadata(annotation, label, effectiveDescription, options.metadata, options.dimensions);
    }
    this.chatController?.inventoryChanged();
    return annotation;
  }

  /**
   * Registry data contract (Phase 0, registry integration):
   * - `objectId` is the canonical `apartmentId` (`annotation-N`); the Gaussian
   *   mask ID is never exposed as a registry ID.
   * - `semanticLabel` is the annotation label; `description` (VLM free text)
   *   and `obb` (`"cluster"` fitted OBB vs `"point"` pin-only fallback) ride
   *   in `attributes`.
   * - Cluster-fitted annotations store their world OBB; pin-only fallbacks
   *   store a zero-size point OBB at the pin position, so later spatial
   *   predicates can exclude them via the `obb` attribute.
   * Registration must not break the annotation flow, so contract violations
   * are logged instead of thrown.
   */
  private registerAnnotation(
    annotation: ViewerAnnotation,
    details: {
      label: string;
      description?: string;
      metadata?: AnnotationMetadata;
      clusterObb: boolean;
    },
  ): void {
    if (!this.spatialRegistry) return;
    try {
      this.spatialRegistry.register({
        objectId: annotation.apartmentId,
        semanticLabel: details.label,
        metadata: details.metadata,
        attributes: {
          ...deriveSearchAttributes(details.label, details.description),
          ...(details.description ? { description: details.description } : {}),
          ...details.metadata?.attributes,
          obb: details.clusterObb ? "cluster" : "point",
        },
        // The registry stores defensive clones; `!` is safe: a cluster-fitted
        // annotation always has `worldObb` assigned before this call.
        worldObb: details.clusterObb
          ? annotation.worldObb!
          : new OBB({
              position: annotation.position,
              size: new THREE.Vector3(0, 0, 0),
            }),
      });
    } catch (error) {
      console.error(`[registry] Failed to register ${annotation.apartmentId}:`, error);
    }
  }

  private createAnnotationMetadataStore(url: string): SceneAnnotationMetadataStore | null {
    try {
      return createSceneAnnotationMetadataStore(url);
    } catch (error) {
      console.error("[annotation-metadata] Persistent metadata storage is unavailable:", error);
      return null;
    }
  }

  private loadStoredAnnotations(): SceneAnnotationRecord[] {
    if (!this.annotationMetadataStore) return [];
    try {
      return this.annotationMetadataStore.list();
    } catch (error) {
      console.error("[annotation-metadata] Failed to load scene annotations:", error);
      return [];
    }
  }

  private restoreStoredAnnotation(record: SceneAnnotationRecord): void {
    try {
      const position = new THREE.Vector3(record.position.x, record.position.y, record.position.z);
      const storedObb = record.geometry.kind === "cluster" ? record.geometry.obb : undefined;
      const worldObb = storedObb
        ? new OBB({
            position: new THREE.Vector3(storedObb.position.x, storedObb.position.y, storedObb.position.z),
            quaternion: new THREE.Quaternion(
              storedObb.quaternion.x,
              storedObb.quaternion.y,
              storedObb.quaternion.z,
              storedObb.quaternion.w,
            ),
            size: new THREE.Vector3(storedObb.size.x, storedObb.size.y, storedObb.size.z),
          })
        : undefined;
      const localObb = worldObb && this.currentSplat
        ? obbWorldToLocal(worldObb, this.currentSplat)
        : undefined;
      this.createAnnotationElement(position, record.label, {
        annotationId: record.annotationId,
        description: record.description,
        metadata: record.metadata,
        dimensions: record.dimensions,
        worldObb,
        localObb,
        persistMetadata: false,
      });
    } catch (error) {
      console.error(`[annotation-metadata] Failed to restore ${record.annotationId}:`, error);
    }
  }

  private persistAnnotationMetadata(
    annotation: ViewerAnnotation,
    label: string,
    description: string | undefined,
    metadata: AnnotationMetadata | undefined,
    annotationDimensions: DimensionSet | undefined,
  ): void {
    if (!this.annotationMetadataStore) return;
    try {
      this.annotationMetadataStore.save(createSceneAnnotationRecord({
        annotationId: annotation.apartmentId,
        label,
        description,
        metadata,
        position: annotation.position,
        worldObb: annotation.worldObb,
        dimensions: annotationDimensions,
      }));
    } catch (error) {
      console.error(`[annotation-metadata] Failed to save ${annotation.apartmentId}:`, error);
    }
  }

  private sanitizeDetectionBox(
    box: AnnotationDetection["box"],
  ): AnnotationDetection["box"] | null {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
    const [ymin, xmin, ymax, xmax] = box.map((value) =>
      Math.min(1, Math.max(0, value))
    ) as AnnotationDetection["box"];
    if (xmax - xmin < 0.02 || ymax - ymin < 0.02) return null;
    return [ymin, xmin, ymax, xmax];
  }

  /** Sample world-space ray hits; WebGL depth readback is deliberately avoided. */
  private samplePointsFromBox(
    box: AnnotationDetection["box"],
    probes?: SampleCellProbe[],
  ): THREE.Vector3[] {
    const [ymin, xmin, ymax, xmax] = box;
    const nonLod = this.currentSplat ? isNonLodSplat(this.currentSplat) : false;
    const gridSize = computeSampleGridSize(box, nonLod);
    const points: THREE.Vector3[] = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const x = xmin + ((col + 0.5) / gridSize) * (xmax - xmin);
        const y = ymin + ((row + 0.5) / gridSize) * (ymax - ymin);
        const cast = this.splatRay(x, y);
        if (probes) {
          probes.push({
            row,
            col,
            normalizedX: x,
            normalizedY: y,
            rayOrigin: cast ? cast.ray.origin.clone() : null,
            rayDirection: cast ? cast.ray.direction.clone() : null,
            intersection: cast?.intersection ?? null,
          });
        }
        const point = cast?.intersection?.point;
        if (point) points.push(point);
      }
    }
    return points;
  }

  private async annotateFromDetection(
    detection: AnnotationDetection,
    clickWorldPosAtClick: THREE.Vector3 | null,
  ): Promise<ViewerAnnotation | null> {
    const generation = this.worldGeneration;
    const diagnostics = this.annotationDiagnostics;
    // Every stage of runDetectionPipeline reports into the recorder (dev only).
    const recorder = diagnostics?.beginDetection(detection) ?? null;
    try {
      return await this.runDetectionPipeline(detection, clickWorldPosAtClick, recorder, generation);
    } finally {
      if (recorder) diagnostics?.endDetection(recorder);
    }
  }

  private async runDetectionPipeline(
    detection: AnnotationDetection,
    clickWorldPosAtClick: THREE.Vector3 | null,
    recorder: DetectionRecorder | null,
    generation: number,
  ): Promise<ViewerAnnotation | null> {
    const splat = this.currentSplat;
    if (!splat || !this.splatLoaded) {
      recorder?.failure("world", "no splat loaded");
      return null;
    }
    const box = this.sanitizeDetectionBox(detection.box);
    recorder?.sanitize(box as NormalizedBox | null);
    if (!box) {
      console.warn("Discarding invalid or tiny detection bounding box.", detection.box);
      return null;
    }

    const metadata = parseAnnotationMetadata(detection.metadata);
    const semanticDescription = detection.description ?? metadata?.description;
    const nonLod = isNonLodSplat(splat);
    const probes: SampleCellProbe[] | undefined = this.annotationDiagnostics ? [] : undefined;
    const sampledPoints = this.samplePointsFromBox(box, probes);
    recorder?.sampling(computeSampleGridSize(box, nonLod), probes ?? []);
    const dbscanParams = { eps: 0.3, minPts: nonLod ? 10 : 4 };
    let clusterReport: DBSCANClusterReport | null = null;
    const measured = this.geometricContext.registerAndMeasureObject(
      detection.label,
      sampledPoints,
      {
        ...dbscanParams,
        ...(recorder
          ? {
              onClusters: (report: DBSCANClusterReport) => {
                clusterReport = report;
              },
            }
          : {}),
      },
    );
    recorder?.clustering(sampledPoints, clusterReport, dbscanParams);
    if (measured) {
      recorder?.measurement(measured);
      const fit = fitOBB(measured.points);
      if (fit) recorder?.obb(fit);
      const fmt = (v: number) => Number(v.toFixed(3));
      console.log(`[cluster-debug] ${detection.label}`, {
        box,
        sampledRayHits: sampledPoints.length,
        clusterPoints: measured.points.length,
        clusterDims: {
          w: fmt(measured.dimensions.width),
          h: fmt(measured.dimensions.height),
          d: fmt(measured.dimensions.depth),
        },
        centroid: measured.centroid.toArray().map(fmt),
        obbMethod: fit?.method,
        obbSize: fit?.obb.size.toArray().map(fmt),
        obbEigenvalues: fit?.eigenvalues.map((e) => Number(e.toExponential(3))),
      });
      if (fit) {
        // Only the fallback/helper use world-to-local conversion; lifting stays world-space.
        const local = obbWorldToLocal(fit.obb, splat);
        const owner = this.objectHighlighter;
        const selection = owner
          ? await owner.select(fit.obb, { minOpacity: 0.05 })
          : null;
        recorder?.lift(
          selection,
          owner ? null : "Gaussian highlighter disabled (ENABLE_GAUSSIAN_HIGHLIGHTING off)",
        );
        if (selection) {
          console.log(`[cluster-debug] ${detection.label} lift`, {
            selected: selection.selectedIds.length,
            of: selection.lift.numSplats,
            candidates: selection.lift.candidates,
            opacityRejected: selection.lift.opacityRejected,
          });
        }
        if (owner && (!selection || generation !== this.worldGeneration)) {
          recorder?.failure("lift", "selection invalidated before commit (world changed or cleared)");
          return null;
        }
        if (generation !== this.worldGeneration || this.currentSplat !== splat) {
          recorder?.failure("lift", "world changed during lift; annotation aborted");
          return null;
        }

        const annotation = this.createAnnotationElement(
          measured.centroid,
          measured.label,
          {
            description: semanticDescription,
            metadata,
            dimensions: measured.dimensions,
            worldObb: fit.obb,
            localObb: local,
            selectionOwner: owner ?? undefined,
            selectionId: selection?.objectId,
          },
        );
        recorder?.anchor(measured.centroid, "cluster-centroid");
        recorder?.attach(annotation.apartmentId);
        this.lastClusterFit = {
          world: new OBB(fit.obb),
          local,
          points: measured.points,
          method: fit.method,
          objectId: selection?.objectId,
        };
        return annotation;
      }
      recorder?.failure("obb", "fitOBB returned null");
    }

    const fallbackPosition = clickWorldPosAtClick ?? this.getAnnotationPosition(
      (box[1] + box[3]) / 2,
      (box[0] + box[2]) / 2,
    );
    if (!fallbackPosition) {
      console.warn(`Lifting failed for ${detection.label}`);
      recorder?.failure("anchor", "no fallback position (no click hit, box-centre raycast missed)");
      return null;
    }
    recorder?.anchor(
      fallbackPosition,
      clickWorldPosAtClick ? "click-hit" : "box-centre-raycast",
    );
    const annotation = this.createAnnotationElement(fallbackPosition, detection.label, {
      description: semanticDescription,
      metadata,
    });
    recorder?.attach(annotation.apartmentId);
    return annotation;
  }

private async captureSnapshot(): Promise<string> {
    // 1. Force a render to ensure scene is up to date
    this.renderer.render(this.scene, this.camera);
    
    // 2. Wait for GPU buffer sync
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    // 3. Optional: Force GPU finish if necessary (very safe, prevents black screens)
    this.renderer.getContext().finish(); 
    
    return this.renderer.domElement.toDataURL("image/jpeg", 0.7);
}
// public async requestAnnotationFromGemini(box: number[]) {
//     try {
//         // const dataUrl = this.renderer.domElement.toDataURL("image/jpeg", 0.7);
//         const dataUrl = await this.captureSnapshot();
//         const headers: Record<string, string> = { "Content-Type": "application/json" };

//         if (BYPASS_TUNNEL_REMINDER) {
//           headers["bypass-tunnel-reminder"] = "true";
//         }

//         const endpoint = buildAnnotateEndpoint(API_BASE_URL);

//         const response = await fetch(endpoint, {
//             method: "POST",
//             headers,
//             body: JSON.stringify({ image: dataUrl, userBox: box }),
//         });

//         const data = await response.json();
        
//         if (data.objects && Array.isArray(data.objects)) {
//             data.objects.forEach((item: any) => {
//                 // item.label is now whatever the AI decided it was!
//                 console.log(`Annotating detected object: ${item.label} at box ${item.box}`);
//                 const label = item.label === "objects" ? "Detected Item" : item.label;
//                 const description = item.description === "objects" ? "Detected Item" : item.description;
//                 this.annotateDetectedObject(item.box, label, description);
//             });
//         }
//     } catch (err) {
//         console.error("Annotation Error:", err);
//     }
//   }
  public async requestAnnotationFromGemini(
    clickX: number,
    clickY: number,
    clickWorldPosAtClick: THREE.Vector3 | null,
  ): Promise<void> {
    const generation = this.worldGeneration;
    try {
      this.setAnnotationLoading(true);
      this.annotationDiagnostics?.beginRequest("click", generation);
      const dataUrl = await this.captureSnapshot();
      this.annotationDiagnostics?.recordSnapshot(dataUrl);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (BYPASS_TUNNEL_REMINDER) headers["bypass-tunnel-reminder"] = "true";

      const response = await fetch(buildAnnotateEndpoint(API_BASE_URL), {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: dataUrl,
          clickX,
          clickY,
        }),
      });

      if (!response.ok) throw new Error("Server error");
      const data = await response.json();
      this.annotationDiagnostics?.recordResponse(data);
      const detections: AnnotationDetection[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.objects)
          ? data.objects
          : [];
      if (!Array.isArray(data) && !Array.isArray(data?.objects)) {
        console.warn("Expected annotation response array or data.objects array.", data);
      }

      for (const detection of detections) {
        if (generation !== this.worldGeneration) return;
        if (!detection?.label || !Array.isArray(detection.box) || detection.box.length !== 4) continue;
        await this.annotateFromDetection(detection, clickWorldPosAtClick);
      }
    } catch (err) {
      if (generation === this.worldGeneration) console.error("Museum Mode Error:", err);
    } finally {
      this.annotationDiagnostics?.closeRequest();
      if (generation === this.worldGeneration) this.setAnnotationLoading(false);
    }
  }
}

// Create singleton instance
export const viewer = new SplatViewer();

// Export loadWorld for compatibility with main.ts
export async function loadWorld(url: string) {
  return viewer.loadWorld(url);
}

// Initial load
const initialURL = "/Apartment.sog";
// const initialURL = "/BiltmoreGaussianSplat.sog";
void loadWorld(initialURL).catch((error) => console.error("Initial world load failed:", error));

// DEV-only deterministic detection seam; no Gemini request is made by inject().
if (import.meta.env.DEV) {
  (window as any).__sl = {
    viewer,
    THREE,
    get splat() { return (viewer as any).currentSplat; },
    get camera() { return (viewer as any).camera; },
    get ready() { return (viewer as any).splatLoaded; },
    get mode() { return (viewer as any).objectHighlighter ? "index-mask" : "obb-fallback"; },
    get lastFit() { return viewer.lastClusterFit; },
    get selections() { return (viewer as any).objectHighlighter?.list() ?? []; },
    get annotationCount() { return (viewer as any).annotations.length; },
    get registry() {
      const registry: SpatialObjectRegistry | null = (viewer as any).spatialRegistry;
      return registry ? { size: registry.size, objects: registry.list() } : null;
    },
    get spatialRegistry() { return (viewer as any).spatialRegistry; },
    get chatSelection() { return viewer.getChatSelection(); },
    /**
     * Task 1 development-only pipeline diagnostics (see
     * src/diagnostics/AnnotationDiagnostics.ts). Use last()/list() for the
     * structured per-request records, toggle()/toggleOverlay() for visibility.
     */
    get diagnostics() { return (viewer as any).annotationDiagnostics ?? null; },
    /**
     * Phase 1 local object search (DEV-only seam): runs the deterministic
     * label/attribute matcher (src/spatial/ObjectMatcher.ts) over the current
     * per-world registry. No Gemini, no viewer state changes. Returns null
     * between worlds; otherwise the SearchResult contract of
     * src/spatial/types.ts (see docs/chat-object-search-phase-1-matching.md).
     */
    search(query: SearchQuery, options?: SearchOptions) {
      const registry: SpatialObjectRegistry | null = (viewer as any).spatialRegistry;
      if (!registry) return null;
      return searchObjects(registry.list(), query, options);
    },
    get shaderErrors() { return [...(viewer as any).shaderErrors]; },
    glError() { return (viewer as any).renderer.getContext().getError(); },
    capture() {
      const v = viewer as any;
      v.renderer.render(v.scene, v.camera);
      return v.renderer.domElement.toDataURL("image/png");
    },
    async inject(
      label: string,
      box: [number, number, number, number],
      metadata?: unknown,
    ) {
      await (viewer as any).annotateFromDetection({ label, description: "test", box, metadata }, null);
      return viewer.lastClusterFit;
    },
    async clearAll() { await viewer.clearAllSelections(); },
    async clearOne(selectionId: number) {
      const annotation = (viewer as any).annotations.find(
        (item: ViewerAnnotation) => item.selectionId === selectionId,
      );
      if (annotation) await viewer.removeAnnotation(annotation);
    },
    async load(url: string) { return viewer.loadWorld(url); },
  };
}
