/**
 * Pure math for the DEV-only demo harness (no THREE, no DOM). Kept separate so
 * the numbers shown in the HUD are unit-testable.
 *
 * Matrices are column-major 16-element arrays, exactly THREE.Matrix4.elements.
 */

export type NormalizedBox = readonly [number, number, number, number]; // [ymin, xmin, ymax, xmax]
export type Vec3 = readonly [number, number, number];

export interface CameraDrift {
  /** Euclidean distance between the two camera positions, world units. */
  readonly translation: number;
  /** Smallest rotation angle between the two camera orientations, degrees. */
  readonly rotationDeg: number;
}

function column(m: ArrayLike<number>, c: number): [number, number, number] {
  const x = m[c * 4];
  const y = m[c * 4 + 1];
  const z = m[c * 4 + 2];
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** Camera drift between a frozen snapshot pose and the live pose. */
export function cameraDrift(snapshotWorld: ArrayLike<number>, liveWorld: ArrayLike<number>): CameraDrift {
  if (snapshotWorld.length !== 16 || liveWorld.length !== 16) {
    throw new RangeError("cameraDrift expects two 16-element matrices");
  }
  const translation = Math.hypot(
    liveWorld[12] - snapshotWorld[12],
    liveWorld[13] - snapshotWorld[13],
    liveWorld[14] - snapshotWorld[14],
  );
  // trace(Rs^T * Rl) = sum over columns of dot(snapshotCol, liveCol), with
  // columns normalised so any uniform scale on the camera chain is ignored.
  let trace = 0;
  for (let c = 0; c < 3; c++) {
    const a = column(snapshotWorld, c);
    const b = column(liveWorld, c);
    trace += a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }
  const cosine = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return { translation, rotationDeg: (Math.acos(cosine) * 180) / Math.PI };
}

export interface GridCell {
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Cell centres of an n x n grid over a [ymin, xmin, ymax, xmax] box. This is
 * the SAME formula as `SplatViewer.samplePointsFromBox` (src/script.ts), so a
 * 3x3 demo grid lands on cell centres exactly as production's grid does.
 * A test pins the formula against production's recorded cells.
 */
export function gridCells(box: NormalizedBox, gridSize: number): GridCell[] {
  if (!Number.isInteger(gridSize) || gridSize < 1) throw new RangeError("gridSize must be a positive integer");
  const [ymin, xmin, ymax, xmax] = box;
  const cells: GridCell[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      cells.push({
        row,
        col,
        x: xmin + ((col + 0.5) / gridSize) * (xmax - xmin),
        y: ymin + ((row + 0.5) / gridSize) * (ymax - ymin),
      });
    }
  }
  return cells;
}

/** Click-centred provisional box, clamped into the unit square. */
export function provisionalBox(x: number, y: number, halfSize = 0.08): NormalizedBox {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(y - halfSize), clamp(x - halfSize), clamp(y + halfSize), clamp(x + halfSize)];
}

export interface RayLike {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/**
 * Largest absolute component difference between two equally long ray lists
 * (origin and direction). 0 means bit-identical rays.
 */
export function maxRayDeviation(a: readonly RayLike[], b: readonly RayLike[]): number {
  if (a.length !== b.length) throw new RangeError("ray lists differ in length");
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < 3; k++) {
      worst = Math.max(
        worst,
        Math.abs(a[i].origin[k] - b[i].origin[k]),
        Math.abs(a[i].direction[k] - b[i].direction[k]),
      );
    }
  }
  return worst;
}

/** Mean Euclidean displacement between paired points; null entries are skipped. */
export function meanPairedDistance(
  a: readonly (Vec3 | null)[],
  b: readonly (Vec3 | null)[],
): { readonly mean: number; readonly pairs: number } | null {
  if (a.length !== b.length) throw new RangeError("point lists differ in length");
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (!p || !q) continue;
    sum += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    pairs++;
  }
  return pairs === 0 ? null : { mean: sum / pairs, pairs };
}

/** Rolling cost accumulator for the live-ray CPU measurement. */
export class CostMeter {
  private n = 0;
  private total = 0;
  private worst = 0;
  private lastValue = 0;
  record(ms: number): void {
    this.n++;
    this.total += ms;
    this.lastValue = ms;
    if (ms > this.worst) this.worst = ms;
  }
  reset(): void {
    this.n = 0;
    this.total = 0;
    this.worst = 0;
    this.lastValue = 0;
  }
  summary(): { count: number; meanMs: number; maxMs: number; lastMs: number } {
    return { count: this.n, meanMs: this.n ? this.total / this.n : 0, maxMs: this.worst, lastMs: this.lastValue };
  }
}

export function formatDrift(drift: CameraDrift): { position: string; rotation: string } {
  return {
    position: `${drift.translation.toFixed(3)} m`,
    rotation: `${drift.rotationDeg.toFixed(2)}°`,
  };
}
