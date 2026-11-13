import * as THREE from "three";
import { buildDetectionGroup, disposeObjectTree } from "../diagnostics/markers.ts";
import type { DetectionDiagnostics } from "../diagnostics/types.ts";

/**
 * Scene D overlay: the pipeline *after* the rays, revealed one stage at a time.
 * It renders production's own recorded diagnostics (the same records and the
 * same marker builder the diagnostics overlay uses), so nothing here is
 * recomputed or re-implemented. Kept in its own group so it can be shown while
 * the full diagnostics overlay stays hidden.
 *
 *   0 hidden
 *   1 sampling   production's sample-grid hits
 *   2 DBSCAN     + clusters, noise, selected cluster
 *   3 OBB        + measurement bounds and the fitted OBB
 *   (Gaussian highlighting is production's own; stage 3 keeps it visible and
 *    the HUD reports whether it is enabled and how many Gaussians it selected.)
 */

export type StageLevel = 0 | 1 | 2 | 3;
export const STAGE_NAMES: Readonly<Record<StageLevel, string>> = {
  0: "off",
  1: "sampling",
  2: "sampling + DBSCAN",
  3: "sampling + DBSCAN + OBB",
};

/** Strip every stage after `level` from a record; pure, never mutates the input. */
export function recordAtStage(record: DetectionDiagnostics, level: StageLevel): DetectionDiagnostics {
  return {
    ...record,
    clustering: level >= 2 ? record.clustering : null,
    measurement: level >= 3 ? record.measurement : null,
    obb: level >= 3 ? record.obb : null,
    anchor: null,
    lift: null,
  };
}

function signatureOf(record: DetectionDiagnostics): string {
  return `${record.sampling ? 1 : 0}${record.clustering ? 1 : 0}${record.measurement ? 1 : 0}${record.obb ? 1 : 0}`;
}

export class StageOverlay {
  readonly group = new THREE.Group();
  private level: StageLevel = 0;
  private built: THREE.Group | null = null;
  private record: DetectionDiagnostics | null = null;
  private signature = "";

  constructor() {
    this.group.name = "demo-stage-overlay";
  }

  stage(): StageLevel {
    return this.level;
  }

  setRecord(record: DetectionDiagnostics | null): void {
    this.record = record;
    this.signature = record ? signatureOf(record) : "";
    this.rebuild();
  }

  /**
   * Called from the HUD refresh. Diagnostics records are filled in place as
   * pipeline stages complete, so identity alone is not enough: rebuild only
   * when the record or the set of completed stages changes.
   */
  setRecordIfChanged(record: DetectionDiagnostics): void {
    if (record === this.record && signatureOf(record) === this.signature) return;
    this.setRecord(record);
  }

  setStage(level: StageLevel): void {
    this.level = level;
    this.rebuild();
  }

  /** off -> 1 -> 2 -> 3 -> off */
  cycle(): StageLevel {
    this.setStage(((this.level + 1) % 4) as StageLevel);
    return this.level;
  }

  clear(): void {
    this.record = null;
    this.signature = "";
    this.level = 0;
    this.rebuild();
  }

  private rebuild(): void {
    if (this.built) {
      disposeObjectTree(this.built);
      this.built = null;
    }
    if (this.level === 0 || !this.record) return;
    const built = buildDetectionGroup(recordAtStage(this.record, this.level));
    built.traverse((object) => {
      object.frustumCulled = false;
    });
    this.built = built;
    this.group.add(built);
  }

  dispose(): void {
    if (this.built) disposeObjectTree(this.built);
    this.built = null;
    disposeObjectTree(this.group);
  }
}
