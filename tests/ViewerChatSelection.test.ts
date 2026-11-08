import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ChatAnnotationSelection } from "../src/viewer/ChatAnnotationSelection.ts";

const validIds = new Set(["annotation-1", "annotation-2", "annotation-3"]);

describe("Viewer chat annotation selection state", () => {
  test("selects one valid annotation", () => {
    const selection = new ChatAnnotationSelection();
    assert.deepEqual(selection.set(["annotation-2"], validIds), ["annotation-2"]);
    assert.equal(selection.has("annotation-2"), true);
  });

  test("selects multiple annotations in request order", () => {
    const selection = new ChatAnnotationSelection();
    assert.deepEqual(selection.set(["annotation-3", "annotation-1"], validIds), [
      "annotation-3", "annotation-1",
    ]);
  });

  test("clearing an existing selection is reported and complete", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1"], validIds);
    assert.equal(selection.clear(), true);
    assert.equal(selection.clear(), false);
    assert.deepEqual(selection.getSelectedIds(), []);
  });

  test("ignores invalid and stale annotation IDs", () => {
    const selection = new ChatAnnotationSelection();
    assert.deepEqual(selection.set(["missing", "annotation-1"], validIds), ["annotation-1"]);
  });

  test("ignores duplicate IDs", () => {
    const selection = new ChatAnnotationSelection();
    assert.deepEqual(selection.set(["annotation-1", "annotation-1"], validIds), ["annotation-1"]);
  });

  test("supports an empty selection", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1"], validIds);
    assert.deepEqual(selection.set([], validIds), []);
    assert.equal(selection.has("annotation-1"), false);
  });

  test("deleting a selected annotation removes only that ID", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1", "annotation-2"], validIds);
    assert.equal(selection.remove("annotation-1"), true);
    assert.equal(selection.remove("annotation-1"), false);
    assert.deepEqual(selection.getSelectedIds(), ["annotation-2"]);
  });

  test("clear-all removes every selected annotation ID", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1", "annotation-2", "annotation-3"], validIds);
    assert.equal(selection.clear(), true);
    assert.deepEqual(selection.getSelectedIds(), []);
  });

  test("world reload can reset the selection through clear", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1"], validIds);
    selection.clear();
    assert.deepEqual(selection.set(["annotation-1"], new Set()), []);
  });

  test("repeated selection operations replace rather than accumulate state", () => {
    const selection = new ChatAnnotationSelection();
    selection.set(["annotation-1"], validIds);
    selection.set(["annotation-2", "annotation-3"], validIds);
    assert.deepEqual(selection.getSelectedIds(), ["annotation-2", "annotation-3"]);
    selection.set(["annotation-1"], validIds);
    assert.deepEqual(selection.getSelectedIds(), ["annotation-1"]);
  });

  test("rejects malformed input without silently matching everything", () => {
    const selection = new ChatAnnotationSelection();
    assert.throws(() => selection.set(null as never, validIds), TypeError);
  });
});
