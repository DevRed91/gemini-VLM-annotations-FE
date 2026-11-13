/**
 * Camera settle detection for the DEV-only demo harness. Pure: no THREE, no
 * DOM, no clock of its own (the caller passes `nowMs`), so every behaviour is
 * unit-testable and deterministic.
 *
 * The detector watches the *sampled camera state*, not input events, so motion
 * from keyboard, pointer, touch, programmatic controls or the viewer's own
 * slerp (orientCameraToAnnotation) is all seen the same way.
 *
 * Comparison is always against an ANCHOR pose (the last pose accepted as
 * "where the camera is"), never against the previous frame. A drift that is
 * individually below tolerance every frame therefore still accumulates past
 * the tolerance and counts as movement; floating-point jitter around the
 * anchor never does.
 */

export interface CameraSample {
  /** World-space camera position. */
  readonly position: readonly [number, number, number];
  /** World-space camera orientation, unit quaternion [x, y, z, w]. */
  readonly quaternion: readonly [number, number, number, number];
  /** Projection state that changes which ray a pixel maps to. */
  readonly fov: number;
  readonly aspect: number;
  readonly zoom: number;
  readonly near: number;
  readonly far: number;
}

export interface SettleConfig {
  /** The pose must stay inside tolerance for this long to count as settled. */
  readonly stableMs: number;
  /** World units. 1e-4 m (0.1 mm) is far above float32 matrix noise. */
  readonly positionTolerance: number;
  /** Radians. 1e-4 rad ≈ 0.006°. */
  readonly orientationTolerance: number;
  /** Absolute tolerance on fov (degrees), aspect, zoom, near, far. */
  readonly configTolerance: number;
}

export const DEFAULT_SETTLE_CONFIG: SettleConfig = {
  stableMs: 300,
  positionTolerance: 1e-4,
  orientationTolerance: 1e-4,
  configTolerance: 1e-6,
};

export interface PoseChange {
  readonly position: number;
  readonly orientation: number;
  readonly config: number;
}

/**
 * Angle in radians between two unit quaternions (q and -q are the same
 * rotation). Computed from the relative rotation with atan2 rather than
 * acos(dot): acos amplifies float error near 1 (acos(1 - 1e-16) ~ 1.5e-8),
 * which would make the noise floor depend on the pose.
 */
export function quaternionAngle(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const w = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const x = a[3] * b[0] - b[3] * a[0] - (a[1] * b[2] - a[2] * b[1]);
  const y = a[3] * b[1] - b[3] * a[1] - (a[2] * b[0] - a[0] * b[2]);
  const z = a[3] * b[2] - b[3] * a[2] - (a[0] * b[1] - a[1] * b[0]);
  return 2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w));
}

export function poseChange(a: CameraSample, b: CameraSample): PoseChange {
  return {
    position: Math.hypot(
      a.position[0] - b.position[0],
      a.position[1] - b.position[1],
      a.position[2] - b.position[2],
    ),
    orientation: quaternionAngle(a.quaternion, b.quaternion),
    config: Math.max(
      Math.abs(a.fov - b.fov),
      Math.abs(a.aspect - b.aspect),
      Math.abs(a.zoom - b.zoom),
      Math.abs(a.near - b.near),
      Math.abs(a.far - b.far),
    ),
  };
}

export function isMeaningfulChange(change: PoseChange, config: SettleConfig): boolean {
  return (
    change.position > config.positionTolerance ||
    change.orientation > config.orientationTolerance ||
    change.config > config.configTolerance ||
    // NaN means a corrupt sample; treat it as movement rather than "stable".
    Number.isNaN(change.position + change.orientation + change.config)
  );
}

export interface SettleState {
  /** Pose the camera is currently considered to be at. Null before the first sample. */
  readonly anchor: CameraSample | null;
  /** performance-clock time the anchor was (re)established. */
  readonly stableSince: number;
  /** True once the settle event has been emitted for this anchor. */
  readonly fired: boolean;
}

export const INITIAL_SETTLE_STATE: SettleState = { anchor: null, stableSince: 0, fired: false };

/**
 *  - "none":    nothing to report.
 *  - "moved":   meaningful movement relative to the anchor (any previous settled
 *               measurement is now out of date). Emitted once per movement
 *               frame, never while stationary.
 *  - "settled": the pose has been stable for `stableMs`. Emitted exactly once
 *               per stationary period.
 */
export type SettleEvent = "none" | "moved" | "settled";

export function stepSettle(
  state: SettleState,
  sample: CameraSample,
  nowMs: number,
  config: SettleConfig = DEFAULT_SETTLE_CONFIG,
): { state: SettleState; event: SettleEvent } {
  if (!state.anchor) {
    return { state: { anchor: sample, stableSince: nowMs, fired: false }, event: "none" };
  }
  if (isMeaningfulChange(poseChange(state.anchor, sample), config)) {
    return { state: { anchor: sample, stableSince: nowMs, fired: false }, event: "moved" };
  }
  if (!state.fired && nowMs - state.stableSince >= config.stableMs) {
    return { state: { ...state, fired: true }, event: "settled" };
  }
  return { state, event: "none" };
}

/** Thin stateful wrapper around stepSettle. */
export class SettleDetector {
  private state: SettleState = INITIAL_SETTLE_STATE;
  readonly config: SettleConfig;

  constructor(config: Partial<SettleConfig> = {}) {
    this.config = { ...DEFAULT_SETTLE_CONFIG, ...config };
  }

  update(sample: CameraSample, nowMs: number): SettleEvent {
    const result = stepSettle(this.state, sample, nowMs, this.config);
    this.state = result.state;
    return result.event;
  }

  /** True between the "settled" event and the next "moved" event. */
  isSettled(): boolean {
    return this.state.fired;
  }

  /** Forget the anchor; the next sample starts a fresh stationary period. */
  reset(): void {
    this.state = INITIAL_SETTLE_STATE;
  }
}
