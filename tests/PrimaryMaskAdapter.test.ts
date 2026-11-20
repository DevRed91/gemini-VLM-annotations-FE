import "./helpers/registerTsLoader.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { attachPrimaryVariantMasks } from "../src/segmentation/primaryMaskAdapter.ts";
import { encodeRle } from "../src/segmentation/maskAnalysis.ts";
import type { ExperimentResult, VariantId } from "../src/segmentation/experiment.ts";
import type { ViewObservation } from "../src/segmentation/multiViewGaussianLifter.ts";
import type { ViewSnapshot } from "../src/viewer/ViewSnapshot.ts";

const snapshot = (id: string, width = 4, height = 3) => ({
  id,
  image: { width, height },
}) as unknown as ViewSnapshot;

function observation(view: ViewObservation["view"], id: string, width = 4, height = 3): ViewObservation {
  return {
    view,
    snapshot: snapshot(id, width, height),
    visible: true,
    bboxNormalized: [0.1, 0.2, 0.8, 0.9],
  };
}

function experiment(
  views: readonly {
    slot: string;
    snapshotId: string;
    stale?: string | null;
    variants: readonly { variant: VariantId; primaryMask?: ReturnType<typeof encodeRle> }[];
  }[],
): ExperimentResult {
  return {
    views: views.map((view) => ({
      ...view,
      stale: view.stale ?? null,
      imageSize: { width: 4, height: 3 },
      projection: null,
      visibility: null,
    })),
  } as unknown as ExperimentResult;
}

describe("primary variant mask adapter", () => {
  test("decodes the explicitly selected variant and maps it by capture slot", () => {
    const front = observation("front", "front-snapshot");
    const side = observation("side", "side-snapshot");
    const chosen = encodeRle(4, 3, new Uint8Array([0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0]));
    const other = encodeRle(4, 3, new Uint8Array(12).fill(1));
    const result = attachPrimaryVariantMasks(
      [front, side],
      experiment([
        { slot: "front", snapshotId: "front-snapshot", variants: [
          { variant: "text", primaryMask: chosen },
          { variant: "point", primaryMask: other },
        ] },
        { slot: "side", snapshotId: "side-snapshot", variants: [] },
      ]),
      "text",
    );
    assert.deepEqual(Array.from(result[0].mask!.data), [0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0]);
    assert.equal(result[0].mask!.width, 4);
    assert.equal(result[0].mask!.height, 3);
    assert.equal(result[0].bboxNormalized, front.bboxNormalized, "box fallback remains available");
    assert.equal(result[1], side, "a slot without a chosen mask is left untouched");
  });

  test("an omitted primary mask preserves the original box-only observation", () => {
    const view = observation("front", "front-snapshot");
    const result = attachPrimaryVariantMasks(
      [view],
      experiment([{ slot: "front", snapshotId: "front-snapshot", variants: [{ variant: "point" }] }]),
      "point",
    );
    assert.equal(result[0], view);
    assert.equal(result[0].mask, undefined);
    assert.deepEqual(result[0].bboxNormalized, [0.1, 0.2, 0.8, 0.9]);
  });

  test("rejects selected masks with dimensions different from the frozen capture", () => {
    const view = observation("front", "front-snapshot");
    const wrongDimensions = encodeRle(2, 6, new Uint8Array(12));
    assert.throws(() => attachPrimaryVariantMasks(
      [view],
      experiment([{ slot: "front", snapshotId: "front-snapshot", variants: [{ variant: "text", primaryMask: wrongDimensions }] }]),
      "text",
    ), /expected 4x3/);
  });

  test("rejects masks captured from a different snapshot and ignores marked stale results", () => {
    const view = observation("front", "current-snapshot");
    const mask = encodeRle(4, 3, new Uint8Array(12));
    assert.throws(() => attachPrimaryVariantMasks(
      [view],
      experiment([{ slot: "front", snapshotId: "old-snapshot", variants: [{ variant: "text", primaryMask: mask }] }]),
      "text",
    ), /snapshot.*does not match/);
    const stale = attachPrimaryVariantMasks(
      [view],
      experiment([{ slot: "front", snapshotId: "old-snapshot", stale: "stale world", variants: [{ variant: "text", primaryMask: mask }] }]),
      "text",
    );
    assert.equal(stale[0], view);
  });
});
