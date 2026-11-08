import type { ChatMessage, ChatViewState } from "./ChatController.ts";

export class ChatPanel {
  readonly toggleButton: HTMLButtonElement;
  readonly element: HTMLElement;
  private readonly history: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private open = false;
  private readonly onSubmit: (message: string) => void;
  private readonly onClear: () => void;
  private readonly onSelectResult: (annotationId: string) => void;
  private readonly onSelectAllResults: (annotationIds: readonly string[]) => void;
  private readonly onClearSelection: () => void;

  constructor(
    onSubmit: (message: string) => void,
    onClear: () => void,
    onSelectResult: (annotationId: string) => void,
    onSelectAllResults: (annotationIds: readonly string[]) => void,
    onClearSelection: () => void,
  ) {
    this.onSubmit = onSubmit;
    this.onClear = onClear;
    this.onSelectResult = onSelectResult;
    this.onSelectAllResults = onSelectAllResults;
    this.onClearSelection = onClearSelection;
    const toolbar = document.getElementById("toolbar") ?? document.body;
    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "toolbar-btn spatial-search-toggle";
    this.toggleButton.textContent = "⌕ Spatial Search";
    this.toggleButton.setAttribute("aria-expanded", "false");
    toolbar.appendChild(this.toggleButton);

    this.element = document.createElement("section");
    this.element.className = "spatial-chat";
    this.element.setAttribute("aria-label", "Spatial Search");
    this.element.hidden = true;
    this.element.innerHTML = `
      <header class="spatial-chat__header">
        <h2>Spatial Search</h2>
        <div class="spatial-chat__header-actions">
          <button class="spatial-chat__clear" type="button">Clear</button>
          <button class="spatial-chat__close" type="button" aria-label="Close Spatial Search">×</button>
        </div>
      </header>
      <div class="spatial-chat__status" role="status"></div>
      <div class="spatial-chat__history" role="log" aria-live="polite" aria-relevant="additions text"></div>
      <form class="spatial-chat__form">
        <label class="spatial-chat__sr-only" for="spatial-chat-input">Search annotated objects</label>
        <input id="spatial-chat-input" type="text" autocomplete="off" placeholder="Try “find all sofas”" maxlength="240" />
        <button class="spatial-chat__send" type="submit">Send</button>
      </form>
      <p class="spatial-chat__scope">Search covers annotations in this scene only. Unannotated objects aren't included.</p>
    `;
    document.body.appendChild(this.element);

    this.history = this.element.querySelector<HTMLElement>(".spatial-chat__history")!;
    this.form = this.element.querySelector<HTMLFormElement>(".spatial-chat__form")!;
    this.input = this.element.querySelector<HTMLInputElement>("#spatial-chat-input")!;
    this.sendButton = this.element.querySelector<HTMLButtonElement>(".spatial-chat__send")!;
    this.status = this.element.querySelector<HTMLElement>(".spatial-chat__status")!;

    this.toggleButton.addEventListener("click", () => this.setOpen(!this.open));
    this.element.querySelector(".spatial-chat__close")!.addEventListener("click", () => this.setOpen(false));
    this.element.querySelector(".spatial-chat__clear")!.addEventListener("click", () => {
      this.onClear();
      this.input.focus();
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const message = this.input.value;
      this.input.value = "";
      this.onSubmit(message);
    });
    for (const eventName of ["pointerdown", "pointerup", "click", "wheel", "touchstart", "keydown"]) {
      this.element.addEventListener(eventName, (event) => event.stopPropagation());
    }
  }

  render(state: ChatViewState): void {
    this.status.textContent = state.sceneStatus === "loading"
      ? "Loading scene annotations…"
      : state.sceneStatus === "unavailable"
        ? "Scene unavailable"
        : state.loading
          ? "Searching annotated objects…"
          : "Searching the current scene's annotations";
    this.input.disabled = state.sceneStatus !== "ready" || state.loading;
    this.sendButton.disabled = state.sceneStatus !== "ready" || state.loading;
    this.sendButton.textContent = state.loading ? "Searching…" : "Send";
    this.history.replaceChildren(...state.messages.map((message) => this.renderMessage(message)));
    this.history.scrollTop = this.history.scrollHeight;
  }

  private renderMessage(message: ChatMessage): HTMLElement {
    const article = document.createElement("article");
    article.className = `spatial-chat__message spatial-chat__message--${message.role}`;
    const text = document.createElement("p");
    text.className = "spatial-chat__message-text";
    text.textContent = message.text;
    article.appendChild(text);
    if (message.results?.length) {
      const list = document.createElement("ul");
      list.className = "spatial-chat__results";
      for (const item of message.results) {
        const row = document.createElement("li");
        const details = document.createElement("span");
        details.className = "spatial-chat__result-label";
        details.textContent = item.label;
        const id = document.createElement("code");
        id.textContent = item.annotationId;
        const status = document.createElement("span");
        status.className = `spatial-chat__result-status spatial-chat__result-status--${item.status}`;
        status.textContent = item.status;
        const selectButton = document.createElement("button");
        selectButton.type = "button";
        selectButton.className = "spatial-chat__select-result";
        selectButton.textContent = "Select in scene";
        selectButton.setAttribute("aria-label", `Select ${item.label} (${item.annotationId}) in scene`);
        selectButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this.onSelectResult(item.annotationId);
        });
        row.append(details, id, status, selectButton);
        list.appendChild(row);
      }
      article.appendChild(list);

      const actions = document.createElement("div");
      actions.className = "spatial-chat__result-actions";
      const selectAllButton = document.createElement("button");
      selectAllButton.type = "button";
      selectAllButton.className = "spatial-chat__select-all";
      selectAllButton.textContent = "Select all in scene";
      selectAllButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onSelectAllResults(message.results?.map((item) => item.annotationId) ?? []);
      });
      const clearSelectionButton = document.createElement("button");
      clearSelectionButton.type = "button";
      clearSelectionButton.className = "spatial-chat__clear-selection";
      clearSelectionButton.textContent = "Clear selection";
      clearSelectionButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onClearSelection();
      });
      actions.append(selectAllButton, clearSelectionButton);
      article.appendChild(actions);
    }
    return article;
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.element.hidden = !open;
    this.toggleButton.classList.toggle("active", open);
    this.toggleButton.setAttribute("aria-expanded", String(open));
    if (open && !this.input.disabled) this.input.focus();
  }
}
