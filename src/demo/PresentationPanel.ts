import { CAPTURE_SLOTS, type CaptureSlotId, type PresentationCapture } from "./presentationCaptures.ts";
import { detectionBoxStyle, observationForView, type MultiViewObjectDetection } from "./multiViewDetection.ts";

/**
 * Presentation-mode UI: current scene, capture confirmation, three capture
 * thumbnails and the capture count. Plain DOM; dynamic strings only go through
 * textContent. It never touches the renderer or camera: thumbnails are <img>
 * elements showing the immutable data URL stored with each capture.
 */

export interface PresentationModel {
  sceneLabel: string;
  /** Slot order: Front, Side, Top. */
  captures: readonly (PresentationCapture | null)[];
  detections: readonly MultiViewObjectDetection[];
  detectionResultAvailable: boolean;
  detectionLoading: boolean;
  detectionError: string;
  reviewOpen: boolean;
  selectedObjectId: string | null;
  selectionConfirmed: boolean;
}

export interface PresentationActions {
  capture(slot: CaptureSlotId): void;
  sendToGemini(): void;
  selectObject(id: string): void;
  continueWithSelectedObject(): void;
  closeReview(): void;
  openReview(): void;
}

const NOTICE_MS = 2200;
const FLASH_MS = 1400;

const CSS = `
.pres{position:fixed;inset:0;z-index:2000;pointer-events:none;font:14px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#f4f7fb}
.pres *{box-sizing:border-box}
.pres__top{position:absolute;left:50%;top:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 16px;border-radius:999px;background:rgba(10,13,18,.72);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(8px)}
.pres__label{color:#9fb0c2;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.pres__scene{font-weight:650}
.pres__count{padding-left:10px;border-left:1px solid rgba(255,255,255,.2);font-variant-numeric:tabular-nums}
.pres__notice{position:absolute;left:50%;top:64px;transform:translateX(-50%);padding:7px 16px;border-radius:8px;background:rgba(46,232,106,.92);color:#07210f;font-weight:650;opacity:0;transition:opacity .25s}
.pres__notice.is-on{opacity:1}
.pres__notice.is-warn{background:rgba(255,209,102,.95);color:#2a1e00}
.pres__bar{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:14px}
.pres__card{width:224px;padding:8px;border-radius:12px;background:rgba(10,13,18,.78);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(8px);pointer-events:auto;transition:border-color .3s,box-shadow .3s}
.pres__card.is-new{border-color:#2ee86a;box-shadow:0 0 0 2px rgba(46,232,106,.45)}
.pres__title{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-weight:650}
.pres__time{color:#9fb0c2;font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.pres__thumb{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;background:#151b24}
.pres__empty{width:100%;aspect-ratio:16/10;border-radius:8px;border:1px dashed rgba(255,255,255,.28);display:flex;align-items:center;justify-content:center;color:#7d8ea1;font-size:12px}
.pres__btn{margin-top:8px;width:100%;font:inherit;font-weight:600;color:#f4f7fb;background:#2a3a52;border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:6px 8px;cursor:pointer}
.pres__btn:hover{background:#355075}
.pres__bar{flex-direction:column;align-items:center;bottom:16px;gap:8px}
.pres__cards{display:flex;gap:14px}
.pres__send{min-width:240px;padding:10px 18px;background:#1769d2;border-color:#79b5ff;font-size:15px;box-shadow:0 5px 22px rgba(0,0,0,.35)}
.pres__review-action{min-width:220px;margin-top:0}
.pres__send:disabled,.pres__continue:disabled{opacity:.5;cursor:not-allowed}
.pres__error{max-width:min(700px,90vw);padding:7px 12px;border-radius:8px;background:rgba(111,30,24,.96);color:#ffe2df;text-align:center}
.pres__review{position:absolute;inset:7% 5%;z-index:2;display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:14px;padding:16px;border-radius:16px;background:rgba(10,14,21,.97);border:1px solid rgba(255,255,255,.22);box-shadow:0 18px 70px rgba(0,0,0,.65);pointer-events:auto;overflow:hidden}
.pres__review-list,.pres__review-main{min-height:0;overflow:auto}
.pres__review-list{padding-right:4px}
.pres__review-heading{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;font-weight:700}
.pres__review-close,.pres__continue{font:inherit;color:#f4f7fb;background:#28394f;border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:8px 12px;cursor:pointer}
.pres__object{display:grid;grid-template-columns:52px 1fr;gap:9px;width:100%;margin-bottom:8px;padding:8px;color:#eaf1f8;text-align:left;background:#182231;border:1px solid rgba(255,255,255,.12);border-radius:10px;cursor:pointer}
.pres__object.is-selected{border-color:#59b8ff;box-shadow:0 0 0 2px rgba(56,160,255,.45);background:#203c58}
.pres__object-thumb{width:52px;height:52px;object-fit:cover;border-radius:6px;background:#090d13}
.pres__object-label{display:block;font-weight:700}
.pres__object-meta{display:block;margin-top:4px;color:#aebdce;font-size:11px}
.pres__object-description{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:4px;color:#c3d0de;font-size:11px;line-height:1.3}
.pres__empty-results{padding:16px;color:#c7d2df;background:#182231;border-radius:10px}
.pres__review-main h2{margin:0 0 4px;font-size:21px}
.pres__description{margin:0 0 12px;color:#c5d2df}
.pres__images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
.pres__view{min-width:0;padding:8px;background:#151d29;border-radius:10px}
.pres__view-title{margin-bottom:6px;font-size:12px;font-weight:700;color:#c8d5e2}
.pres__image-wrap{position:relative;width:100%;line-height:0;background:#080b10;border-radius:5px;overflow:hidden}
.pres__review-image{display:block;width:100%;height:auto}
.pres__box{position:absolute;border:2px solid #50dcff;background:rgba(39,196,255,.14);box-shadow:0 0 0 1px rgba(0,0,0,.6);pointer-events:none}
.pres__view-missing{padding:12px 4px;color:#ffcf83;font-size:12px}
.pres__selection-state{margin-top:14px;padding:10px;border-radius:8px;background:#172333;color:#c8d5e2}
.pres__review-actions{display:flex;justify-content:flex-end;margin-top:12px}
@media(max-width:820px){.pres__review{inset:3% 3%;grid-template-columns:minmax(150px,220px) minmax(0,1fr);padding:10px}.pres__images{grid-template-columns:1fr}.pres__cards{gap:6px}.pres__card{width:min(29vw,224px);padding:6px}.pres__bar{max-width:100vw}.pres__send{min-width:220px}}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Card {
  readonly root: HTMLElement;
  readonly time: HTMLElement;
  readonly thumb: HTMLImageElement;
  readonly empty: HTMLElement;
  readonly button: HTMLButtonElement;
  shownId: string | null;
}

function observationCount(object: MultiViewObjectDetection): number {
  return object.observations.filter((observation) => observation.visible && observation.box).length;
}

export class PresentationPanel {
  readonly root = el("div", "pres");
  private readonly style = el("style");
  private readonly scene = el("span", "pres__scene");
  private readonly count = el("span", "pres__count");
  private readonly notice = el("div", "pres__notice");
  private readonly sendButton = el("button", "pres__btn pres__send", "Send to Gemini");
  private readonly reviewButton = el("button", "pres__btn pres__review-action", "Review detections");
  private readonly error = el("div", "pres__error");
  private readonly review = el("section", "pres__review");
  private readonly cards = new Map<CaptureSlotId, Card>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flashTimers = new Map<CaptureSlotId, ReturnType<typeof setTimeout>>();
  private disposed = false;

  private readonly actions: PresentationActions;

  constructor(actions: PresentationActions) {
    this.actions = actions;
    this.style.textContent = CSS;
    this.root.setAttribute("data-presentation", "true");

    const top = el("div", "pres__top");
    top.append(el("span", "pres__label", "Scene"), this.scene, this.count);
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-live", "polite");

    const bar = el("div", "pres__bar");
    const cards = el("div", "pres__cards");
    for (const slot of CAPTURE_SLOTS) {
      const root = el("div", "pres__card");
      root.setAttribute("data-slot", slot.id);
      const time = el("span", "pres__time");
      const title = el("div", "pres__title");
      title.append(el("span", undefined, slot.title), time);
      const thumb = el("img", "pres__thumb");
      thumb.alt = `${slot.title} capture`;
      thumb.style.display = "none";
      const empty = el("div", "pres__empty", "Not captured");
      const button = el("button", "pres__btn", `Capture ${slot.title} (⇧${slot.key.slice(-1)})`);
      button.addEventListener("click", () => {
        this.actions.capture(slot.id);
        // Keep keyboard focus off the button so Space/Enter never re-capture
        // and WASD camera movement keeps working.
        (button as { blur?: () => void }).blur?.();
      });
      root.append(title, thumb, empty, button);
      cards.append(root);
      this.cards.set(slot.id, { root, time, thumb, empty, button, shownId: null });
    }

    this.sendButton.type = "button";
    this.sendButton.addEventListener("click", () => this.actions.sendToGemini());
    this.reviewButton.type = "button";
    this.reviewButton.addEventListener("click", () => this.actions.openReview());
    this.reviewButton.style.display = "none";
    this.error.setAttribute("role", "alert");
    this.error.style.display = "none";
    this.review.setAttribute("aria-label", "Gemini detection review");
    this.review.style.display = "none";
    bar.append(cards, this.sendButton, this.reviewButton, this.error);

    this.root.append(top, this.notice, bar);
    document.head.append(this.style);
    document.body.append(this.root);
  }

  render(model: PresentationModel): void {
    if (this.disposed) return;
    this.set(this.scene, model.sceneLabel);
    const filled = model.captures.filter((capture) => capture !== null).length;
    this.set(this.count, `${filled} / ${CAPTURE_SLOTS.length} captured`);
    this.sendButton.disabled = filled !== CAPTURE_SLOTS.length || model.detectionLoading;
    this.set(this.sendButton, model.detectionLoading ? "Sending to Gemini…" : model.detectionResultAvailable ? "Send to Gemini again" : "Send to Gemini");
    this.reviewButton.style.display = model.detectionResultAvailable && !model.reviewOpen && !model.detectionLoading ? "" : "none";
    this.error.style.display = model.detectionError ? "" : "none";
    this.set(this.error, model.detectionError);
    this.review.style.display = model.reviewOpen ? "grid" : "none";
    if (model.reviewOpen) this.renderReview(model);
    CAPTURE_SLOTS.forEach((slot, index) => {
      const card = this.cards.get(slot.id)!;
      const capture = model.captures[index] ?? null;
      if (capture) {
        // Only touch the (large) data URL when this slot's capture changed.
        if (card.shownId !== capture.id) {
          card.thumb.src = capture.snapshot.image.dataUrl;
          card.thumb.setAttribute("data-capture-id", capture.id);
          card.shownId = capture.id;
        }
        card.thumb.style.display = "";
        card.empty.style.display = "none";
        this.set(card.time, new Date(capture.capturedAtMs).toLocaleTimeString());
        this.set(card.button, `Re-capture ${slot.title} (⇧${slot.key.slice(-1)})`);
      } else {
        card.shownId = null;
        card.thumb.removeAttribute("src");
        card.thumb.removeAttribute("data-capture-id");
        card.thumb.style.display = "none";
        card.empty.style.display = "";
        this.set(card.time, "");
        this.set(card.button, `Capture ${slot.title} (⇧${slot.key.slice(-1)})`);
      }
    });
  }

  private renderReview(model: PresentationModel): void {
    this.review.replaceChildren();
    const list = el("div", "pres__review-list");
    const heading = el("div", "pres__review-heading", "Detected objects");
    const close = el("button", "pres__review-close", "Close");
    close.type = "button";
    close.addEventListener("click", () => this.actions.closeReview());
    heading.append(close);
    list.append(heading);
    if (model.detections.length === 0) {
      list.append(el("div", "pres__empty-results", "Gemini did not return any objects. You can send the captures again after reviewing them."));
    }
    for (const object of model.detections) {
      const button = el("button", `pres__object${object.id === model.selectedObjectId ? " is-selected" : ""}`);
      button.type = "button";
      button.setAttribute("aria-pressed", object.id === model.selectedObjectId ? "true" : "false");
      const firstVisible = CAPTURE_SLOTS.map((slot) => ({ slot, observation: observationForView(object, slot.id), capture: model.captures.find((capture) => capture?.slot === slot.id) ?? null }))
        .find((entry) => entry.observation?.visible && entry.capture)?.capture;
      if (firstVisible) {
        const thumb = el("img", "pres__object-thumb");
        thumb.alt = `${object.label} representative view`;
        const representative = CAPTURE_SLOTS.map((slot) => ({
          observation: observationForView(object, slot.id),
          capture: model.captures.find((capture) => capture?.slot === slot.id) ?? null,
        })).find((entry) => entry.observation?.visible && entry.observation.box && entry.capture?.id === firstVisible.id);
        if (representative?.observation?.box) {
          const source = firstVisible.snapshot.image.dataUrl;
          thumb.onload = () => {
            if (!thumb.naturalWidth || !thumb.naturalHeight) return;
            const width = thumb.naturalWidth;
            const height = thumb.naturalHeight;
            const bounds = representative.observation!.box!;
            const x0 = bounds.xMin * width;
            const y0 = bounds.yMin * height;
            const x1 = bounds.xMax * width;
            const y1 = bounds.yMax * height;
            const side = Math.min(Math.max(x1 - x0, y1 - y0) * 1.24, width, height);
            const left = Math.max(0, Math.min(width - side, (x0 + x1 - side) / 2));
            const top = Math.max(0, Math.min(height - side, (y0 + y1 - side) / 2));
            const canvas = document.createElement("canvas");
            canvas.width = 96;
            canvas.height = 96;
            const context = canvas.getContext("2d");
            if (!context) return;
            context.drawImage(thumb, left, top, side, side, 0, 0, canvas.width, canvas.height);
            try { thumb.src = canvas.toDataURL("image/jpeg", 0.85); }
            catch { thumb.src = source; }
            thumb.onload = null;
          };
        }
        thumb.src = firstVisible.snapshot.image.dataUrl;
        button.append(thumb);
      }
      const copy = el("span");
      copy.append(
        el("span", "pres__object-label", object.label),
        el("span", "pres__object-meta", `${observationCount(object)} view${observationCount(object) === 1 ? "" : "s"} detected`),
        el("span", "pres__object-description", object.description),
      );
      button.append(copy);
      button.addEventListener("click", () => this.actions.selectObject(object.id));
      list.append(button);
    }

    const main = el("div", "pres__review-main");
    const selected = model.detections.find((object) => object.id === model.selectedObjectId) ?? null;
    if (!selected) {
      main.append(el("div", "pres__empty-results", model.detections.length ? "Select an object to inspect its observations across Front, Side and Top." : "No object is selected."));
    } else {
      main.append(el("h2", undefined, selected.label), el("p", "pres__description", selected.description));
      const imageGrid = el("div", "pres__images");
      for (const slot of CAPTURE_SLOTS) {
        const capture = model.captures.find((entry) => entry?.slot === slot.id) ?? null;
        const observation = observationForView(selected, slot.id);
        const card = el("div", "pres__view");
        card.append(el("div", "pres__view-title", slot.title));
        if (!capture) {
          card.append(el("div", "pres__view-missing", "Capture unavailable"));
        } else if (!observation || !observation.visible || !observation.box) {
          card.append(el("div", "pres__view-missing", observation ? "Not detected in this view" : "No observation returned for this view"));
          const imageWrap = el("div", "pres__image-wrap");
          const image = el("img", "pres__review-image");
          image.src = capture.snapshot.image.dataUrl;
          image.alt = `${slot.title} captured image`;
          imageWrap.append(image);
          card.append(imageWrap);
        } else {
          const imageWrap = el("div", "pres__image-wrap");
          const image = el("img", "pres__review-image");
          image.src = capture.snapshot.image.dataUrl;
          image.alt = `${slot.title} captured image with ${selected.label} detection`;
          const box = el("span", "pres__box");
          Object.assign(box.style, detectionBoxStyle(observation.box));
          box.setAttribute("aria-label", `${slot.title} detection bounding box`);
          imageWrap.append(image, box);
          card.append(imageWrap);
        }
        imageGrid.append(card);
      }
      main.append(imageGrid);
      const states = CAPTURE_SLOTS.map((slot) => {
        const observation = observationForView(selected, slot.id);
        const status = observation?.visible ? "Detected" : observation ? "Not detected" : "No observation";
        return `${slot.title}: ${status}`;
      }).join(" · ");
      main.append(el("div", "pres__selection-state", states));
      const actions = el("div", "pres__review-actions");
      const continueButton = el("button", "pres__continue", model.selectionConfirmed ? "Selection confirmed" : "Continue with Selected Object");
      continueButton.type = "button";
      continueButton.disabled = model.selectionConfirmed;
      continueButton.addEventListener("click", () => this.actions.continueWithSelectedObject());
      actions.append(continueButton);
      main.append(actions);
    }
    this.review.append(list, main);
    if (!this.review.isConnected) this.root.append(this.review);
  }

  /** Transient confirmation message plus a highlight on the slot that changed. */
  confirm(slot: CaptureSlotId, message: string): void {
    if (this.disposed) return;
    this.showNotice(message, false);
    const card = this.cards.get(slot);
    if (!card) return;
    card.root.className = "pres__card is-new";
    const previous = this.flashTimers.get(slot);
    if (previous) clearTimeout(previous);
    this.flashTimers.set(
      slot,
      setTimeout(() => {
        card.root.className = "pres__card";
        this.flashTimers.delete(slot);
      }, FLASH_MS),
    );
  }

  /** Non-success message (e.g. no scene loaded); same toast, amber, no card highlight. */
  warn(message: string): void {
    if (this.disposed) return;
    this.showNotice(message, true);
  }

  private showNotice(message: string, warning: boolean): void {
    this.set(this.notice, message);
    this.notice.className = warning ? "pres__notice is-on is-warn" : "pres__notice is-on";
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice.className = "pres__notice";
      this.noticeTimer = null;
    }, NOTICE_MS);
  }

  private set(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    for (const timer of this.flashTimers.values()) clearTimeout(timer);
    this.flashTimers.clear();
    this.root.remove();
    this.style.remove();
  }
}
