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
import { HoverTint, OBB, pickNearestOBB } from "./utils/hoverTint";
import { fitOBB, obbWorldToLocal } from "./utils/obbFit";
import GeometricContextManager, {
  filterDepthOutliers,
} from "./GeometricContextManager/GeometricContextManager";
import { GaussianObjectHighlighter } from "./utils/gaussianObjectHighlighter";
import { defaultGaussianMaskColor } from "./utils/gaussianMaskManager";
import { isNonLodSplat } from "./utils/gaussianIndexSupport";
// import { OrbitControls } from "three/examples/jsm/Addons.js";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ||
  "/api";
const BYPASS_TUNNEL_REMINDER =
  (import.meta.env.VITE_BYPASS_TUNNEL_REMINDER as string | undefined) === "true";

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

interface AnnotationDetection {
  label: string;
  description?: string;
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
  private hoverTint: HoverTint | null = null;
  private objectHighlighter: GaussianObjectHighlighter | null = null;
  private worldGeneration = 0;
  private annotationSequence = 0;
  private readonly disposedSplats = new WeakSet<SplatMesh>();
  private readonly geometricContext = new GeometricContextManager();
  private apartments: { id: string; obb: OBB; source?: THREE.Object3D; geomSize?: THREE.Vector3 }[] = [];
  private hoveredApartment: { id: string; obb: OBB } | null = null;
  private hoverRaycaster = new THREE.Raycaster();
  private readonly shaderErrors: string[] = [];
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
    // this.setupSelectionBox();
    this.setupClickInteraction();
    this.setupHoverInteraction();
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
      this.camera.updateMatrixWorld(); 
      this.syncApartmentOBBs();
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

  /** Keep OBBs that track a live object current. */
  private syncApartmentOBBs() {
    let hoveredMoved = false;
    for (const apt of this.apartments) {
      if (!apt.source || !apt.geomSize) continue;
      const before = apt.obb.getWorldMatrix().elements.join() + apt.obb.size.toArray().join();
      apt.obb.syncFromObject3D(apt.source, apt.geomSize);
      const after = apt.obb.getWorldMatrix().elements.join() + apt.obb.size.toArray().join();
      if (before !== after && apt.id === this.hoveredApartment?.id) hoveredMoved = true;
    }
    if (hoveredMoved && this.hoverTint) {
      this.hoverTint.refresh();
      this.currentSplat?.updateVersion();
    }
  }

  private setupClickInteraction() {
    this.renderer.domElement.addEventListener("click", (e) => {
      // Only trigger if a specific tool is active (optional)
      if (!this.isSelecting) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const clickWorldPos = this.getAnnotationPosition(x, y);

      console.log(`User clicked at: x=${x.toFixed(2)}, y=${y.toFixed(2)}`);
      
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

  private setupHoverInteraction() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointermove", (e) => {
      if (!this.hoverTint) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.hoverRaycaster.setFromCamera(ndc, this.camera);
      const hit = pickNearestOBB(this.hoverRaycaster.ray, this.apartments);
      if (hit?.id === this.hoveredApartment?.id) return;
      this.hoveredApartment = hit;
      console.log("[hover]", hit?.id ?? null, hit?.obb.size.toArray());
      this.hoverTint.setHovered(hit ? hit.obb : null);
    });
    canvas.addEventListener("pointerleave", () => {
      this.hoveredApartment = null;
      this.hoverTint?.setHovered(null);
    });
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

  private removeAnnotationVisual(annotation: ViewerAnnotation): void {
    annotation.element.remove();
    this.apartments = this.apartments.filter((item) => item.id !== annotation.apartmentId);
    if (this.hoveredApartment?.id === annotation.apartmentId) {
      this.hoveredApartment = null;
      this.hoverTint?.setHovered(null);
    }
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

  private clearAnnotationVisuals(): void {
    for (const annotation of this.annotations) this.removeAnnotationVisual(annotation);
    this.annotations = [];
    this.hoveredApartment = null;
    this.hoverTint?.setHovered(null);
  }

  private clearWorldResources(): void {
    this.clearAnnotationVisuals();
    this.hoverTint?.dispose();
    this.hoverTint = null;
    this.objectHighlighter?.dispose();
    this.objectHighlighter = null;
    if (this.currentSplat) this.disposeSplat(this.currentSplat);
    this.currentSplat = null;
    this.splatLoaded = false;
    this.lastClusterFit = null;
  }

  public async clearAllSelections(): Promise<void> {
    const owner = this.objectHighlighter;
    this.clearAnnotationVisuals();
    this.lastClusterFit = null;
    await owner?.clearAll();
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

      const highlighter = isNonLodSplat(splat)
        ? await GaussianObjectHighlighter.create(splat)
        : null;
      if (generation !== this.worldGeneration) {
        highlighter?.dispose();
        this.disposeSplat(splat);
        return false;
      }

      // Persistent label masking is installed before transient hover tint.
      this.objectHighlighter = highlighter;
      this.hoverTint = new HoverTint(splat);
      this.splatLoaded = true;
      return true;
    } catch (error) {
      if (generation !== this.worldGeneration) {
        this.disposeSplat(splat);
        return false;
      }
      if (this.currentSplat === splat) this.clearWorldResources();
      else this.disposeSplat(splat);
      throw error;
    }
  }
  private getAnnotationPosition(
    normalizedX: number,
    normalizedY: number,
  ): THREE.Vector3 | null {
    // 1. Convert normalized 0-1 to NDC (-1 to 1)
    const ndcX = normalizedX * 2 - 1;
    const ndcY = -(normalizedY * 2 - 1);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    // 2. Intersect with the SplatMesh
    if (this.currentSplat) {
      const intersects = raycaster.intersectObject(this.currentSplat);
      if (intersects.length > 0) {
        return intersects[0].point; // This is your 3D position
      }
    }
    return null;
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
      description?: string;
      dimensions?: DimensionSet;
      worldObb?: OBB;
      localObb?: OBB;
      selectionOwner?: GaussianObjectHighlighter;
      selectionId?: number;
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

    const annotation: ViewerAnnotation = {
      element: container,
      position: position.clone(),
      apartmentId: `annotation-${++this.annotationSequence}`,
      selectionOwner: options.selectionOwner,
      selectionId: options.selectionId,
      worldGeneration: this.worldGeneration,
    };
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.removeAnnotation(annotation);
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
        const helper = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(...color) }),
        );
        helper.position.copy(options.localObb.position);
        helper.quaternion.copy(options.localObb.quaternion);
        this.currentSplat.add(helper);
        annotation.helper = helper;

        if (!options.selectionOwner) {
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
    return annotation;
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
  private samplePointsFromBox(box: AnnotationDetection["box"]): THREE.Vector3[] {
    const [ymin, xmin, ymax, xmax] = box;
    const area = (xmax - xmin) * (ymax - ymin);
    const nonLod = this.currentSplat ? isNonLodSplat(this.currentSplat) : false;
    const minGridSize = 6;
    const maxGridSize = nonLod ? 25 : 6;
    const gridSize = Math.max(
      minGridSize,
      Math.min(maxGridSize, Math.round(minGridSize + (maxGridSize - minGridSize) * Math.sqrt(area))),
    );
    const points: THREE.Vector3[] = [];
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const x = xmin + ((col + 0.5) / gridSize) * (xmax - xmin);
        const y = ymin + ((row + 0.5) / gridSize) * (ymax - ymin);
        const point = this.getAnnotationPosition(x, y);
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
    const splat = this.currentSplat;
    if (!splat || !this.splatLoaded) return null;
    const box = this.sanitizeDetectionBox(detection.box);
    if (!box) {
      console.warn("Discarding invalid or tiny detection bounding box.", detection.box);
      return null;
    }

    const sampledPoints = filterDepthOutliers(
      this.samplePointsFromBox(box),
      this.camera.getWorldPosition(new THREE.Vector3()),
    );
    const measured = this.geometricContext.registerAndMeasureObject(
      detection.label,
      sampledPoints,
      { minPts: isNonLodSplat(splat) ? 10 : 4 }, // eps is adaptive to sample spacing
    );
    if (measured) {
      const fit = fitOBB(measured.points, { mode: "upright", dominantLayer: true });
      if (fit) {
        // Only the fallback/helper use world-to-local conversion; lifting stays world-space.
        const local = obbWorldToLocal(fit.obb, splat);
        const owner = this.objectHighlighter;
        const selection = owner
          ? await owner.select(fit.obb, { minOpacity: 0.05 })
          : null;
        if (owner && (!selection || generation !== this.worldGeneration)) return null;
        if (generation !== this.worldGeneration || this.currentSplat !== splat) return null;

        const annotation = this.createAnnotationElement(
          measured.centroid,
          measured.label,
          {
            description: detection.description,
            dimensions: measured.dimensions,
            worldObb: fit.obb,
            localObb: local,
            selectionOwner: owner ?? undefined,
            selectionId: selection?.objectId,
          },
        );
        this.lastClusterFit = {
          world: new OBB(fit.obb),
          local,
          points: measured.points,
          method: fit.method,
          objectId: selection?.objectId,
        };
        return annotation;
      }
    }

    const fallbackPosition = clickWorldPosAtClick ?? this.getAnnotationPosition(
      (box[1] + box[3]) / 2,
      (box[0] + box[2]) / 2,
    );
    if (!fallbackPosition) {
      console.warn(`Lifting failed for ${detection.label}`);
      return null;
    }
    return this.createAnnotationElement(fallbackPosition, detection.label, {
      description: detection.description,
    });
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
      const dataUrl = await this.captureSnapshot();
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
    get shaderErrors() { return [...(viewer as any).shaderErrors]; },
    glError() { return (viewer as any).renderer.getContext().getError(); },
    capture() {
      const v = viewer as any;
      v.renderer.render(v.scene, v.camera);
      return v.renderer.domElement.toDataURL("image/png");
    },
    async inject(label: string, box: [number, number, number, number]) {
      await (viewer as any).annotateFromDetection({ label, description: "test", box }, null);
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
