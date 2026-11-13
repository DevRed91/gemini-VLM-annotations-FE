/**
 * Provider-neutral segmentation contract (FE <-> BE `/api/segment`).
 *
 * COORDINATES: every point/box is in IMAGE PIXELS of the image being sent,
 * origin top-left, x right, y down (the same space as `ViewSnapshot.image`).
 * Masks come back at the same width/height as the request image.
 *
 * MASKS: run-length encoded, row-major, alternating run lengths that START
 * WITH BACKGROUND (so a mask whose first pixel is foreground begins with a 0
 * run). Sum of counts === width * height. A provider adapter that receives
 * PNG masks must convert them; the viewer never decodes provider-specific
 * formats.
 */

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
  /** 1 = foreground (include), 0 = background (exclude). */
  readonly label: 0 | 1;
}

export interface PixelBox {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
}

export interface SegmentPrompts {
  readonly text?: string;
  readonly points?: readonly PixelPoint[];
  readonly boxes?: readonly PixelBox[];
}

export interface SegmentRequest {
  /** data:image/(jpeg|png|webp);base64,... */
  readonly image: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly prompts: SegmentPrompts;
  /** Ask the provider for several candidate masks when it supports that. */
  readonly returnMultiple?: boolean;
}

export interface RleMask {
  readonly width: number;
  readonly height: number;
  readonly counts: readonly number[];
}

export interface SegmentedMask {
  readonly mask: RleMask;
  readonly score: number | null;
}

export interface SegmentResponse {
  readonly provider: string;
  /** True when the masks are synthetic and say nothing about SAM 3. */
  readonly mock: boolean;
  readonly masks: readonly SegmentedMask[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateSegmentRequest(req: SegmentRequest): void {
  if (typeof req.image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(req.image)) {
    throw new TypeError("SegmentRequest.image must be a base64 JPEG/PNG/WebP data URL");
  }
  if (!finite(req.imageWidth) || !finite(req.imageHeight) || req.imageWidth <= 0 || req.imageHeight <= 0) {
    throw new RangeError("SegmentRequest image dimensions must be positive");
  }
  const { text, points = [], boxes = [] } = req.prompts ?? {};
  if (!text?.trim() && points.length === 0 && boxes.length === 0) {
    throw new RangeError("SegmentRequest needs at least one of: text, points, boxes");
  }
  for (const p of points) {
    if (!finite(p.x) || !finite(p.y) || p.x < 0 || p.y < 0 || p.x > req.imageWidth || p.y > req.imageHeight) {
      throw new RangeError(`point (${p.x}, ${p.y}) is outside the ${req.imageWidth}x${req.imageHeight} image`);
    }
    if (p.label !== 0 && p.label !== 1) throw new RangeError("point label must be 0 or 1");
  }
  for (const b of boxes) {
    if (![b.xmin, b.ymin, b.xmax, b.ymax].every(finite) || !(b.xmin < b.xmax) || !(b.ymin < b.ymax) ||
        b.xmin < 0 || b.ymin < 0 || b.xmax > req.imageWidth || b.ymax > req.imageHeight) {
      throw new RangeError("box must satisfy 0 <= xmin < xmax <= width and 0 <= ymin < ymax <= height");
    }
  }
}

export function validateRleMask(value: unknown, expectedWidth?: number, expectedHeight?: number): RleMask {
  const m = value as Partial<RleMask> | null;
  if (!m || !finite(m.width) || !finite(m.height) || m.width <= 0 || m.height <= 0 || !Array.isArray(m.counts)) {
    throw new TypeError("mask must be { width, height, counts[] }");
  }
  if ((expectedWidth !== undefined && m.width !== expectedWidth) || (expectedHeight !== undefined && m.height !== expectedHeight)) {
    throw new RangeError(`mask is ${m.width}x${m.height}, expected ${expectedWidth}x${expectedHeight}`);
  }
  let total = 0;
  for (const c of m.counts) {
    if (!Number.isInteger(c) || c < 0) throw new RangeError("mask run lengths must be non-negative integers");
    total += c;
  }
  if (total !== m.width * m.height) {
    throw new RangeError(`mask runs sum to ${total}, expected ${m.width * m.height}`);
  }
  return { width: m.width, height: m.height, counts: m.counts };
}

export function validateSegmentResponse(value: unknown, request: SegmentRequest): SegmentResponse {
  const r = value as Partial<SegmentResponse> | null;
  if (!r || typeof r.provider !== "string" || typeof r.mock !== "boolean" || !Array.isArray(r.masks)) {
    throw new TypeError("segment response must be { provider, mock, masks[] }");
  }
  const masks = r.masks.map((item) => {
    const score = (item as SegmentedMask).score;
    if (score !== null && !finite(score)) throw new TypeError("mask score must be a number or null");
    return {
      mask: validateRleMask((item as SegmentedMask).mask, request.imageWidth, request.imageHeight),
      score,
    };
  });
  return { provider: r.provider, mock: r.mock, masks };
}
