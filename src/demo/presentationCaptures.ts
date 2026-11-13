import { validateViewSnapshot, type ViewSnapshot } from "../viewer/ViewSnapshot.ts";

/**
 * Presentation-mode capture slots. Slots are labels the presenter assigns by
 * hand; nothing here inspects a camera pose to decide which slot it "is".
 */
export const CAPTURE_SLOTS = [
  { id: "front", title: "Front", key: "Digit1" },
  { id: "side", title: "Side", key: "Digit2" },
  { id: "rear", title: "Rear", key: "Digit3" },
] as const;

export type CaptureSlotId = (typeof CAPTURE_SLOTS)[number]["id"];

export function isCaptureSlotId(value: unknown): value is CaptureSlotId {
  return CAPTURE_SLOTS.some((slot) => slot.id === value);
}

export function slotTitle(slot: CaptureSlotId): string {
  return CAPTURE_SLOTS.find((entry) => entry.id === slot)!.title;
}

/**
 * One manual capture. `snapshot` is the existing deep-frozen ViewSnapshot: it
 * owns the rendered JPEG data URL (an immutable string, so later camera
 * movement cannot change it) plus the camera position, orientation, world and
 * projection matrices taken in the same synchronous call as the pixels.
 */
export interface PresentationCapture {
  /** Unique per capture event (the snapshot's own UUID). */
  readonly id: string;
  readonly slot: CaptureSlotId;
  /** Epoch milliseconds when the capture completed. */
  readonly capturedAtMs: number;
  readonly capturedAtIso: string;
  readonly snapshot: ViewSnapshot;
}

export class PresentationCaptureStore {
  private readonly captures = new Map<CaptureSlotId, PresentationCapture>();

  /**
   * Assign a snapshot to one slot, replacing only that slot. The snapshot is
   * re-validated; a malformed one throws and leaves every slot untouched.
   */
  assign(slot: CaptureSlotId, snapshot: ViewSnapshot, nowMs: number): PresentationCapture {
    if (!isCaptureSlotId(slot)) throw new RangeError(`Unknown capture slot: ${String(slot)}`);
    validateViewSnapshot(snapshot);
    const capture: PresentationCapture = Object.freeze({
      id: snapshot.id,
      slot,
      capturedAtMs: nowMs,
      capturedAtIso: new Date(nowMs).toISOString(),
      snapshot,
    });
    this.captures.set(slot, capture);
    return capture;
  }

  get(slot: CaptureSlotId): PresentationCapture | null {
    return this.captures.get(slot) ?? null;
  }

  /** Captures in slot order (Front, Side, Rear); empty slots are null. */
  slots(): (PresentationCapture | null)[] {
    return CAPTURE_SLOTS.map((slot) => this.get(slot.id));
  }

  /** Number of filled slots, 0..3. */
  count(): number {
    return this.captures.size;
  }

  clear(): void {
    this.captures.clear();
  }

  /** Drop captures taken in a different world: their poses no longer describe this scene. */
  dropOtherWorlds(worldGeneration: number): number {
    let dropped = 0;
    for (const [slot, capture] of this.captures) {
      if (capture.snapshot.worldGeneration !== worldGeneration) {
        this.captures.delete(slot);
        dropped++;
      }
    }
    return dropped;
  }
}

/** "/scenes/Apartment.sog?x=1" → "Apartment". Falls back to the raw string, then "Scene". */
export function sceneLabelFromUrl(url: string | null | undefined): string {
  if (!url) return "Scene";
  let path = url;
  try {
    path = new URL(url, "http://local.scene").pathname;
  } catch {
    // keep the raw string
  }
  const file = decodeSafe(path.split("/").filter(Boolean).pop() ?? "");
  const stem = file.replace(/\.[A-Za-z0-9]+$/, "").replace(/[_-]+/g, " ").trim();
  return stem || "Scene";
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
