import type { PeerViewObservation, ViewObservation } from "../segmentation/multiViewGaussianLifter.ts";
import type { SelectedMultiViewObject } from "./multiViewDetection.ts";

/** Convert the confirmed Gemini boxes into the frozen-camera inputs used by the Gaussian lifter. */
export function buildLifterViewsFromSelection(selected: SelectedMultiViewObject): ViewObservation[] {
  return selected.captures.map((capture) => {
    const observation = selected.observations.find((entry) => entry.view === capture.slot) ?? null;
    const box = observation?.box ?? null;
    return {
      view: capture.slot,
      snapshot: capture.snapshot,
      visible: Boolean(box),
      ...(box ? { bboxNormalized: [box.yMin, box.xMin, box.yMax, box.xMax] as const } : {}),
    };
  });
}

/** Map sibling detections through the exact snapshots retained by the selection. */
export function buildPeerLifterViewsFromSelection(selected: SelectedMultiViewObject): PeerViewObservation[] {
  return selected.peerDetections.flatMap((peer) => selected.captures.map((capture) => {
    const observation = peer.observations.find((entry) => entry.view === capture.slot) ?? null;
    const box = observation?.box ?? null;
    return {
      objectId: peer.id,
      view: capture.slot,
      snapshot: capture.snapshot,
      visible: Boolean(box),
      ...(box ? { bboxNormalized: [box.yMin, box.xMin, box.yMax, box.xMax] as const } : {}),
    };
  }));
}
