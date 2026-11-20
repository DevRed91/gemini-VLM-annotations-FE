import type { ViewObservation } from "./multiViewGaussianLifter.ts";
import { decodeRle } from "./maskAnalysis.ts";
import { validateRleMask } from "./contract.ts";
import type { ExperimentResult, VariantId } from "./experiment.ts";

/** Attach one explicitly selected experiment variant's RLE masks to matching frozen lift views. */
export function attachPrimaryVariantMasks(
  views: readonly ViewObservation[],
  experiment: ExperimentResult,
  variant: VariantId,
): ViewObservation[] {
  return views.map((view) => {
    const result = experiment.views.find((entry) => entry.slot === view.view);
    if (!result || result.stale) return view;
    if (result.snapshotId !== view.snapshot.id) {
      throw new RangeError(`SAM mask snapshot for ${view.view} does not match the lift capture`);
    }
    const selected = result.variants.find((entry) => entry.variant === variant);
    const rle = selected?.primaryMask;
    if (!rle) return view;
    const image = view.snapshot.image;
    const checked = validateRleMask(rle, image.width, image.height);
    return {
      ...view,
      mask: { width: checked.width, height: checked.height, data: decodeRle(checked) },
    };
  });
}
