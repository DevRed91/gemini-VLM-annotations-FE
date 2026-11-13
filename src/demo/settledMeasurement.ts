import { SettleDetector, type CameraSample, type SettleConfig } from "./settle.ts";

/**
 * Settled nine-ray measurement lifecycle (DEV-only demo harness). THREE-free
 * and DOM-free: the splat cast, readiness check, camera sampler and clocks are
 * injected, so tests can count casts exactly.
 *
 * Contract:
 *   - camera moving            -> zero casts
 *   - camera settles           -> exactly one cast per cell
 *   - camera stays still       -> zero further casts
 *   - camera moves + settles   -> one new set of casts
 * A measurement made before the camera moved again is kept, marked STALE, with
 * its original timestamp; it is never presented as a current comparison.
 */

export type Point3 = readonly [number, number, number];

export interface CastResult {
  readonly origin: Point3;
  readonly direction: Point3;
  /** World-space splat hit, or null on a miss. */
  readonly hit: Point3 | null;
}

export interface MeasureCell {
  readonly x: number;
  readonly y: number;
}

export interface SettledMeasurement {
  readonly sequence: number;
  readonly cells: readonly MeasureCell[];
  readonly rays: readonly { readonly origin: Point3; readonly direction: Point3 }[];
  readonly hits: readonly (Point3 | null)[];
  /** Camera pose at the moment of measurement. */
  readonly pose: CameraSample;
  /** performance.now() at measurement start (same clock as the detector). */
  readonly measuredAtMs: number;
  /** Wall-clock ISO timestamp, for display and logs. */
  readonly measuredAtIso: string;
  /** Total execution cost of all casts, ms. */
  readonly durationMs: number;
  /** Annotation helpers present when the measurement ran (contamination risk). */
  readonly helperCountAtMeasurement: number;
  readonly status: "current" | "stale";
  /** Present only when stale. */
  readonly staleReason?: string;
  readonly staledAtMs?: number;
}

export type MeasureStatus =
  | "no-snapshot" // nothing to measure against
  | "waiting-for-camera" // camera moving / not yet stable
  | "waiting-for-splat" // settled, but raycasting is not ready
  | "measured"; // a current measurement exists

export interface MeasurerDeps {
  sample(): CameraSample;
  /** Real splat raycast readiness (see readiness.ts). Casting earlier silently returns misses. */
  isReady(): boolean;
  cast(x: number, y: number): CastResult | null;
  nowMs(): number;
  wallClockIso(): string;
  helperCount(): number;
  settle?: Partial<SettleConfig>;
}

export class SettledMeasurer {
  private readonly deps: MeasurerDeps;
  private readonly detector: SettleDetector;
  private cells: readonly MeasureCell[] = [];
  private measurement: SettledMeasurement | null = null;
  private pending = false;
  private sequence = 0;
  private totalCasts = 0;

  constructor(deps: MeasurerDeps) {
    this.deps = deps;
    this.detector = new SettleDetector(deps.settle);
  }

  /** Call once per rendered frame. Cheap unless it triggers a measurement. */
  tick(): void {
    const nowMs = this.deps.nowMs();
    const event = this.detector.update(this.deps.sample(), nowMs);
    if (event === "moved") {
      this.pending = false;
      this.markStale("camera moved", nowMs);
    } else if (event === "settled") {
      this.pending = true;
    }
    if (this.pending && this.cells.length > 0 && this.deps.isReady()) {
      this.pending = false;
      this.measure(nowMs);
    }
  }

  /**
   * The rays being compared changed (new snapshot or a new detection box).
   * Any existing measurement was for different cells, so it goes stale; if the
   * camera is already stationary, take one fresh measurement for the new cells.
   */
  setCells(cells: readonly MeasureCell[]): void {
    this.markStale("sampling cells changed", this.deps.nowMs());
    this.cells = cells.map((c) => ({ x: c.x, y: c.y }));
    this.pending = this.cells.length > 0 && this.detector.isSettled();
  }

  /** Forget everything (demo reset). Casts nothing. */
  reset(): void {
    this.cells = [];
    this.measurement = null;
    this.pending = false;
    this.detector.reset();
  }

  /** Drop the measurement and pending work but keep the camera anchor (e.g. snapshot cleared). */
  clearMeasurement(): void {
    this.cells = [];
    this.measurement = null;
    this.pending = false;
  }

  latest(): SettledMeasurement | null {
    return this.measurement;
  }

  status(): MeasureStatus {
    if (this.cells.length === 0) return "no-snapshot";
    if (this.measurement?.status === "current") return "measured";
    if (this.pending) return "waiting-for-splat";
    return "waiting-for-camera";
  }

  /** Total splat casts this measurer has ever issued. */
  castCount(): number {
    return this.totalCasts;
  }

  private markStale(reason: string, nowMs: number): void {
    const current = this.measurement;
    if (!current || current.status === "stale") return;
    this.measurement = { ...current, status: "stale", staleReason: reason, staledAtMs: nowMs };
  }

  private measure(nowMs: number): void {
    const pose = this.deps.sample();
    const started = this.deps.nowMs();
    const rays: { origin: Point3; direction: Point3 }[] = [];
    const hits: (Point3 | null)[] = [];
    for (const cell of this.cells) {
      this.totalCasts++;
      const cast = this.deps.cast(cell.x, cell.y);
      rays.push(cast ? { origin: cast.origin, direction: cast.direction } : { origin: [0, 0, 0], direction: [0, 0, 0] });
      hits.push(cast?.hit ?? null);
    }
    const durationMs = this.deps.nowMs() - started;
    this.measurement = {
      sequence: ++this.sequence,
      cells: this.cells,
      rays,
      hits,
      pose,
      measuredAtMs: nowMs,
      measuredAtIso: this.deps.wallClockIso(),
      durationMs,
      helperCountAtMeasurement: this.deps.helperCount(),
      status: "current",
    };
  }
}
