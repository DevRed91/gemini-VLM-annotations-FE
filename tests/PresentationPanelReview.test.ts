import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { PresentationPanel, type PresentationModel } from "../src/demo/PresentationPanel.ts";
import type { MultiViewObjectDetection } from "../src/demo/multiViewDetection.ts";

class FakeEl {
  children: FakeEl[] = [];
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  src = "";
  alt = "";
  disabled = false;
  type = "";
  isConnected = false;
  listeners = new Map<string, Array<() => void>>();
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: FakeEl[]) { for (const n of nodes) n.isConnected = true; this.children.push(...nodes); }
  replaceChildren(...nodes: FakeEl[]) { this.children = [...nodes]; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { for (const fn of this.listeners.get("click") ?? []) fn(); }
  remove() {}
}

function objects(node: FakeEl): FakeEl[] {
  return [...(node.className.startsWith("pres__object") && node.tag === "button" ? [node] : []), ...node.children.flatMap(objects)];
}
function descendants(node: FakeEl): FakeEl[] { return [node, ...node.children.flatMap(descendants)]; }

const detections: MultiViewObjectDetection[] = [
  { id: "a", label: "A", description: "first", observations: [] },
  { id: "b", label: "B", description: "second", observations: [] },
];

function model(overrides: Partial<PresentationModel> = {}): PresentationModel {
  return {
    sceneLabel: "scene", captures: [null, null, null], detections,
    detectionResultAvailable: true, detectionLoading: false, detectionError: "",
    reviewOpen: true, selectedObjectId: null, selectionConfirmed: false, selectionPlacing: false, ...overrides,
  };
}

describe("PresentationPanel review list", () => {
  const g = globalThis as Record<string, unknown>;
  let previous: unknown;
  beforeEach(() => {
    previous = g.document;
    g.document = { createElement: (tag: string) => new FakeEl(tag), head: new FakeEl("head"), body: new FakeEl("body") };
  });
  afterEach(() => { g.document = previous; });

  test("periodic re-renders keep the same buttons so a click is not swallowed", () => {
    const selected: string[] = [];
    const panel = new PresentationPanel({
      capture() {}, sendToGemini() {}, closeReview() {}, openReview() {}, continueWithSelectedObject() {},
      selectObject: (id) => selected.push(id),
    });
    const root = panel.root as unknown as FakeEl;
    panel.render(model());
    const before = objects(root);
    assert.equal(before.length, 2);
    // The controller re-renders on a ~100 ms tick, i.e. between mousedown and mouseup.
    panel.render(model());
    panel.render(model());
    const after = objects(root);
    assert.deepEqual(after.map((node, i) => node === before[i]), [true, true], "buttons must survive an unchanged re-render");
    after[1].click();
    assert.deepEqual(selected, ["b"]);
  });

  test("selection, confirmation and reopening still rebuild the list", () => {
    const panel = new PresentationPanel({
      capture() {}, sendToGemini() {}, closeReview() {}, openReview() {}, continueWithSelectedObject() {}, selectObject() {},
    });
    const root = panel.root as unknown as FakeEl;
    panel.render(model());
    const first = objects(root)[0];
    panel.render(model({ selectedObjectId: "a" }));
    const selected = objects(root)[0];
    assert.notEqual(selected, first);
    assert.match(selected.className, /is-selected/);
    panel.render(model({ selectedObjectId: "a", reviewOpen: false }));
    panel.render(model({ selectedObjectId: "a" }));
    assert.notEqual(objects(root)[0], selected, "reopening rebuilds");
  });

  test("placement shows a disabled loading CTA and disables object switching", () => {
    const panel = new PresentationPanel({
      capture() {}, sendToGemini() {}, closeReview() {}, openReview() {}, continueWithSelectedObject() {}, selectObject() {},
    });
    const root = panel.root as unknown as FakeEl;
    panel.render(model({ selectedObjectId: "a", selectionConfirmed: true, selectionPlacing: true }));
    const continueButton = descendants(root).find((node) => node.className === "pres__continue");
    assert.ok(continueButton);
    assert.equal(continueButton.textContent, "Placing annotation…");
    assert.equal(continueButton.disabled, true);
    assert.ok(objects(root).every((button) => button.disabled));
  });
});
