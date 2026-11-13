import type { NormalizedBox } from "./driftMath.ts";

/**
 * DEV-only seam around the `/annotate` request, used to make the three demo
 * inference modes reproducible without touching production code:
 *
 *  1  LIVE GEMINI   real request, real response, applied immediately.
 *  2  DELAYED       real request, real response, response *held* for delayMs
 *                   before the pipeline sees it. The delay is artificial and
 *                   the HUD says so.
 *  3  HAND BOX      NO model call. The pipeline receives a stubbed response
 *                   containing a hand-specified box. It still runs the real
 *                   request path, sampling, DBSCAN, OBB and lifting.
 *
 * Only requests whose URL path ends in `/annotate` are touched; every other
 * fetch is passed through untouched.
 */

export type InferenceMode = 1 | 2 | 3;

export interface InferenceConfig {
  mode: InferenceMode;
  /** Artificial hold applied in mode 2 only, milliseconds. */
  delayMs: number;
  /** Box used by mode 3, [ymin, xmin, ymax, xmax] normalized to the snapshot image. */
  handBox: NormalizedBox;
  handLabel: string;
}

export const DEFAULT_INFERENCE_CONFIG: Readonly<InferenceConfig> = Object.freeze({
  mode: 1,
  delayMs: 4000,
  handBox: [0.35, 0.4, 0.65, 0.6] as NormalizedBox,
  handLabel: "hand-specified object",
});

export interface DetectionSummary {
  readonly label: string;
  readonly box: NormalizedBox | null;
}

export type InferenceEvent =
  | { type: "request"; at: number; mode: InferenceMode }
  | { type: "response"; at: number; mode: InferenceMode; latencyMs: number; detections: DetectionSummary[]; synthetic: boolean }
  | { type: "held"; at: number; delayMs: number }
  | { type: "released"; at: number; heldMs: number }
  | { type: "cancelled"; at: number }
  | { type: "error"; at: number; message: string };

export interface InferenceSeamDeps {
  fetch: typeof fetch;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  onEvent: (event: InferenceEvent) => void;
}

export interface InferenceSeam {
  readonly fetch: typeof fetch;
  config(): Readonly<InferenceConfig>;
  update(patch: Partial<InferenceConfig>): void;
  /** Reject every in-flight delayed request (AbortError) and clear its timer. */
  cancelPending(): number;
  pendingCount(): number;
}

export function isAnnotateUrl(input: unknown): boolean {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (typeof input === "object" && input !== null && typeof (input as Request).url === "string") {
    raw = (input as Request).url;
  } else return false;
  const path = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return path.endsWith("/annotate");
}

function summarize(data: unknown): DetectionSummary[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { objects?: unknown }).objects)
      ? (data as { objects: unknown[] }).objects
      : [];
  return list.map((item) => {
    const entry = item as { label?: unknown; box?: unknown };
    const box = Array.isArray(entry.box) && entry.box.length === 4 && entry.box.every(Number.isFinite)
      ? (entry.box as unknown as NormalizedBox)
      : null;
    return { label: typeof entry.label === "string" ? entry.label : "?", box };
  });
}

function abortError(): Error {
  const error = new Error("Demo reset cancelled the pending annotation request");
  error.name = "AbortError";
  return error;
}

export function createInferenceSeam(
  deps: InferenceSeamDeps,
  initial: Partial<InferenceConfig> = {},
): InferenceSeam {
  const cfg: InferenceConfig = { ...DEFAULT_INFERENCE_CONFIG, ...initial };
  const pending = new Map<number, { handle: unknown; reject: (e: Error) => void }>();
  let nextId = 0;

  const hold = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++;
      const handle = deps.setTimeout(() => {
        pending.delete(id);
        resolve();
      }, ms);
      pending.set(id, { handle, reject });
    });

  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isAnnotateUrl(input)) return deps.fetch(input, init);
    const mode = cfg.mode;
    const started = deps.now();
    deps.onEvent({ type: "request", at: started, mode });
    try {
      if (mode === 3) {
        const [ymin, xmin, ymax, xmax] = cfg.handBox;
        const body = { objects: [{ label: cfg.handLabel, description: "hand-specified box (demo)", box: [ymin, xmin, ymax, xmax] }] };
        deps.onEvent({ type: "response", at: deps.now(), mode, latencyMs: 0, detections: summarize(body), synthetic: true });
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const response = await deps.fetch(input, init);
      const latencyMs = deps.now() - started;
      let detections: DetectionSummary[] = [];
      try {
        detections = summarize(await response.clone().json());
      } catch {
        /* non-JSON or error body: the pipeline reports it itself */
      }
      deps.onEvent({ type: "response", at: deps.now(), mode, latencyMs, detections, synthetic: false });
      if (mode === 2 && cfg.delayMs > 0) {
        deps.onEvent({ type: "held", at: deps.now(), delayMs: cfg.delayMs });
        const heldFrom = deps.now();
        await hold(cfg.delayMs);
        deps.onEvent({ type: "released", at: deps.now(), heldMs: deps.now() - heldFrom });
      }
      return response;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") deps.onEvent({ type: "cancelled", at: deps.now() });
      else deps.onEvent({ type: "error", at: deps.now(), message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }) as typeof fetch;

  return {
    fetch: wrapped,
    config: () => ({ ...cfg, handBox: [...cfg.handBox] as unknown as NormalizedBox }),
    update(patch) {
      if (patch.mode !== undefined && ![1, 2, 3].includes(patch.mode)) throw new RangeError("mode must be 1, 2 or 3");
      if (patch.delayMs !== undefined && !(patch.delayMs >= 0 && Number.isFinite(patch.delayMs))) {
        throw new RangeError("delayMs must be a finite, non-negative number");
      }
      Object.assign(cfg, patch);
    },
    cancelPending() {
      const count = pending.size;
      for (const [id, entry] of pending) {
        deps.clearTimeout(entry.handle);
        entry.reject(abortError());
        pending.delete(id);
      }
      return count;
    },
    pendingCount: () => pending.size,
  };
}
