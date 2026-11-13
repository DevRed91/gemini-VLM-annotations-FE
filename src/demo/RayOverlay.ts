import * as THREE from "three";
import { disposeObjectTree, makeOctahedronMarker, makeRayLine, makeSphereMarker, makeTextLabel } from "../diagnostics/markers.ts";

/**
 * DEV-only 3D overlay for the demo: frozen snapshot rays (green) and the
 * live-camera reference rays (orange). Pure presentation: it never raycasts
 * itself and never touches production state.
 */

export const SNAPSHOT_RAY_COLOR = 0x2ee86a;
export const LIVE_RAY_COLOR = 0xff7a1a;
export const LIVE_LABEL = "LIVE CAMERA REFERENCE — NOT PRODUCTION SAMPLING";

const MISS_RAY_LENGTH = 6;

export interface RayEntry {
  readonly origin: THREE.Vector3;
  readonly direction: THREE.Vector3;
  /** World-space splat hit; null if the ray hit nothing. */
  readonly hit: THREE.Vector3 | null;
}

export class RayOverlay {
  readonly group = new THREE.Group();
  private snapshotGroup: THREE.Group | null = null;
  private readonly liveSegments: THREE.LineSegments;
  private readonly livePoints: THREE.Points;
  private readonly liveLabel: THREE.Sprite;
  private readonly tickObject: THREE.Points;
  private readonly liveCount: number;
  private disposed = false;

  constructor(liveCount: number, onTick: () => void) {
    this.liveCount = liveCount;
    this.group.name = "demo-ray-overlay";

    // Live reference rays: buffers allocated once, rewritten in place, so a
    // long recording session never allocates per frame.
    const segmentGeometry = new THREE.BufferGeometry();
    segmentGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(liveCount * 6), 3));
    this.liveSegments = new THREE.LineSegments(
      segmentGeometry,
      new THREE.LineBasicMaterial({ color: LIVE_RAY_COLOR, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.liveSegments.frustumCulled = false;
    this.liveSegments.renderOrder = 11;
    this.liveSegments.visible = false;

    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(liveCount * 3), 3));
    this.livePoints = new THREE.Points(
      pointGeometry,
      new THREE.PointsMaterial({ color: LIVE_RAY_COLOR, size: 0.06, sizeAttenuation: true, depthTest: false, transparent: true }),
    );
    this.livePoints.frustumCulled = false;
    this.livePoints.renderOrder = 12;
    this.livePoints.visible = false;

    this.liveLabel = makeTextLabel(LIVE_LABEL, { colorHex: LIVE_RAY_COLOR, worldHeight: 0.07 });
    this.liveLabel.visible = false;

    // Per-frame hook without a second animation loop: three.js calls
    // onBeforeRender for every rendered object, inside the viewer's own loop.
    // The material is fully transparent so the object costs nothing visually.
    const tickGeometry = new THREE.BufferGeometry();
    tickGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    this.tickObject = new THREE.Points(
      tickGeometry,
      new THREE.PointsMaterial({ size: 0, transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
    );
    this.tickObject.frustumCulled = false;
    this.tickObject.onBeforeRender = () => {
      if (!this.disposed) onTick();
    };

    this.group.add(this.liveSegments, this.livePoints, this.liveLabel, this.tickObject);
  }

  /** Replace the frozen snapshot rays (disposing the previous set). */
  setSnapshotRays(entries: readonly RayEntry[], cameraPosition: THREE.Vector3): void {
    this.clearSnapshotRays();
    const group = new THREE.Group();
    group.name = "demo-snapshot-rays";
    for (const entry of entries) {
      const end = entry.hit ?? entry.origin.clone().addScaledVector(entry.direction, MISS_RAY_LENGTH);
      group.add(makeRayLine(entry.origin, end.clone().sub(entry.origin).normalize(), end.distanceTo(entry.origin), SNAPSHOT_RAY_COLOR, 0.9));
      if (entry.hit) group.add(makeSphereMarker(entry.hit, SNAPSHOT_RAY_COLOR, 0.03));
    }
    group.add(makeOctahedronMarker(cameraPosition, SNAPSHOT_RAY_COLOR, 0.07));
    const label = makeTextLabel("SNAPSHOT CAMERA (frozen)", { colorHex: SNAPSHOT_RAY_COLOR, worldHeight: 0.07 });
    label.position.copy(cameraPosition).add(new THREE.Vector3(0, 0.14, 0));
    group.add(label);
    group.traverse((object) => {
      object.frustumCulled = false;
    });
    this.snapshotGroup = group;
    this.group.add(group);
  }

  clearSnapshotRays(): void {
    if (this.snapshotGroup) {
      disposeObjectTree(this.snapshotGroup);
      this.snapshotGroup = null;
    }
  }

  hasSnapshotRays(): boolean {
    return this.snapshotGroup !== null;
  }

  setSnapshotVisible(visible: boolean): void {
    if (this.snapshotGroup) this.snapshotGroup.visible = visible;
  }

  /** In-place update of the live reference rays. */
  updateLive(entries: readonly RayEntry[]): void {
    const segments = this.liveSegments.geometry.getAttribute("position") as THREE.BufferAttribute;
    const points = this.livePoints.geometry.getAttribute("position") as THREE.BufferAttribute;
    const n = Math.min(entries.length, this.liveCount);
    for (let i = 0; i < this.liveCount; i++) {
      const entry = i < n ? entries[i] : null;
      if (!entry) {
        segments.setXYZ(i * 2, 0, 0, 0);
        segments.setXYZ(i * 2 + 1, 0, 0, 0);
        points.setXYZ(i, 0, 0, 0);
        continue;
      }
      const end = entry.hit ?? entry.origin.clone().addScaledVector(entry.direction, MISS_RAY_LENGTH);
      segments.setXYZ(i * 2, entry.origin.x, entry.origin.y, entry.origin.z);
      segments.setXYZ(i * 2 + 1, end.x, end.y, end.z);
      if (entry.hit) {
        points.setXYZ(i, entry.hit.x, entry.hit.y, entry.hit.z);
      } else {
        // Park misses on the ray origin so no stray point is drawn at (0,0,0).
        points.setXYZ(i, entry.origin.x, entry.origin.y, entry.origin.z);
      }
    }
    segments.needsUpdate = true;
    points.needsUpdate = true;
    // Label sits on the centre ray's far end.
    const centre = entries[Math.floor(n / 2)];
    if (centre) {
      const anchor = centre.hit ?? centre.origin.clone().addScaledVector(centre.direction, MISS_RAY_LENGTH);
      this.liveLabel.position.copy(anchor).add(new THREE.Vector3(0, 0.12, 0));
    }
  }

  setLiveVisible(visible: boolean): void {
    this.liveSegments.visible = visible;
    this.livePoints.visible = visible;
    this.liveLabel.visible = visible;
  }

  isLiveVisible(): boolean {
    return this.liveSegments.visible;
  }

  /** Remove the group from its parent and release every GPU resource. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tickObject.onBeforeRender = () => {};
    this.clearSnapshotRays();
    disposeObjectTree(this.group);
  }
}
