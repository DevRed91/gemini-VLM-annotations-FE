import type { LiveWorldState } from "../viewer/SnapshotBinding.ts";
import { StaleSnapshotError } from "../viewer/SnapshotBinding.ts";
import { generateSnapshotRay, type SnapshotVector3, type ViewSnapshot } from "../viewer/ViewSnapshot.ts";
import type { PixelBox, RleMask, SegmentPrompts, SegmentRequest, SegmentResponse } from "./contract.ts";
import {
  assertCaptureCurrent,
  classifyVisibility,
  lineOfSight,
  positivePoint,
  projectAnchorToImage,
  type CastFn,
  type ProjectedAnchor,
  type VisibilityCheck,
} from "./geometry.ts";
import { maskContains, maskIou, maskStats, type MaskStats } from "./maskAnalysis.ts";

/**
 * Experimental geometry-guided segmentation: project ONE 3D anchor into each
 * captured view, prompt SAM 3 several ways, and record what comes back.
 *
 * The harness makes no claim about which variant is right. There is no ground
 * truth here; it reports observable facts (does the mask contain the anchor,
 * how big is it, do variants agree, do the masks of different views point at
 * the same place in 3D) so a human can judge the images.
 */

export const VARIANTS = ["text", "point", "point+text", "box", "point+box"] as const;
export type VariantId = (typeof VARIANTS)[number];

/** Variants that need no extra model call; box variants cost one Gemini call per view. */
export const DEFAULT_VARIANTS: readonly VariantId[] = ["text", "point", "point+text"];

export interface ViewInput {
  readonly slot: string;
  readonly snapshot: ViewSnapshot;
}

export interface ExperimentDeps {
  readonly live: LiveWorldState;
  readonly cast: CastFn;
  readonly segment: (request: SegmentRequest) => Promise<SegmentResponse>;
  /**
   * Source of the box for `box` / `point+box` (e.g. Gemini). It is given the
   * projected anchor, so a box obtained this way is NOT free of geometric
   * guidance; the result records that.
   */
  readonly detectBox?: (view: ViewInput, projected: { x: number; y: number }) => Promise<PixelBox | null>;
  readonly onProgress?: (message: string) => void;
}

export interface ExperimentConfig {
  readonly anchor: SnapshotVector3;
  /** Semantic text prompt (e.g. "pillow"). Required by text variants. */
  readonly text: string;
  readonly variants: readonly VariantId[];
  /** "send": prompt even when the anchor is occluded in that view (recorded). "skip": do not. */
  readonly occlusionPolicy: "send" | "skip";
  readonly returnMultiple?: boolean;
}

export interface MaskResult {
  readonly score: number | null;
  readonly stats: MaskStats;
  readonly containsAnchor: boolean;
}

export interface VariantResult {
  readonly variant: VariantId;
  readonly status: "ok" | "skipped" | "error";
  readonly reason?: string;
  readonly prompts?: SegmentPrompts;
  readonly provider?: string;
  readonly mock?: boolean;
  readonly masks: readonly MaskResult[];
  /** Index into `masks`: best-scoring mask containing the anchor, else best-scoring overall. */
  readonly primary: number | null;
  /** Primary mask (kept in memory for display; dropped from exports). */
  readonly primaryMask?: RleMask;
}

export interface ViewResult {
  readonly slot: string;
  readonly snapshotId: string;
  readonly imageSize: { width: number; height: number };
  readonly stale: string | null;
  readonly projection: ProjectedAnchor | null;
  readonly visibility: VisibilityCheck | null;
  readonly variants: readonly VariantResult[];
}

export interface CentroidProbe {
  readonly variant: VariantId;
  readonly slot: string;
  readonly centroidInsideMask: boolean;
  /** First splat hit through the primary mask's centroid; null when the ray hit nothing. */
  readonly hit: SnapshotVector3 | null;
  readonly distanceToAnchor: number | null;
}

export interface ExperimentResult {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly config: ExperimentConfig;
  readonly views: readonly ViewResult[];
  /** Pairwise IoU between variants' primary masks, per view. */
  readonly agreement: readonly { slot: string; a: VariantId; b: VariantId; iou: number | null }[];
  /** Where each view's primary mask centroid lands in 3D, per variant (a consistency indicator, not a score). */
  readonly centroidProbes: readonly CentroidProbe[];
  /** Per variant: largest pairwise distance between that variant's centroid hits across views (null if < 2 hits). */
  readonly crossViewSpread: readonly { variant: VariantId; spread: number | null; views: number }[];
}

const needsText = (v: VariantId) => v === "text" || v === "point+text";
const needsPoint = (v: VariantId) => v === "point" || v === "point+text" || v === "point+box";
const needsBox = (v: VariantId) => v === "box" || v === "point+box";

function skipped(variant: VariantId, reason: string): VariantResult {
  return { variant, status: "skipped", reason, masks: [], primary: null };
}

export function choosePrimary(masks: readonly MaskResult[]): number | null {
  if (masks.length === 0) return null;
  const rank = (m: MaskResult) => m.score ?? 0;
  const pick = (candidates: number[]) =>
    candidates.reduce((best, i) => (rank(masks[i]) > rank(masks[best]) ? i : best), candidates[0]);
  const inside = masks.map((m, i) => (m.containsAnchor ? i : -1)).filter((i) => i >= 0);
  return pick(inside.length > 0 ? inside : masks.map((_, i) => i));
}

async function runVariant(
  variant: VariantId,
  view: ViewInput,
  projected: { x: number; y: number },
  config: ExperimentConfig,
  deps: ExperimentDeps,
): Promise<VariantResult> {
  const { snapshot } = view;
  const text = config.text.trim();
  if (needsText(variant) && !text) return skipped(variant, "no text label provided");

  let box: PixelBox | null = null;
  if (needsBox(variant)) {
    if (!deps.detectBox) return skipped(variant, "no box source configured");
    try {
      box = await deps.detectBox(view, projected);
    } catch (error) {
      return { variant, status: "error", reason: `box source failed: ${(error as Error).message}`, masks: [], primary: null };
    }
    if (!box) return skipped(variant, "box source returned no box around the projected anchor");
  }

  const prompts: SegmentPrompts = {
    ...(needsText(variant) ? { text } : {}),
    ...(needsPoint(variant) ? { points: [positivePoint(projected)] } : {}),
    ...(box ? { boxes: [box] } : {}),
  };
  const request: SegmentRequest = {
    image: snapshot.image.dataUrl,
    imageWidth: snapshot.image.width,
    imageHeight: snapshot.image.height,
    prompts,
    returnMultiple: config.returnMultiple ?? false,
  };

  let response: SegmentResponse;
  try {
    response = await deps.segment(request);
  } catch (error) {
    return { variant, status: "error", reason: (error as Error).message, prompts, masks: [], primary: null };
  }

  const masks: MaskResult[] = response.masks.map((m) => ({
    score: m.score,
    stats: maskStats(m.mask),
    containsAnchor: maskContains(m.mask, projected.x, projected.y),
  }));
  const primary = choosePrimary(masks);
  return {
    variant,
    status: "ok",
    prompts,
    provider: response.provider,
    mock: response.mock,
    masks,
    primary,
    ...(primary !== null ? { primaryMask: response.masks[primary].mask } : {}),
  };
}

export async function runExperiment(
  views: readonly ViewInput[],
  config: ExperimentConfig,
  deps: ExperimentDeps,
): Promise<ExperimentResult> {
  const startedAt = new Date().toISOString();
  const generation = deps.live.worldGeneration;
  const viewResults: ViewResult[] = [];

  for (const view of views) {
    const { snapshot, slot } = view;
    const base = {
      slot,
      snapshotId: snapshot.id,
      imageSize: { width: snapshot.image.width, height: snapshot.image.height },
    };
    try {
      assertCaptureCurrent(snapshot, deps.live);
    } catch (error) {
      if (!(error instanceof StaleSnapshotError)) throw error;
      viewResults.push({ ...base, stale: error.message, projection: null, visibility: null, variants: [] });
      continue;
    }

    const projection = projectAnchorToImage(snapshot, config.anchor, generation);
    deps.onProgress?.(`${slot}: anchor ${projection.status}`);
    if (projection.status !== "in-view" || !projection.image) {
      viewResults.push({
        ...base,
        stale: null,
        projection,
        visibility: null,
        variants: config.variants.map((v) => skipped(v, `anchor is ${projection.status.replace("-", " ")} in this view`)),
      });
      continue;
    }

    const los = lineOfSight(snapshot, config.anchor);
    const visibility = classifyVisibility(deps.cast(los.origin, los.direction), projection.cameraDistance);
    deps.onProgress?.(`${slot}: anchor ${visibility.visibility}`);

    const variants: VariantResult[] = [];
    for (const variant of config.variants) {
      if (visibility.visibility === "occluded" && config.occlusionPolicy === "skip") {
        variants.push(skipped(variant, `anchor occluded in this view (${visibility.note})`));
        continue;
      }
      deps.onProgress?.(`${slot}: ${variant}…`);
      variants.push(await runVariant(variant, view, projection.image, config, deps));
    }
    viewResults.push({ ...base, stale: null, projection, visibility, variants });
  }

  // Variant agreement within each view.
  const agreement: ExperimentResult["agreement"][number][] = [];
  for (const view of viewResults) {
    const withMask = view.variants.filter((v) => v.primaryMask);
    for (let i = 0; i < withMask.length; i++) {
      for (let j = i + 1; j < withMask.length; j++) {
        agreement.push({
          slot: view.slot,
          a: withMask[i].variant,
          b: withMask[j].variant,
          iou: maskIou(withMask[i].primaryMask!, withMask[j].primaryMask!),
        });
      }
    }
  }

  // Cross-view consistency: through each primary mask's centroid, where does a
  // ray land in 3D? If masks track one object their centroids land near each
  // other (and the anchor). Centroids of non-convex masks can fall off the
  // object, so this is an indicator, not a score.
  const centroidProbes: CentroidProbe[] = [];
  for (const view of viewResults) {
    const snapshot = views.find((v) => v.slot === view.slot)!.snapshot;
    for (const variant of view.variants) {
      const mask = variant.primaryMask;
      const stats = mask ? maskStats(mask) : null;
      if (!mask || !stats?.centroid) continue;
      const { x, y } = stats.centroid;
      const ray = generateSnapshotRay(snapshot, x / snapshot.image.width, y / snapshot.image.height, generation);
      const first = deps.cast(ray.origin, ray.direction)[0];
      const hit = first ? first.point : null;
      centroidProbes.push({
        variant: variant.variant,
        slot: view.slot,
        centroidInsideMask: maskContains(mask, x, y),
        hit,
        distanceToAnchor: hit ? Math.hypot(hit.x - config.anchor.x, hit.y - config.anchor.y, hit.z - config.anchor.z) : null,
      });
    }
  }
  const crossViewSpread = config.variants.map((variant) => {
    const hits = centroidProbes.filter((p) => p.variant === variant && p.hit).map((p) => p.hit!);
    let spread: number | null = null;
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        const d = Math.hypot(hits[i].x - hits[j].x, hits[i].y - hits[j].y, hits[i].z - hits[j].z);
        spread = spread === null ? d : Math.max(spread, d);
      }
    }
    return { variant, spread, views: hits.length };
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    views: viewResults,
    agreement,
    centroidProbes,
    crossViewSpread,
  };
}

/** JSON-safe export: drops mask run data, keeps every statistic and prompt. */
export function exportExperiment(result: ExperimentResult): unknown {
  return JSON.parse(
    JSON.stringify(result, (key, value) => (key === "primaryMask" ? undefined : value)),
  );
}
