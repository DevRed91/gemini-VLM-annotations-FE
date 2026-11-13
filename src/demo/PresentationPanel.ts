import { CAPTURE_SLOTS, type CaptureSlotId, type PresentationCapture } from "./presentationCaptures.ts";

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
}

export interface PresentationActions {
  capture(slot: CaptureSlotId): void;
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

export class PresentationPanel {
  readonly root = el("div", "pres");
  private readonly style = el("style");
  private readonly scene = el("span", "pres__scene");
  private readonly count = el("span", "pres__count");
  private readonly notice = el("div", "pres__notice");
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
      bar.append(root);
      this.cards.set(slot.id, { root, time, thumb, empty, button, shownId: null });
    }

    this.root.append(top, this.notice, bar);
    document.head.append(this.style);
    document.body.append(this.root);
  }

  render(model: PresentationModel): void {
    if (this.disposed) return;
    this.set(this.scene, model.sceneLabel);
    const filled = model.captures.filter((capture) => capture !== null).length;
    this.set(this.count, `${filled} / ${CAPTURE_SLOTS.length} captured`);
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
