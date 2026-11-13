/**
 * Scene F (future research) captions. STATIC captions only: no multi-view
 * tracking, association, fusion or automated camera positioning exists here.
 *
 * Camera positions are never invented. A slot's pose is whatever the user
 * logged with Shift+P (DemoController.logPose) and then bound to the slot;
 * until then the slot is "pose not logged". The camera is never moved by this
 * module: a caption appears when the user has navigated to a bound pose.
 *
 * The pure part (slot data, binding store, pose matching) has no DOM; the
 * DOM panel is separate from, and does not touch, the production UI.
 */

export const SCENE_F_HEADLINE = "Next research phase: Multi-view Object Association";
export const SCENE_F_BADGE = "NOT YET IMPLEMENTED";

export type SceneFSlotId = "front" | "side" | "top";

export interface SceneFSlot {
  readonly id: SceneFSlotId;
  readonly title: string;
  /** What this pose demonstrates; phrased as the research problem, never as a feature. */
  readonly demonstrates: string;
}

export const SCENE_F_SLOTS: readonly SceneFSlot[] = [
  {
    id: "front",
    title: "Front view",
    demonstrates:
      "One viewpoint of the object. Today an annotation is built from a single snapshot like this one.",
  },
  {
    id: "side",
    title: "Side view",
    demonstrates:
      "The same object from another viewpoint. Recognising it as the front-view annotation's object is open research.",
  },
  {
    id: "top",
    title: "Top view",
    demonstrates:
      "The same object from above: surfaces never seen from the front. Linking this view to the others is open research.",
  },
];

/** Shape of what Shift+P logs (DemoController.PoseRecord), reduced to what matching needs. */
export interface ScenePose {
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly fov?: number;
}

export interface SceneMatchTolerance {
  /** World units. */
  readonly position: number;
  /** Radians. */
  readonly orientation: number;
}

/** Loose on purpose: "close enough that the viewer is looking at the saved view". */
export const SCENE_MATCH_TOLERANCE: SceneMatchTolerance = { position: 0.1, orientation: 0.035 };

function angle(a: readonly number[], b: readonly number[]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

export function poseMatches(
  live: ScenePose,
  saved: ScenePose,
  tolerance: SceneMatchTolerance = SCENE_MATCH_TOLERANCE,
): boolean {
  const distance = Math.hypot(
    live.position[0] - saved.position[0],
    live.position[1] - saved.position[1],
    live.position[2] - saved.position[2],
  );
  return distance <= tolerance.position && angle(live.quaternion, saved.quaternion) <= tolerance.orientation;
}

function isScenePose(value: unknown): value is ScenePose {
  const v = value as ScenePose | null;
  return (
    !!v &&
    Array.isArray(v.position) &&
    v.position.length === 3 &&
    v.position.every(Number.isFinite) &&
    Array.isArray(v.quaternion) &&
    v.quaternion.length === 4 &&
    v.quaternion.every(Number.isFinite)
  );
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "demo.sceneF.poses.v1";

/** Slot → logged pose. Optionally persisted so presets survive a page reload. */
export class SceneFCaptions {
  private poses: Partial<Record<SceneFSlotId, ScenePose>> = {};
  private readonly storage: KeyValueStorage | null;

  constructor(storage: KeyValueStorage | null = null) {
    this.storage = storage;
    this.load();
  }

  bind(slot: SceneFSlotId, pose: ScenePose): void {
    if (!SCENE_F_SLOTS.some((s) => s.id === slot)) throw new RangeError(`Unknown Scene F slot: ${slot}`);
    if (!isScenePose(pose)) throw new TypeError("Scene F pose must come from a logged camera pose (position + quaternion)");
    this.poses[slot] = { position: [...pose.position], quaternion: [...pose.quaternion], fov: pose.fov };
    this.save();
  }

  unbind(slot: SceneFSlotId): void {
    delete this.poses[slot];
    this.save();
  }

  get(slot: SceneFSlotId): ScenePose | null {
    return this.poses[slot] ?? null;
  }

  boundCount(): number {
    return SCENE_F_SLOTS.filter((s) => this.poses[s.id]).length;
  }

  /** The slot whose bound pose the live camera is at, if any. */
  match(live: ScenePose, tolerance?: SceneMatchTolerance): SceneFSlot | null {
    for (const slot of SCENE_F_SLOTS) {
      const saved = this.poses[slot.id];
      if (saved && poseMatches(live, saved, tolerance)) return slot;
    }
    return null;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
      for (const slot of SCENE_F_SLOTS) {
        const pose = parsed[slot.id];
        if (isScenePose(pose)) this.poses[slot.id] = pose;
      }
    } catch {
      /* corrupt or unavailable storage: start with no bound poses */
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.poses));
    } catch {
      /* storage full / unavailable: bindings stay in memory for this session */
    }
  }
}

// ----------------------------------------------------------------------- DOM

export type SceneFMode = "hidden" | "setup" | "clean";

const CSS = `
.demo-scenef{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2001;max-width:min(760px,92vw);text-align:center;font:15px/1.4 ui-sans-serif,system-ui,sans-serif;color:#f4f7fb;background:rgba(8,10,14,.82);border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 18px;pointer-events:none}
.demo-scenef__headline{font-size:20px;font-weight:700}
.demo-scenef__badge{display:inline-block;margin:6px 0 2px;padding:2px 10px;border:1px solid #ffd166;border-radius:999px;color:#ffd166;font:700 12px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.08em}
.demo-scenef__view{margin-top:8px}
.demo-scenef__title{font-weight:700;color:#8fd3ff}
.demo-scenef__setup{margin-top:10px;font:11.5px/1.5 ui-monospace,Menlo,monospace;color:#b8c2cc;pointer-events:auto}
.demo-scenef__setup button{font:inherit;color:#e8eef5;background:#243040;border:1px solid rgba(255,255,255,.22);border-radius:4px;padding:2px 7px;margin:0 3px;cursor:pointer}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ScenePanelActions {
  /** Bind the most recent Shift+P pose to a slot; returns false if none was logged. */
  bindLast(slot: SceneFSlotId): boolean;
}

/** Caption panel. Separate DOM tree from the production UI and from the demo HUD. */
export class SceneFPanel {
  readonly root = el("div", "demo-scenef");
  private readonly style = el("style");
  private readonly view = el("div", "demo-scenef__view");
  private readonly setup = el("div", "demo-scenef__setup");
  private readonly setupStatus = el("div");
  private readonly setupText = el("div");
  private mode: SceneFMode = "hidden";
  private disposed = false;
  private readonly captions: SceneFCaptions;

  constructor(captions: SceneFCaptions, actions: ScenePanelActions) {
    this.captions = captions;
    this.style.textContent = CSS;
    this.root.setAttribute("data-demo-captions", "true");
    this.root.append(el("div", "demo-scenef__headline", SCENE_F_HEADLINE), el("div", "demo-scenef__badge", SCENE_F_BADGE), this.view);
    const buttons = el("div");
    for (const slot of SCENE_F_SLOTS) {
      const button = el("button", undefined, `Bind last ⇧P pose → ${slot.title}`);
      button.addEventListener("click", () => {
        this.setupText.textContent = actions.bindLast(slot.id)
          ? `Bound the last logged pose to “${slot.title}”.`
          : "No pose logged yet — press Shift+P at the view first.";
      });
      buttons.append(button);
    }
    this.setup.append(this.setupStatus, this.setupText, buttons);
    this.root.append(this.setup);
    this.root.style.display = "none";
    document.head.append(this.style);
    document.body.append(this.root);
  }

  /** hidden → setup → clean → hidden */
  cycle(): SceneFMode {
    this.mode = this.mode === "hidden" ? "setup" : this.mode === "setup" ? "clean" : "hidden";
    this.root.style.display = this.mode === "hidden" ? "none" : "";
    this.setup.style.display = this.mode === "setup" ? "" : "none";
    return this.mode;
  }

  currentMode(): SceneFMode {
    return this.mode;
  }

  update(live: ScenePose): void {
    if (this.disposed || this.mode === "hidden") return;
    const slot = this.captions.match(live);
    this.view.replaceChildren();
    if (slot) {
      this.view.append(el("div", "demo-scenef__title", slot.title), el("div", undefined, slot.demonstrates));
    } else if (this.mode === "setup") {
      this.view.append(el("div", undefined, "Navigate to a bound view to show its caption."));
    }
    if (this.mode === "setup") {
      this.setupStatus.textContent = SCENE_F_SLOTS.map(
        (s) => `${s.title}: ${this.captions.get(s.id) ? "pose bound" : "pose not logged"}`,
      ).join(" · ");
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
    this.style.remove();
  }
}
