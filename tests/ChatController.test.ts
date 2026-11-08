import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChatController, type ChatViewState } from "../src/chat/ChatController.ts";
import type { SearchableObject } from "../src/spatial/types.ts";

const inventory: SearchableObject[] = [
  { objectId: "annotation-1", semanticLabel: "Sofa", attributes: { obb: "cluster", color: "red" } },
  { objectId: "annotation-2", semanticLabel: "Round Marble Table", attributes: { obb: "cluster", material: "marble" } },
  { objectId: "annotation-3", semanticLabel: "Sofa", attributes: { obb: "point" } },
];

function setup() {
  let currentInventory: readonly SearchableObject[] | null = inventory;
  let state: ChatViewState | undefined;
  const controller = new ChatController(() => currentInventory, (next) => { state = next; });
  return {
    controller,
    get state() { return state!; },
    set inventory(value: readonly SearchableObject[] | null) { currentInventory = value; },
  };
}

describe("ChatController", () => {
  test("renders matched hits with labels and annotation IDs", async () => {
    const h = setup();
    h.controller.setSceneStatus("ready");
    await h.controller.submitQuery("find table");
    const reply = h.state.messages.at(-1)!;
    assert.equal(reply.text, "Found 1 matching annotation.");
    assert.deepEqual(reply.results, [{ annotationId: "annotation-2", label: "Round Marble Table", status: "matched" }]);
  });

  test("renders every ambiguous candidate and a no-match reply", async () => {
    const h = setup();
    h.controller.setSceneStatus("ready");
    await h.controller.submitQuery("the sofa");
    const ambiguous = h.state.messages.at(-1)!;
    assert.match(ambiguous.text, /multiple|2 matching/i);
    assert.deepEqual(ambiguous.results?.map(({ annotationId, status }) => [annotationId, status]), [
      ["annotation-1", "ambiguous"], ["annotation-3", "ambiguous"],
    ]);
    await h.controller.submitQuery("bed");
    assert.equal(h.state.messages.at(-1)?.text, "No matching annotated objects found.");
  });

  test("validates empty and unsupported queries without searching", async () => {
    const h = setup();
    h.controller.setSceneStatus("ready");
    await h.controller.submitQuery("   ");
    assert.match(h.state.messages.at(-1)!.text, /enter an object/i);
    await h.controller.submitQuery("annotated objects");
    assert.match(h.state.messages.at(-1)!.text, /couldn't identify/i);
  });

  test("updates old result rows when annotations are deleted", async () => {
    const h = setup();
    h.controller.setSceneStatus("ready");
    await h.controller.submitQuery("sofas");
    h.inventory = [inventory[0]!, inventory[1]!];
    h.controller.inventoryChanged();
    const reply = h.state.messages.at(-1)!;
    assert.match(reply.text, /updated after an annotation change/i);
    assert.deepEqual(reply.results?.map((item) => item.annotationId), ["annotation-1"]);
  });

  test("scene reload invalidates in-flight results and clears prior conversation", async () => {
    let resume!: () => void;
    let state: ChatViewState | undefined;
    const controller = new ChatController(() => inventory, (next) => { state = next; }, undefined, () => new Promise<void>((resolve) => { resume = resolve; }));
    controller.setSceneStatus("ready");
    const pending = controller.submitQuery("sofa");
    controller.setSceneStatus("loading");
    resume();
    await pending;
    assert.equal(state!.sceneStatus, "loading");
    assert.equal(state!.messages.some((message) => message.results?.length), false);
  });

  test("reports an unavailable scene", async () => {
    const h = setup();
    h.controller.setSceneStatus("unavailable");
    await h.controller.submitQuery("chair");
    assert.match(h.state.messages.at(-1)!.text, /unavailable/i);
  });
});
