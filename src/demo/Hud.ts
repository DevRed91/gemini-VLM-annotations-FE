import { LIVE_LABEL } from "./RayOverlay.ts";
import type { InferenceMode } from "./inferenceSeam.ts";

/**
 * DEV-only demo HUD. Plain DOM, no framework; every dynamic string goes
 * through textContent. Elements are created once and updated in place.
 */

export interface HudModel {
  mode: InferenceMode;
  modeLabel: string;
  modeNote: string;
  inferenceEnabled: boolean;
  annotationToolOn: boolean;
  snapshot: { dataUrl: string; id: string; capturedAt: string; generation: number; imageSize: string } | null;
  drift: { position: string; rotation: string } | null;
  snapshotRays: string;
  snapshotHits: string;
  liveRays: string;
  liveCost: string;
  displacement: string;
  settled: SettledHudModel;
  /** Persistent annotation-helper warning; null when the scene is clean. */
  helperWarning: string | null;
  helperSummary: string;
  clear: { armed: boolean; armedLabel: string; result: string };
  request: string;
  pipeline: string;
  productionMatch: string;
  stage: string;
}

export interface SettledHudModel {
  /** CURRENT | STALE | WAITING … | NONE */
  readonly status: string;
  readonly tone: "current" | "stale" | "wait";
  readonly hits: string;
  readonly measuredAt: string;
  readonly cost: string;
  readonly pose: string;
  readonly note: string;
  /** Non-empty only when helpers were present at measurement time. */
  readonly contamination: string;
}

export interface HudActions {
  setMode(mode: InferenceMode): void;
  capture(): void;
  reset(): void;
  /** Step 1 of "Reset + Clear Annotations": arms the confirmation. */
  requestClear(): void;
  /** Step 2: runs the destructive operation (only effective after requestClear). */
  confirmClear(): void;
  cancelClear(): void;
}

const CSS = `
.demo-hud{position:fixed;right:12px;top:64px;max-height:calc(100vh - 80px);overflow-y:auto;width:336px;z-index:2000;font:12px/1.35 ui-monospace,Menlo,monospace;color:#e8eef5;background:rgba(8,10,14,.86);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:10px 12px;box-sizing:border-box;pointer-events:auto}
.demo-hud *{box-sizing:border-box}
.demo-hud__title{font-weight:700;letter-spacing:.04em;color:#8fd3ff;margin-bottom:4px}
.demo-hud__mode{font-weight:700;color:#ffd166}
.demo-hud__note{color:#b8c2cc;margin-bottom:6px}
.demo-hud__warn{color:#ff6b6b;font-weight:700;margin:4px 0}
.demo-hud__inference-disabled{color:#ff9b9b;background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.5);border-radius:4px;padding:5px 6px;margin:5px 0;font-weight:700}
.demo-hud__row{display:flex;justify-content:space-between;gap:8px;margin:2px 0}
.demo-hud__row span:first-child{color:#93a1ad}
.demo-hud__row span:last-child{text-align:right}
.demo-hud__snap{display:flex;gap:8px;margin:6px 0;align-items:flex-start}
.demo-hud__img{width:120px;height:68px;object-fit:cover;border:1px solid rgba(255,255,255,.25);background:#111;flex:none}
.demo-hud__snapmeta{color:#b8c2cc;font-size:11px;word-break:break-all}
.demo-hud__legend{margin:6px 0;font-size:11px}
.demo-hud__green{color:#2ee86a}.demo-hud__orange{color:#ff7a1a}.demo-hud__magenta{color:#e040fb}
.demo-hud__section{margin:8px 0 2px;padding-top:4px;border-top:1px solid rgba(255,255,255,.14);font-weight:700;letter-spacing:.05em;font-size:11px}
.demo-hud__section--snap{color:#2ee86a}.demo-hud__section--live{color:#ff7a1a}.demo-hud__section--settled{color:#e040fb}
.demo-hud__tag{display:inline-block;padding:0 6px;border-radius:3px;font-weight:700;color:#10151c}
.demo-hud__tag--current{background:#2ee86a}.demo-hud__tag--stale{background:#ff6b6b}.demo-hud__tag--wait{background:#ffd166}
.demo-hud__contam{color:#ffd166;font-weight:700;margin:3px 0}
.demo-hud__helperwarn{color:#ffd166;background:rgba(255,209,102,.12);border:1px solid rgba(255,209,102,.5);border-radius:4px;padding:5px 6px;margin:6px 0;font-size:11px}
.demo-hud button.danger{border-color:#ff6b6b;color:#ff9b9b}.demo-hud button.danger.armed{background:#ff6b6b;color:#10151c}
.demo-hud__buttons{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.demo-hud button{font:inherit;color:#e8eef5;background:#243040;border:1px solid rgba(255,255,255,.22);border-radius:4px;padding:3px 7px;cursor:pointer}
.demo-hud button.active{background:#ffd166;color:#10151c;border-color:#ffd166}
.demo-hud__keys{margin-top:6px;color:#75828e;font-size:10.5px}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Hud {
  readonly root = el("div", "demo-hud");
  private readonly style = el("style");
  private readonly modeText = el("div", "demo-hud__mode");
  private readonly noteText = el("div", "demo-hud__note");
  private readonly warn = el("div", "demo-hud__warn");
  private readonly inferenceDisabled = el("div", "demo-hud__inference-disabled");
  private readonly image = el("img", "demo-hud__img");
  private readonly snapMeta = el("div", "demo-hud__snapmeta");
  private readonly rows = new Map<string, HTMLElement>();
  private readonly modeButtons = new Map<InferenceMode, HTMLButtonElement>();
  private readonly settledTag = el("div", "demo-hud__tag");
  private readonly settledNote = el("div", "demo-hud__note");
  private readonly contamination = el("div", "demo-hud__contam");
  private readonly helperWarn = el("div", "demo-hud__helperwarn");
  private readonly clearResult = el("div", "demo-hud__note");
  private clearButton!: HTMLButtonElement;
  private confirmButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private lastImage = "";
  private readonly actions: HudActions;
  private disposed = false;

  constructor(actions: HudActions) {
    this.actions = actions;
    this.style.textContent = CSS;
    this.root.setAttribute("data-demo-hud", "true");
    this.root.append(
      el("div", "demo-hud__title", "DEMO · DEV ONLY · Geometric consistency"),
      this.inferenceDisabled,
      this.modeText,
      this.noteText,
      this.warn,
    );

    const snap = el("div", "demo-hud__snap");
    this.image.alt = "snapshot preview";
    this.image.style.visibility = "hidden";
    snap.append(this.image, this.snapMeta);
    this.root.append(snap);

    this.addSection("SNAPSHOT MEASUREMENTS · frozen, production rays", "snap");
    this.addRows([
      ["drift-pos", "camera drift · position"],
      ["drift-rot", "camera drift · rotation"],
      ["snap-rays", "snapshot rays (green)"],
      ["snap-hits", "snapshot hit positions"],
    ]);

    this.addSection("LIVE CAMERA REFERENCE · rays only, no splat cast", "live");
    this.addRows([
      ["live-rays", "live ref rays (orange)"],
      ["live-cost", "ray-derivation cost"],
    ]);

    this.addSection("SETTLED LIVE MEASUREMENT · 9 splat casts, once", "settled");
    this.root.append(this.settledTag);
    this.addRows([
      ["settled-hits", "measured hits"],
      ["settled-at", "measured at"],
      ["settled-cost", "measurement cost"],
      ["settled-pose", "camera pose at capture"],
      ["displacement", "settled−snapshot hit shift"],
    ]);
    this.root.append(this.settledNote, this.contamination);

    this.addSection("PIPELINE", "snap");
    this.addRows([
      ["request", "inference"],
      ["pipeline", "pipeline"],
      ["match", "= production rays?"],
      ["stage", "stage overlay"],
      ["helpers", "annotations / helpers"],
    ]);
    this.root.append(this.helperWarn);

    const legend = el("div", "demo-hud__legend");
    const green = el("div", "demo-hud__green", "■ SNAPSHOT RAYS · production snapshotSplatRay · frozen");
    const orange = el("div", "demo-hud__orange", `■ ${LIVE_LABEL}`);
    const magenta = el("div", "demo-hud__magenta", "■ SETTLED HITS · splat.raycast, once per settle (hidden when STALE)");
    legend.append(green, orange, magenta);
    this.root.append(legend);

    const buttons = el("div", "demo-hud__buttons");
    for (const mode of [1, 2, 3] as const) {
      const button = el("button", undefined, `Mode ${mode}`);
      button.addEventListener("click", () => this.actions.setMode(mode));
      this.modeButtons.set(mode, button);
      buttons.append(button);
    }
    const capture = el("button", undefined, "Capture ⇧S");
    capture.addEventListener("click", () => this.actions.capture());
    const reset = el("button", undefined, "Reset ⇧R");
    reset.addEventListener("click", () => this.actions.reset());
    buttons.append(capture, reset);
    this.clearButton = el("button", "danger", "Reset + Clear Annotations");
    this.clearButton.addEventListener("click", () => this.actions.requestClear());
    this.confirmButton = el("button", "danger armed");
    this.confirmButton.addEventListener("click", () => this.actions.confirmClear());
    this.cancelButton = el("button", undefined, "Cancel");
    this.cancelButton.addEventListener("click", () => this.actions.cancelClear());
    this.confirmButton.style.display = "none";
    this.cancelButton.style.display = "none";
    buttons.append(this.clearButton, this.confirmButton, this.cancelButton);
    this.root.append(buttons, this.clearResult);
    this.root.append(el("div", "demo-hud__keys", "⇧G HUD · ⇧S capture · ⇧R reset · ⇧V snapshot rays · ⇧L live rays · ⇧T stages · ⇧P log pose · ⇧F Scene F captions · D/O/V diagnostics (markers start OFF in demo)"));

    document.head.append(this.style);
    document.body.append(this.root);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
  }

  isVisible(): boolean {
    return this.root.style.display !== "none";
  }

  update(model: HudModel): void {
    if (this.disposed) return;
    this.set(this.modeText, `MODE ${model.mode} · ${model.modeLabel}`);
    this.set(this.noteText, model.modeNote);
    this.set(this.inferenceDisabled, model.inferenceEnabled ? "" : "GEMINI INFERENCE: DISABLED");
    this.inferenceDisabled.style.display = model.inferenceEnabled ? "none" : "";
    this.set(this.warn, model.annotationToolOn ? "" : "Annotation Tool is OFF — enable it (toolbar) before Shift+S");
    for (const [mode, button] of this.modeButtons) button.classList.toggle("active", mode === model.mode);

    if (model.snapshot) {
      if (this.lastImage !== model.snapshot.id) {
        this.image.src = model.snapshot.dataUrl;
        this.lastImage = model.snapshot.id;
      }
      this.image.style.visibility = "visible";
      this.set(this.snapMeta, `snapshot ${model.snapshot.id.slice(0, 8)} · gen ${model.snapshot.generation}\n${model.snapshot.imageSize}\n${model.snapshot.capturedAt}`);
    } else {
      this.lastImage = "";
      this.image.removeAttribute("src");
      this.image.style.visibility = "hidden";
      this.set(this.snapMeta, "no snapshot yet — Shift+S");
    }
    this.snapMeta.style.whiteSpace = "pre-line";

    this.setRow("drift-pos", model.drift?.position ?? "–");
    this.setRow("drift-rot", model.drift?.rotation ?? "–");
    this.setRow("snap-rays", model.snapshotRays);
    this.setRow("snap-hits", model.snapshotHits);
    this.setRow("live-rays", model.liveRays);
    this.setRow("displacement", model.displacement);
    this.setRow("live-cost", model.liveCost);
    this.setRow("request", model.request);
    this.setRow("pipeline", model.pipeline);
    this.setRow("match", model.productionMatch);
    this.setRow("stage", model.stage);
    this.setRow("helpers", model.helperSummary);

    const st = model.settled;
    this.set(this.settledTag, st.status);
    this.settledTag.className = `demo-hud__tag demo-hud__tag--${st.tone}`;
    this.setRow("settled-hits", st.hits);
    this.setRow("settled-at", st.measuredAt);
    this.setRow("settled-cost", st.cost);
    this.setRow("settled-pose", st.pose);
    this.set(this.settledNote, st.note);
    this.set(this.contamination, st.contamination);
    this.contamination.style.display = st.contamination ? "" : "none";

    this.set(this.helperWarn, model.helperWarning ?? "");
    this.helperWarn.style.display = model.helperWarning ? "" : "none";

    const armed = model.clear.armed;
    this.clearButton.style.display = armed ? "none" : "";
    this.confirmButton.style.display = armed ? "" : "none";
    this.cancelButton.style.display = armed ? "" : "none";
    this.set(this.confirmButton, model.clear.armedLabel);
    this.set(this.clearResult, model.clear.result);
  }

  private addSection(text: string, tone: "snap" | "live" | "settled"): void {
    this.root.append(el("div", `demo-hud__section demo-hud__section--${tone}`, text));
  }

  private addRows(rows: ReadonlyArray<readonly [string, string]>): void {
    for (const [key, label] of rows) {
      const row = el("div", "demo-hud__row");
      const value = el("span", undefined, "–");
      row.append(el("span", undefined, label), value);
      this.rows.set(key, value);
      this.root.append(row);
    }
  }

  private set(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  private setRow(key: string, text: string): void {
    const node = this.rows.get(key);
    if (node) this.set(node, text);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
    this.style.remove();
  }
}
