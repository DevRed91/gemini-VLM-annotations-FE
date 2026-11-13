import * as THREE from "three";
import { disposeObjectTree, makeSphereMarker } from "../diagnostics/markers.ts";

/**
 * Static 3D comparison of the settled live hits against the snapshot-bound
 * hits. Built once per measurement (never per frame). A stale measurement is
 * HIDDEN rather than dimmed, so it can never be mistaken for a current
 * comparison; its numbers live on in the HUD, labelled STALE.
 */

export const SETTLED_HIT_COLOR = 0xe040fb;
export const SETTLED_PAIR_COLOR = 0xffffff;

export class SettledOverlay {
  readonly group = new THREE.Group();
  private content: THREE.Group | null = null;

  constructor() {
    this.group.name = "demo-settled-hits";
  }

  /** Replace the displayed comparison. `snapshotHits[i]` pairs with `settledHits[i]`. */
  show(
    settledHits: readonly (THREE.Vector3 | null)[],
    snapshotHits: readonly (THREE.Vector3 | null)[],
  ): void {
    this.clear();
    const content = new THREE.Group();
    content.name = "demo-settled-hit-points";
    settledHits.forEach((hit, i) => {
      if (!hit) return;
      content.add(makeSphereMarker(hit, SETTLED_HIT_COLOR, 0.025));
      const snap = snapshotHits[i];
      if (snap) {
        const geometry = new THREE.BufferGeometry().setFromPoints([snap, hit]);
        const line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({ color: SETTLED_PAIR_COLOR, depthTest: false, transparent: true, opacity: 0.8 }),
        );
        line.renderOrder = 10;
        content.add(line);
      }
    });
    content.traverse((object) => {
      object.frustumCulled = false;
    });
    this.content = content;
    this.group.add(content);
  }

  clear(): void {
    if (this.content) {
      disposeObjectTree(this.content);
      this.content.removeFromParent();
      this.content = null;
    }
  }

  isShowing(): boolean {
    return this.content !== null;
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
  }
}
