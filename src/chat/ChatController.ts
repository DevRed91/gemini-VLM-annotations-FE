import { searchObjects } from "../spatial/ObjectMatcher.ts";
import type { SearchableObject, SearchQuery, SearchResult } from "../spatial/types.ts";
import { parseLocalQuery } from "./LocalQueryParser.ts";

export interface ChatResultItem {
  readonly annotationId: string;
  readonly label: string;
  readonly status: "matched" | "ambiguous";
}

export interface ChatMessage {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly results?: readonly ChatResultItem[];
  readonly quantifier?: SearchQuery["quantifier"];
}

export type ChatSceneStatus = "loading" | "ready" | "unavailable";

export interface ChatSelectionAdapter {
  setChatSelection(annotationIds: readonly string[]): void;
  clearChatSelection(): void;
}

export interface ChatViewState {
  readonly messages: readonly ChatMessage[];
  readonly loading: boolean;
  readonly sceneStatus: ChatSceneStatus;
}

export type InventoryProvider = () => readonly SearchableObject[] | null;
export type ChatSearch = (inventory: readonly SearchableObject[], query: SearchQuery) => SearchResult;

const ANNOTATION_SCOPE = "Search covers annotations in the current scene only; unannotated objects aren't included.";

/** Orchestrates parsing, deterministic matching, and user-facing chat messages. */
export class ChatController {
  private messages: ChatMessage[] = [];
  private loading = false;
  private sceneStatus: ChatSceneStatus = "loading";
  private sceneVersion = 0;
  private messageSequence = 0;
  private readonly getInventory: InventoryProvider;
  private readonly onChange: (state: ChatViewState) => void;
  private readonly search: ChatSearch;
  private readonly yieldToRender: () => Promise<void>;
  private readonly selectionAdapter: ChatSelectionAdapter | undefined;

  constructor(
    getInventory: InventoryProvider,
    onChange: (state: ChatViewState) => void,
    search: ChatSearch = searchObjects,
    yieldToRender: () => Promise<void> = () => Promise.resolve(),
    selectionAdapter?: ChatSelectionAdapter,
  ) {
    this.selectionAdapter = selectionAdapter;
    this.getInventory = getInventory;
    this.onChange = onChange;
    this.search = search;
    this.yieldToRender = yieldToRender;
    this.pushMessage("assistant", `Ask about an annotated object. ${ANNOTATION_SCOPE}`);
    this.emit();
  }

  getState(): ChatViewState {
    return { messages: [...this.messages], loading: this.loading, sceneStatus: this.sceneStatus };
  }

  async submitQuery(message: string): Promise<void> {
    if (this.loading) return;
    this.pushMessage("user", message.trim());
    // A submitted search starts from an explicitly unselected state. This
    // prevents a previous search's emphasis from surviving into a new query.
    this.clearSelection();
    if (!message.trim()) {
      this.pushMessage("assistant", "Enter an object to search for, such as “chair”.");
      this.emit();
      return;
    }

    if (this.sceneStatus !== "ready") {
      this.pushMessage("assistant", this.sceneStatus === "loading"
        ? "The scene is still loading. Try again when it is ready."
        : "The current scene is unavailable, so its annotations can't be searched.");
      this.emit();
      return;
    }

    const parsed = parseLocalQuery(message);
    if (!parsed.ok) {
      this.pushMessage("assistant", parsed.reason);
      this.emit();
      return;
    }

    const version = this.sceneVersion;
    this.loading = true;
    this.emit();
    try {
      await this.yieldToRender();
      if (version !== this.sceneVersion) return;
      const inventory = this.getInventory();
      if (!inventory) {
        this.pushMessage("assistant", "The current scene is unavailable, so its annotations can't be searched.");
        return;
      }
      const result = this.search(inventory, parsed.query);
      this.pushSearchResponse(result, inventory, parsed.query.quantifier ?? "all");
    } catch (error) {
      console.error("Spatial Search failed:", error);
      this.pushMessage("assistant", "Search couldn't be completed. Please try a simpler object name.");
    } finally {
      if (version === this.sceneVersion) {
        this.loading = false;
        this.emit();
      }
    }
  }

  clearConversation(): void {
    this.clearSelection();
    this.messages = [];
    this.pushMessage("assistant", `Conversation cleared. ${ANNOTATION_SCOPE}`);
    this.emit();
  }

  setSceneStatus(status: ChatSceneStatus): void {
    this.clearSelection();
    this.sceneVersion++;
    this.sceneStatus = status;
    this.loading = false;
    if (status === "loading") {
      this.messages = [];
      this.pushMessage("assistant", "Loading the current scene's annotations…");
    } else if (status === "ready") {
      this.messages = [];
      this.pushMessage("assistant", `Scene ready. ${ANNOTATION_SCOPE}`);
    } else {
      this.messages = [];
      this.pushMessage("assistant", "Scene unavailable. Load a scene with annotations to search.");
    }
    this.emit();
  }

  selectAnnotation(annotationId: string): void {
    if (this.sceneStatus !== "ready") return;
    const inventory = this.getInventory();
    const isValid = inventory?.some((object) => object.objectId === annotationId) ?? false;
    this.selectionAdapter?.setChatSelection(isValid ? [annotationId] : []);
  }

  selectAnnotations(annotationIds: readonly string[]): void {
    if (this.sceneStatus !== "ready") return;
    const inventory = this.getInventory();
    if (!inventory) {
      this.selectionAdapter?.clearChatSelection();
      return;
    }
    const validIds = new Set(inventory.map((object) => object.objectId));
    const requested = Array.isArray(annotationIds)
      ? annotationIds.filter((annotationId) => validIds.has(annotationId))
      : [];
    this.selectionAdapter?.setChatSelection(requested);
  }

  clearSelection(): void {
    this.selectionAdapter?.clearChatSelection();
  }

  /** Reconcile displayed hit rows after annotation creation or deletion. */
  inventoryChanged(): void {
    const inventory = this.getInventory();
    if (!inventory) return;
    const byId = new Map(inventory.map((object) => [object.objectId, object.semanticLabel]));
    this.messages = this.messages.map((message) => {
      if (!message.results) return message;
      const results = message.results.flatMap((item) => {
        const label = byId.get(item.annotationId);
        return label === undefined ? [] : [{ ...item, label }];
      });
      if (results.length === message.results.length) return message;
      if (results.length === 0) {
        return { id: message.id, role: "assistant" as const, text: "Those annotations are no longer in the current scene." };
      }
      const isUnique = results.length === 1 && message.quantifier === "one";
      const currentResults = isUnique
        ? results.map((item) => ({ ...item, status: "matched" as const }))
        : results;
      return {
        ...message,
        text: isUnique
          ? "Found 1 matching annotation. Results updated after an annotation change."
          : `Found ${results.length} matching annotation${results.length === 1 ? "" : "s"}. Results updated after an annotation change.`,
        results: currentResults,
      };
    });
    this.emit();
  }

  private pushSearchResponse(
    result: SearchResult,
    inventory: readonly SearchableObject[],
    quantifier: SearchQuery["quantifier"],
  ): void {
    if (result.status === "no-match") {
      this.pushMessage("assistant", "No matching annotated objects found.");
      return;
    }
    const byId = new Map(inventory.map((object) => [object.objectId, object.semanticLabel]));
    const matchStatus = result.status as "matched" | "ambiguous";
    const results = result.annotationIds.flatMap((annotationId) => {
      const label = byId.get(annotationId);
      return label === undefined ? [] : [{
        annotationId,
        label,
        status: matchStatus,
      }];
    });
    const text = result.status === "ambiguous"
      ? `I found ${result.matchCount} matching objects. Please narrow your search.`
      : `Found ${result.matchCount} matching annotation${result.matchCount === 1 ? "" : "s"}.`;
    this.messages.push({
      id: ++this.messageSequence,
      role: "assistant",
      text,
      results,
      quantifier,
    });
  }

  private pushMessage(role: ChatMessage["role"], text: string): void {
    this.messages.push({ id: ++this.messageSequence, role, text });
  }

  private emit(): void {
    this.onChange(this.getState());
  }
}
