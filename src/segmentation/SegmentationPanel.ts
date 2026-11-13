import { decodeRle } from "./maskAnalysis.ts";
import { VARIANTS, type VariantId, type VariantResult, type ViewResult } from "./experiment.ts";
import type { SegmentationController, SegmentationState } from "./SegmentationController.ts";

/**
 * Dev-only panel for the geometry-guided segmentation experiment. Plain DOM;
 * every dynamic string goes through textContent. It reads controller state and
 * calls controller methods; it holds no experiment logic.
 */

const CSS = `
.seg{position:fixed;left:12px;top:12px;z-index:2100;width:330px;max-height:calc(100vh - 24px);overflow:auto;padding:10px;border-radius:12px;background:rgba(10,13,18,.86);border:1px solid rgba(255,255,255,.18);color:#f4f7fb;font:12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;backdrop-filter:blur(8px)}
.seg *{box-sizing:border-box}
.seg h3{margin:0 0 6px;font-size:13px}
.seg__row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0}
.seg button,.seg select,.seg input[type=text]{font:inherit;color:#f4f7fb;background:#2a3a52;border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:4px 8px}
.seg button{cursor:pointer}.seg button:disabled{opacity:.45;cursor:default}
.seg button.is-on{background:#2b7a4b}
.seg input[type=text]{flex:1;min-width:0}
.seg__status{padding:5px 8px;border-radius:6px;background:rgba(255,255,255,.07);color:#cfd8e3}
.seg__mock{padding:5px 8px;border-radius:6px;background:#ffd166;color:#2a1e00;font-weight:650}
.seg__warn{color:#ffd166}
.seg__view{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14)}
.seg__view canvas{width:100%;display:block;border-radius:6px;background:#151b24}
.seg table{width:100%;border-collapse:collapse;margin-top:4px;font-variant-numeric:tabular-nums}
.seg td,.seg th{padding:1px 4px;text-align:left;font-weight:400}
.seg th{color:#9fb0c2}
.seg__note{color:#9fb0c2}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = (n: number, digits = 3) => n.toFixed(digits);

export class SegmentationPanel {
  readonly root = el("div", "seg");
  private readonly style = el("style");
  private readonly controller: SegmentationController;
  private readonly unsubscribe: () => void;
  private overlayVariant: VariantId = "point+text";
  private readonly images = new Map<string, Promise<HTMLImageElement>>();

  constructor(controller: SegmentationController) {
    this.controller = controller;
    this.style.textContent = CSS;
    this.root.setAttribute("data-segmentation", "true");
    // Keep panel clicks away from the scene's own handlers.
    this.root.addEventListener("click", (event) => event.stopPropagation());
    document.head.appendChild(this.style);
    document.body.appendChild(this.root);
    this.unsubscribe = controller.subscribe(() => this.render());
    this.render();
  }

  private image(src: string): Promise<HTMLImageElement> {
    let cached = this.images.get(src);
    if (!cached) {
      cached = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("snapshot image failed to load"));
        img.src = src;
      });
      this.images.set(src, cached);
    }
    return cached;
  }

  private render(): void {
    const state = this.controller.state();
    const children: HTMLElement[] = [el("h3", undefined, "Geometry-guided SAM 3 (experimental)")];

    const mock = state.result?.views.some((v) => v.variants.some((x) => x.mock));
    if (mock) children.push(el("div", "seg__mock", "MOCK PROVIDER: masks are synthetic, not SAM 3 output"));

    children.push(this.anchorLine(state));
    children.push(this.controls(state));
    children.push(el("div", "seg__status", state.status));
    if (state.result) children.push(...this.results(state));

    this.root.replaceChildren(...children);
  }

  private anchorLine(state: SegmentationState): HTMLElement {
    const line = el("div", "seg__row");
    const a = state.anchor;
    if (!a) {
      line.append(el("span", "seg__note", `No anchor · ${state.captureCount}/3 views captured`));
      return line;
    }
    const p = a.refinement.anchor;
    line.append(
      el("span", undefined, `Anchor (${fmt(p.x, 2)}, ${fmt(p.y, 2)}, ${fmt(p.z, 2)}) · ${a.refinement.hitCount}/${a.refinement.probeCount} rays · spread ${fmt(a.refinement.spread)}`),
      el("span", a.refinement.stable ? undefined : "seg__warn", a.refinement.stable ? "· stable" : "· UNSTABLE"),
      el("span", "seg__note", `· ${state.captureCount}/3 views`),
    );
    return line;
  }

  private controls(state: SegmentationState): HTMLElement {
    const wrap = el("div");

    const buttons = el("div", "seg__row");
    const pick = el("button", state.picking ? "is-on" : undefined, state.picking ? "Click the object…" : "Pick anchor");
    pick.addEventListener("click", () => this.controller.setPicking(!state.picking));
    const run = el("button", undefined, state.running ? "Running…" : "Run");
    run.disabled = state.running || !state.anchor || state.captureCount === 0;
    run.addEventListener("click", () => void this.controller.run());
    const exportButton = el("button", undefined, "Export JSON");
    exportButton.disabled = !state.result;
    exportButton.addEventListener("click", () => this.download());
    const clear = el("button", undefined, "Clear");
    clear.addEventListener("click", () => this.controller.clear());
    buttons.append(pick, run, exportButton, clear);

    const text = el("input");
    text.type = "text";
    text.placeholder = "label, e.g. pillow";
    text.value = state.text;
    text.addEventListener("input", () => this.controller.configure({ text: text.value }));
    // Typing must not trigger the viewer's keyboard shortcuts.
    text.addEventListener("keydown", (event) => event.stopPropagation());
    const textRow = el("div", "seg__row");
    textRow.append(text);

    const variants = el("div", "seg__row");
    for (const id of VARIANTS) {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = state.variants.includes(id);
      box.addEventListener("change", () => {
        const next = new Set(state.variants);
        if (box.checked) next.add(id);
        else next.delete(id);
        this.controller.configure({ variants: VARIANTS.filter((v) => next.has(v)) });
      });
      label.append(box, ` ${id}`);
      variants.append(label);
    }

    const policy = el("select");
    for (const [value, label] of [["send", "prompt occluded views too"], ["skip", "skip occluded views"]] as const) {
      const option = el("option", undefined, label);
      option.value = value;
      option.selected = state.occlusionPolicy === value;
      policy.append(option);
    }
    policy.addEventListener("change", () => this.controller.configure({ occlusionPolicy: policy.value as "send" | "skip" }));
    const policyRow = el("div", "seg__row");
    policyRow.append(policy);
    const note = el("div", "seg__note", "box variants cost one Gemini call per view (box is drawn around the projected anchor).");

    wrap.append(buttons, textRow, variants, policyRow, note);
    return wrap;
  }

  private results(state: SegmentationState): HTMLElement[] {
    const result = state.result!;
    const out: HTMLElement[] = [];

    const overlay = el("select");
    for (const id of state.variants) {
      const option = el("option", undefined, `overlay: ${id}`);
      option.value = id;
      option.selected = id === this.overlayVariant;
      overlay.append(option);
    }
    overlay.addEventListener("change", () => {
      this.overlayVariant = overlay.value as VariantId;
      this.render();
    });
    const overlayRow = el("div", "seg__row");
    overlayRow.append(overlay);
    out.push(overlayRow);

    for (const view of result.views) out.push(this.viewCard(view, state));

    const spread = el("div", "seg__view");
    spread.append(el("div", undefined, "Cross-view consistency"));
    const table = el("table");
    table.append(this.row(["variant", "views", "centroid spread (3D)"], true));
    for (const entry of result.crossViewSpread) {
      table.append(this.row([entry.variant, String(entry.views), entry.spread === null ? "–" : fmt(entry.spread)]));
    }
    spread.append(table);
    spread.append(el("div", "seg__note", "Spread of the 3D points hit through each view's mask centroid. Small = the masks point at one place. An indicator only: there is no ground truth here."));
    out.push(spread);
    return out;
  }

  private row(cells: string[], header = false): HTMLTableRowElement {
    const tr = el("tr");
    for (const text of cells) tr.append(el(header ? "th" : "td", undefined, text));
    return tr;
  }

  private viewCard(view: ViewResult, state: SegmentationState): HTMLElement {
    const card = el("div", "seg__view");
    card.append(el("div", undefined, `${view.slot[0].toUpperCase()}${view.slot.slice(1)}`));

    if (view.stale) {
      card.append(el("div", "seg__warn", view.stale));
      return card;
    }
    const projection = view.projection;
    const projectionText = projection
      ? projection.image
        ? `anchor ${projection.status} at (${Math.round(projection.image.x)}, ${Math.round(projection.image.y)}) px`
        : `anchor ${projection.status}`
      : "";
    card.append(el("div", "seg__note", `${projectionText}${view.visibility ? ` · ${view.visibility.visibility}` : ""}`));
    if (view.visibility && view.visibility.visibility !== "visible") {
      card.append(el("div", "seg__warn", view.visibility.note));
    }

    const canvas = el("canvas");
    card.append(canvas);
    const input = state.views.find((v) => v.slot === view.slot);
    if (input) void this.draw(canvas, input.snapshot.image.dataUrl, view);

    const table = el("table");
    table.append(this.row(["variant", "score", "area", "has anchor", "status"], true));
    for (const variant of view.variants) table.append(this.variantRow(variant));
    card.append(table);
    return card;
  }

  private variantRow(variant: VariantResult): HTMLTableRowElement {
    const mask = variant.primary !== null ? variant.masks[variant.primary] : null;
    if (!mask) {
      return this.row([variant.variant, "–", "–", "–", variant.reason ? `${variant.status}: ${variant.reason}` : variant.status]);
    }
    return this.row([
      variant.variant,
      mask.score === null ? "–" : fmt(mask.score, 2),
      `${(mask.stats.areaFraction * 100).toFixed(1)}%${mask.stats.touchesBorder ? " ⚠edge" : ""}`,
      mask.containsAnchor ? "yes" : "NO",
      variant.status,
    ]);
  }

  private async draw(canvas: HTMLCanvasElement, src: string, view: ViewResult): Promise<void> {
    let img: HTMLImageElement;
    try {
      img = await this.image(src);
    } catch {
      return;
    }
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);

    const variant = view.variants.find((v) => v.variant === this.overlayVariant);
    const mask = variant?.primaryMask;
    if (mask) {
      const pixels = decodeRle(mask);
      const overlay = ctx.createImageData(mask.width, mask.height);
      for (let i = 0; i < pixels.length; i++) {
        if (!pixels[i]) continue;
        overlay.data[i * 4] = 46;
        overlay.data[i * 4 + 1] = 232;
        overlay.data[i * 4 + 2] = 106;
        overlay.data[i * 4 + 3] = 110;
      }
      const layer = document.createElement("canvas");
      layer.width = mask.width;
      layer.height = mask.height;
      layer.getContext("2d")?.putImageData(overlay, 0, 0);
      ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
    }

    const p = view.projection?.image;
    if (p) {
      const r = Math.max(8, canvas.width / 90);
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.strokeStyle = "#ff3b6b";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.moveTo(p.x - r * 1.6, p.y);
      ctx.lineTo(p.x + r * 1.6, p.y);
      ctx.moveTo(p.x, p.y - r * 1.6);
      ctx.lineTo(p.x, p.y + r * 1.6);
      ctx.stroke();
    }
  }

  private download(): void {
    const blob = new Blob([JSON.stringify(this.controller.exportResult(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `geometry-guided-segmentation-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
    this.style.remove();
    this.images.clear();
  }
}
