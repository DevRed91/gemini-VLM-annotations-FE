/**
 * Small safety primitives for the demo harness. DOM-free and clock-injected.
 */

/**
 * Two-step confirmation for a destructive action. `arm()` starts a window;
 * `confirm()` returns true at most once per arm, only inside that window. It
 * can never succeed without a prior arm(), so the destructive operation
 * cannot be reached implicitly (by reset, init, or a stray call).
 */
export class ConfirmGate {
  private armedAt: number | null = null;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(now: () => number, windowMs = 6000) {
    this.now = now;
    this.windowMs = windowMs;
  }

  arm(): void {
    this.armedAt = this.now();
  }

  cancel(): void {
    this.armedAt = null;
  }

  isArmed(): boolean {
    if (this.armedAt === null) return false;
    if (this.now() - this.armedAt > this.windowMs) {
      this.armedAt = null;
      return false;
    }
    return true;
  }

  /** Consumes the arm. */
  confirm(): boolean {
    const ok = this.isArmed();
    this.armedAt = null;
    return ok;
  }
}

export interface DiagnosticsLike {
  readonly isEnabled: boolean;
  setEnabled(enabled: boolean): void;
}

/**
 * Turns the diagnostics markers OFF while the demo is mounted and puts back
 * exactly the state that was there before. The production default is never
 * changed. Idempotent in both directions.
 */
export class DiagnosticsGuard {
  private previous: boolean | null = null;
  private readonly target: DiagnosticsLike | null;

  constructor(target: DiagnosticsLike | null) {
    this.target = target;
  }

  install(): void {
    if (!this.target || this.previous !== null) return;
    this.previous = this.target.isEnabled;
    this.target.setEnabled(false);
  }

  restore(): void {
    if (!this.target || this.previous === null) return;
    this.target.setEnabled(this.previous);
    this.previous = null;
  }
}
