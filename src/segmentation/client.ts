import {
  validateSegmentRequest,
  validateSegmentResponse,
  type PixelBox,
  type SegmentRequest,
  type SegmentResponse,
} from "./contract.ts";
import type { ViewInput } from "./experiment.ts";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Same base-URL rules as the production annotate endpoint (script.ts
 * buildAnnotateEndpoint): "/api" -> "/api/<name>", ".../annotate" is replaced,
 * an absolute host gets "/api/<name>".
 */
export function buildEndpoint(baseUrl: string, name: "annotate" | "segment"): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/annotate") || normalized.endsWith("/segment")) {
    return normalized.replace(/\/(annotate|segment)$/, `/${name}`);
  }
  if (normalized.endsWith("/api")) return `${normalized}/${name}`;
  if (normalized.startsWith("http")) return `${normalized}/api/${name}`;
  return `${normalized}/${name}`;
}

function headers(bypassTunnelReminder: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(bypassTunnelReminder ? { "bypass-tunnel-reminder": "true" } : {}),
  };
}

/** POST a SegmentRequest to the backend; validates both directions. */
export function makeSegmentFetcher(
  endpoint: string,
  fetchImpl: FetchLike,
  bypassTunnelReminder = false,
): (request: SegmentRequest) => Promise<SegmentResponse> {
  return async (request) => {
    validateSegmentRequest(request);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: headers(bypassTunnelReminder),
      body: JSON.stringify(request),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(`segment backend ${response.status}: ${body?.error ?? "request failed"}`);
    }
    return validateSegmentResponse(body, request);
  };
}

interface DetectedObject {
  label?: unknown;
  box?: unknown;
}

/**
 * From Gemini detections (boxes are normalized [ymin, xmin, ymax, xmax]) pick
 * the smallest box that contains the point, converted to image pixels.
 * Returns null if no box contains it.
 */
export function pickBoxAroundPoint(
  objects: readonly DetectedObject[],
  u: number,
  v: number,
  imageWidth: number,
  imageHeight: number,
): PixelBox | null {
  let best: { area: number; box: PixelBox } | null = null;
  for (const object of objects) {
    const b = object.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    const [ymin, xmin, ymax, xmax] = b as number[];
    if (!(ymin < ymax) || !(xmin < xmax)) continue;
    if (u < xmin || u > xmax || v < ymin || v > ymax) continue;
    const area = (xmax - xmin) * (ymax - ymin);
    if (!best || area < best.area) {
      best = {
        area,
        box: { xmin: xmin * imageWidth, ymin: ymin * imageHeight, xmax: xmax * imageWidth, ymax: ymax * imageHeight },
      };
    }
  }
  return best?.box ?? null;
}

/**
 * Box source for the box variants: the EXISTING /api/annotate (Gemini) with
 * the projected anchor as the click. One Gemini call per view. The returned
 * box is therefore guided by the anchor's projection; it is the "semantic
 * box" baseline only in the sense that Gemini, not geometry, draws the box.
 */
export function makeBoxDetector(
  annotateEndpoint: string,
  fetchImpl: FetchLike,
  bypassTunnelReminder = false,
): (view: ViewInput, projected: { x: number; y: number }) => Promise<PixelBox | null> {
  return async (view, projected) => {
    const { image } = view.snapshot;
    const u = projected.x / image.width;
    const v = projected.y / image.height;
    const response = await fetchImpl(annotateEndpoint, {
      method: "POST",
      headers: headers(bypassTunnelReminder),
      body: JSON.stringify({ image: image.dataUrl, clickX: u, clickY: v }),
    });
    if (!response.ok) throw new Error(`annotate backend ${response.status}`);
    const data = (await response.json()) as unknown;
    const objects = Array.isArray(data)
      ? data
      : Array.isArray((data as { objects?: unknown })?.objects)
        ? (data as { objects: DetectedObject[] }).objects
        : [];
    return pickBoxAroundPoint(objects, u, v, image.width, image.height);
  };
}
