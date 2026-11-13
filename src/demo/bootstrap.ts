import { SplatMesh } from "@sparkjsdev/spark";
import { DemoController, type DemoHost, type DemoOptions } from "./DemoController.ts";
import type { InferenceMode } from "./inferenceSeam.ts";
import type { NormalizedBox } from "./driftMath.ts";
import { isDemoInferenceSuppressed } from "../utils/inferenceSuppression.ts";

/**
 * Entry point of the DEV-only demo harness. Reached ONLY through
 *   if (import.meta.env.DEV && ?demo=1) import("./demo/bootstrap.ts")
 * in src/script.ts, so a production build contains none of src/demo/.
 *
 * URL parameters (all optional):
 *   present=1           presentation mode: hide the engineering HUD, show the Front/Side/Top capture UI
 *   mode=1|2|3          inference mode (default 1)
 *   inference=off       suppress scene-click Gemini requests; snapshots and measurements remain active
 *   delay=<ms>          mode 2 artificial delay (default 4000)
 *   box=ymin,xmin,ymax,xmax   mode 3 hand-specified box
 *   live=ray|hits       live reference rays. DEFAULT ray = camera-only (no splat
 *                       cast). hits = legacy per-frame splat cast (~35 ms/ray).
 *   settle=<ms>         camera-settle duration before the 9-ray measurement (default 300)
 *   liveInterval=<ms>   minimum ms between live-ray updates (default: every frame)
 */

function parseOptions(search: string): DemoOptions {
  const params = new URLSearchParams(search);
  const options: DemoOptions = {};
  options.inferenceEnabled = !isDemoInferenceSuppressed(search, true);
  if (params.get("present") === "1") options.presentation = true;
  const mode = Number(params.get("mode"));
  if (mode === 1 || mode === 2 || mode === 3) options.mode = mode as InferenceMode;
  const delay = Number(params.get("delay"));
  if (params.has("delay") && Number.isFinite(delay) && delay >= 0) options.delayMs = delay;
  const box = params.get("box")?.split(",").map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite)) options.handBox = box as unknown as NormalizedBox;
  const live = params.get("live");
  if (live === "hits" || live === "ray") options.liveMode = live;
  const settle = Number(params.get("settle"));
  if (params.has("settle") && Number.isFinite(settle) && settle >= 0) options.settleMs = settle;
  const interval = Number(params.get("liveInterval"));
  if (params.has("liveInterval") && Number.isFinite(interval) && interval >= 0) options.liveIntervalMs = interval;
  return options;
}

export function installDemo(viewer: unknown, apiBaseUrl = "/api", bypassTunnelReminder = false): DemoController {
  if (!import.meta.env.DEV) throw new Error("The demo harness is development-only");
  const existing = (window as unknown as { __demo?: DemoController }).__demo;
  existing?.dispose();
  // The viewer's relevant members are TypeScript-private; the demo only reads
  // them (see DemoHost). One cast, here, instead of `any` throughout.
  const host = viewer as DemoHost & { liveWorldState(): ReturnType<DemoHost["liveWorldState"]> };
  const controller = new DemoController(host, {
    ...parseOptions(window.location.search),
    apiBaseUrl,
    bypassTunnelReminder,
    // Real Spark readiness flag; raycast silently returns no hits until it is true.
    staticInitialized: () => SplatMesh.isStaticInitialized,
  });
  (window as unknown as { __demo: DemoController }).__demo = controller;
  return controller;
}
