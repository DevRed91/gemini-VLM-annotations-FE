import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

// Loaded dynamically so the TS/spark loader hooks above are active.
const { GaussianObjectHighlighter } = await import("../src/utils/gaussianObjectHighlighter.ts");
const { OBB } = await import("../src/utils/obb.ts");
const { SplatMesh } = (await import("./helpers/fakeSpark.ts")) as typeof import("./helpers/fakeSpark.ts");

const makeSplat = (n = 20) =>
  new SplatMesh(Array.from({ length: n }, (_, i) => ({ center: [i * 0.1, 0, 0] as [number, number, number] })));
const make = async (n = 20) => {
  const splat = makeSplat(n);
  const highlighter = await GaussianObjectHighlighter.create(splat as never);
  return { splat, highlighter };
};
const ids = (a: Uint32Array) => Array.from(a);

describe("GaussianObjectHighlighter.selectIndices", () => {
  test("writes exact indices, deduplicated and sorted, and reports what it dropped", async () => {
    const { highlighter } = await make();
    const result = await highlighter.selectIndices("sofa", [7, 3, 3, 5, 99, -1, 2.5, 7]);
    assert.ok(result);
    assert.equal(result.mode, "indices");
    assert.equal(result.acceptedCount, 3);
    assert.equal(result.invalidCount, 3); // 99, -1, 2.5
    assert.equal(result.duplicateCount, 2);
    assert.deepEqual(ids(highlighter.mask.getSelectedIds(result.labelId)), [3, 5, 7]);
    assert.deepEqual(ids(highlighter.getIndexSelection("sofa")!.selectedIds), [3, 5, 7]);
    assert.equal(highlighter.mask.getLabelAt(5), result.labelId);
    assert.equal(highlighter.mask.getLabelAt(4), 0);
  });

  test("accepts a Uint32Array and does not alias the caller's buffer", async () => {
    const { highlighter } = await make();
    const input = Uint32Array.from([4, 1]);
    const pending = highlighter.selectIndices("a", input);
    input[0] = 9; // mutate after the call, before the queue runs
    const result = await pending;
    assert.deepEqual(ids(highlighter.mask.getSelectedIds(result!.labelId)), [1, 4]);
  });

  test("same objectId keeps its label and replaces membership; new ids get new labels", async () => {
    const { highlighter } = await make();
    const a1 = (await highlighter.selectIndices("a", [1, 2]))!;
    const b = (await highlighter.selectIndices("b", [10]))!;
    const a2 = (await highlighter.selectIndices("a", [3]))!;
    assert.equal(a1.labelId, a2.labelId);
    assert.notEqual(a1.labelId, b.labelId);
    assert.deepEqual(ids(highlighter.mask.getSelectedIds(a1.labelId)), [3]);
    assert.equal(highlighter.mask.getLabelAt(1), 0);
    assert.equal(highlighter.getLabelForObject("a"), a1.labelId);
  });

  test("overlap: the most recent selection wins, and clearing it restores the other", async () => {
    const { highlighter } = await make();
    const a = (await highlighter.selectIndices("a", [1, 2, 3]))!;
    const b = (await highlighter.selectIndices("b", [3, 4]))!;
    assert.equal(highlighter.mask.getLabelAt(3), b.labelId);
    assert.equal(highlighter.mask.getLabelAt(2), a.labelId);
    await highlighter.clear(b.labelId);
    assert.equal(highlighter.mask.getLabelAt(3), a.labelId);
    assert.equal(highlighter.mask.getLabelAt(4), 0);
  });

  test("labels are never reused within a world, including after clear and alongside select(obb)", async () => {
    const { highlighter } = await make();
    const a = (await highlighter.selectIndices("a", [1]))!;
    await highlighter.clear(a.labelId);
    const b = (await highlighter.selectIndices("b", [2]))!;
    assert.notEqual(b.labelId, a.labelId);
    const obbSelection = (await highlighter.select(new OBB({ position: new THREE.Vector3(0.5, 0, 0), size: new THREE.Vector3(0.4, 0.4, 0.4) })))!;
    assert.ok(![a.labelId, b.labelId].includes(obbSelection.objectId));
    // Re-selecting a cleared id reuses its own stable label, never anyone else's.
    const a2 = (await highlighter.selectIndices("a", [5]))!;
    assert.equal(a2.labelId, a.labelId);
    assert.equal(highlighter.size, 3);
  });

  test("clear(label) removes only that object; clearAll removes every kind", async () => {
    const { highlighter } = await make();
    const a = (await highlighter.selectIndices("a", [1, 2]))!;
    const b = (await highlighter.selectIndices("b", [8, 9]))!;
    await highlighter.clear(a.labelId);
    assert.equal(highlighter.getIndexSelection("a"), undefined);
    assert.deepEqual(ids(highlighter.mask.selectedIds), [8, 9]);
    assert.equal(highlighter.listIndexSelections().length, 1);
    await highlighter.clearAll();
    assert.equal(highlighter.mask.count, 0);
    assert.equal(highlighter.size, 0);
    assert.equal(highlighter.getIndexSelection("b"), undefined);
    assert.ok(b);
  });

  test("a queued request is dropped by clearAll or dispose and never mutates the mask", async () => {
    const { highlighter } = await make();
    const stale = highlighter.selectIndices("a", [1, 2, 3]);
    const clearing = highlighter.clearAll();
    assert.equal(await stale, null);
    await clearing;
    assert.equal(highlighter.mask.count, 0);

    const pending = highlighter.selectIndices("b", [4]);
    highlighter.dispose();
    assert.equal(await pending, null);
    assert.equal(await highlighter.selectIndices("c", [5]), null);
    assert.equal(highlighter.size, 0);
    assert.equal(highlighter.isDisposed, true);
  });

  test("clearing an object invalidates its own in-flight update", async () => {
    const { highlighter } = await make();
    const a = (await highlighter.selectIndices("a", [1]))!;
    const update = highlighter.selectIndices("a", [2]);
    const clearing = highlighter.clear(a.labelId);
    assert.equal(await update, null);
    await clearing;
    assert.equal(highlighter.mask.count, 0);
  });

  test("an empty selection clears the object's previous membership", async () => {
    const { highlighter } = await make();
    await highlighter.selectIndices("a", [1, 2]);
    const result = (await highlighter.selectIndices("a", []))!;
    assert.equal(result.acceptedCount, 0);
    assert.equal(highlighter.mask.count, 0);
    assert.equal(highlighter.getIndexSelection("a"), undefined);
  });

  test("LOD splat: rejects without a fallback, returns the OBB without masking when given one", async () => {
    const { splat, highlighter } = await make();
    splat.enableLod = true;
    await assert.rejects(highlighter.selectIndices("a", [1, 2]), /non-LOD/);

    const obb = new OBB({ position: new THREE.Vector3(1, 2, 3), size: new THREE.Vector3(1, 1, 1) });
    const result = (await highlighter.selectIndices("a", [1, 2], { fallbackObb: obb }))!;
    assert.equal(result.mode, "obb-fallback");
    assert.equal(result.acceptedCount, 0);
    assert.equal(result.labelId, 0);
    assert.match(result.fallbackReason!, /enableLod/);
    assert.deepEqual(result.fallbackObb!.position.toArray(), [1, 2, 3]);
    assert.notEqual(result.fallbackObb, obb);
    assert.equal(highlighter.mask.count, 0);
    assert.equal(highlighter.getLabelForObject("a"), undefined); // no label consumed
  });

  test("paged splat takes the same fallback path", async () => {
    const { splat, highlighter } = await make();
    splat.paged = true;
    const obb = new OBB({ position: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1) });
    const result = (await highlighter.selectIndices("a", [1], { fallbackObb: obb }))!;
    assert.equal(result.mode, "obb-fallback");
    assert.match(result.fallbackReason!, /paged/);
  });

  test("rejects malformed arguments synchronously and exhausts at 255 labels", async () => {
    const { highlighter } = await make();
    assert.throws(() => highlighter.selectIndices("", [1]), TypeError);
    assert.throws(() => highlighter.selectIndices("x", null as never), TypeError);
    for (let i = 0; i < 255; i++) await highlighter.selectIndices(`o${i}`, [i % 20]);
    assert.throws(() => highlighter.selectIndices("one-too-many", [1]), RangeError);
  });
});
