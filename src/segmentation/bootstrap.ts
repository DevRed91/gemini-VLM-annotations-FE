import { buildEndpoint, makeBoxDetector, makeSegmentFetcher } from "./client.ts";
import type { ViewInput } from "./experiment.ts";
import { SegmentationController, type SegmentationHost } from "./SegmentationController.ts";
import { SegmentationPanel } from "./SegmentationPanel.ts";
import type { MultiViewObjectDetection, SelectedMultiViewObject } from "../demo/multiViewDetection.ts";
import type { ViewSnapshot } from "../viewer/ViewSnapshot.ts";

/**
 * Entry point of the DEV-only geometry-guided segmentation experiment.
 * Reached ONLY through
 *   if (import.meta.env.DEV && ?seg=1) import("./segmentation/bootstrap.ts")
 * in src/script.ts, so a production build contains none of src/segmentation/.
 *
 * It reads the Front/Side/Top presentation captures from the demo harness, so
 * open the viewer with  ?demo=1&present=1&inference=off&seg=1.
 */

interface DemoLike {
  state(): {
    presentation: {
      captures: ({ slot: string; snapshot: ViewSnapshot } | null)[];
      selectedObject?: SelectedMultiViewObject | null;
      detections?: readonly MultiViewObjectDetection[];
    } | null;
  };
}

export interface SegmentationHandle {
  controller: SegmentationController;
  panel: SegmentationPanel;
  dispose(): void;
}

export function installSegmentation(viewer: unknown, apiBase: string, bypassTunnelReminder: boolean): SegmentationHandle {
  if (!import.meta.env.DEV) throw new Error("The segmentation experiment is development-only");
  const existing = (window as unknown as { __seg?: SegmentationHandle }).__seg;
  existing?.dispose();

  const host = viewer as SegmentationHost;
  const getCaptures = (): ViewInput[] => {
    const demo = (window as unknown as { __demo?: DemoLike }).__demo;
    const captures = demo?.state().presentation?.captures ?? [];
    return captures.filter((c): c is { slot: string; snapshot: ViewSnapshot } => c !== null).map((c) => ({ slot: c.slot, snapshot: c.snapshot }));
  };
  const fetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => fetch(url, init);

  const controller = new SegmentationController({
    host,
    getCaptures,
    getSemanticSelection: () => {
      const presentation = ((window as unknown as { __demo?: DemoLike }).__demo)?.state().presentation;
      return presentation ? { selected: presentation.selectedObject ?? null, detections: presentation.detections ?? [] } : null;
    },
    segment: makeSegmentFetcher(buildEndpoint(apiBase, "segment"), fetchImpl, bypassTunnelReminder),
    detectBox: makeBoxDetector(buildEndpoint(apiBase, "annotate"), fetchImpl, bypassTunnelReminder),
  });
  const panel = new SegmentationPanel(controller);
  const handle: SegmentationHandle = {
    controller,
    panel,
    dispose() {
      panel.dispose();
      controller.dispose();
    },
  };
  (window as unknown as { __seg: SegmentationHandle }).__seg = handle;
  return handle;
}
