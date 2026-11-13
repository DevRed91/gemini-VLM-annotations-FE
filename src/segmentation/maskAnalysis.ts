import type { RleMask } from "./contract.ts";

export interface MaskStats {
  /** Foreground pixel count. */
  readonly area: number;
  /** area / (width*height). */
  readonly areaFraction: number;
  /** Tight foreground bounds in pixels (xmax/ymax inclusive), or null when empty. */
  readonly bbox: { xmin: number; ymin: number; xmax: number; ymax: number } | null;
  readonly centroid: { x: number; y: number } | null;
  /** True when the foreground touches any image border (often means a clipped or background-sized mask). */
  readonly touchesBorder: boolean;
}

/** Decode to one byte per pixel (1 = foreground). */
export function decodeRle(mask: RleMask): Uint8Array {
  const out = new Uint8Array(mask.width * mask.height);
  let pos = 0;
  let value = 0;
  for (const count of mask.counts) {
    if (value === 1) out.fill(1, pos, pos + count);
    pos += count;
    value ^= 1;
  }
  return out;
}

export function encodeRle(width: number, height: number, pixels: ArrayLike<number>): RleMask {
  const counts: number[] = [];
  let current = 0;
  let run = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const v = pixels[i] ? 1 : 0;
    if (v === current) run++;
    else {
      counts.push(run);
      current = v;
      run = 1;
    }
  }
  counts.push(run);
  return { width, height, counts };
}

export function maskStats(mask: RleMask): MaskStats {
  const { width, height } = mask;
  let area = 0;
  let sx = 0;
  let sy = 0;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  let pos = 0;
  let value = 0;
  for (const count of mask.counts) {
    if (value === 1 && count > 0) {
      // A run may wrap across rows; walk it row segment by row segment.
      let start = pos;
      const end = pos + count;
      while (start < end) {
        const y = Math.floor(start / width);
        const x = start - y * width;
        const segEnd = Math.min(end, (y + 1) * width);
        const len = segEnd - start;
        area += len;
        sx += len * (x + (len - 1) / 2);
        sy += len * y;
        if (x < xmin) xmin = x;
        if (x + len - 1 > xmax) xmax = x + len - 1;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
        start = segEnd;
      }
    }
    pos += count;
    value ^= 1;
  }
  if (area === 0) {
    return { area: 0, areaFraction: 0, bbox: null, centroid: null, touchesBorder: false };
  }
  return {
    area,
    areaFraction: area / (width * height),
    bbox: { xmin, ymin, xmax, ymax },
    centroid: { x: sx / area, y: sy / area },
    touchesBorder: xmin === 0 || ymin === 0 || xmax === width - 1 || ymax === height - 1,
  };
}

/** Is the pixel under (x, y) foreground? Out-of-image points are never inside. */
export function maskContains(mask: RleMask, x: number, y: number): boolean {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
  const target = py * mask.width + px;
  let pos = 0;
  let value = 0;
  for (const count of mask.counts) {
    if (target < pos + count) return value === 1;
    pos += count;
    value ^= 1;
  }
  return false;
}

/** Intersection-over-union of two same-size masks; null when both are empty or sizes differ. */
export function maskIou(a: RleMask, b: RleMask): number | null {
  if (a.width !== b.width || a.height !== b.height) return null;
  const da = decodeRle(a);
  const db = decodeRle(b);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < da.length; i++) {
    if (da[i] && db[i]) inter++;
    if (da[i] || db[i]) union++;
  }
  return union === 0 ? null : inter / union;
}
