import type {
  MultiViewObjectDetection,
  MultiViewObservation,
  NormalizedDetectionBox,
  SelectedMultiViewObject,
} from "../demo/multiViewDetection.ts";
import type { CaptureSlotId, PresentationCapture } from "../demo/presentationCaptures.ts";
import { StaleSnapshotError, type LiveWorldState } from "../viewer/SnapshotBinding.ts";
import { generateSnapshotRay, type SnapshotVector3, type ViewSnapshot } from "../viewer/ViewSnapshot.ts";
import type { ViewInput } from "./experiment.ts";
import {
  assertCaptureCurrent,
  classifyVisibility,
  lineOfSight,
  probeOffsets,
  projectAnchorToImage,
  refineAnchor,
  type AnchorRefinement,
  type CastFn,
  type Visibility,
} from "./geometry.ts";

/**
 * SemanticTarget -> GeometricAnchor handoff.
 *
 * Two different kinds of knowledge meet here and must not be conflated:
 *
 *   SEMANTIC IDENTIFICATION  (Gemini): "this object, with these labelled 2D
 *     boxes in the Front/Side/Top images". Gemini sees three unrelated JPEGs.
 *     It has NO camera model and NO depth, so its boxes are not 3D evidence,
 *     the centre of a box is not a point on the object, and agreement between
 *     its per-view boxes is a claim, not a measured correspondence.
 *
 *   GEOMETRIC VERIFICATION  (splat + frozen cameras): a world-space point that
 *     was actually hit by a ray against the splat, is stable under small ray
 *     perturbations, is currently valid for this world, and projects into the
 *     OTHER views' Gemini boxes without contradiction.
 *
 * The anchor is derived by casting rays THROUGH the box (never by taking the
 * box centre as a position), then every other view is used as an independent
 * check on it. If any step fails the result is a rejection with a reason; no
 * unverified point is ever returned. The caller falls back to the user-click
 * anchor workflow.
 *
 * Not claimed: that a verified anchor lies on the object Gemini meant. It
 * means the anchor is a real, stable surface point, current for the world, and
 * not contradicted by (and, with the default policy, supported by) at least
 * one independent Gemini box. Loose boxes can still corroborate a wrong
 * neighbour.
 */

export type ViewReason =
  | "source"
  | "inside-box-visible"
  | "inside-box-occluded"
  | "inside-box-visibility-unverified"
  | "outside-box"
  | "anchor-outside-frame"
  | "anchor-behind-camera"
  | "gemini-not-visible-geometry-visible"
  | "gemini-not-visible-consistent"
  | "no-observation"
  | "no-capture"
  | "stale-snapshot";

/** corroborated: independent support. contradicted: independent conflict. neutral: no information. */
export type ViewVerdict = "source" | "corroborated" | "contradicted" | "neutral";

export interface ViewCheck {
  readonly slot: CaptureSlotId;
  readonly captureId: string | null;
  readonly snapshotId: string | null;
  readonly verdict: ViewVerdict;
  readonly reason: ViewReason;
  /** What Gemini said for this view (null: no observation at all, which is not the same as "not visible"). */
  readonly observation: { readonly visible: boolean; readonly box: NormalizedDetectionBox | null } | null;
  /** Where the anchor lands in this capture, normalized top-left image coordinates. */
  readonly projected: { readonly u: number; readonly v: number } | null;
  readonly visibility: Visibility | null;
  /** Other detections with a SMALLER box that also contain the anchor in this view. */
  readonly moreSpecificObjectIds: readonly string[];
}

export type RejectionReason =
  | "stale-snapshot"
  | "no-usable-observation"
  | "no-surface-hit"
  | "unstable-depth"
  | "contradicted"
  | "ambiguous-object"
  | "uncorroborated";

export interface CandidateReport {
  readonly sourceView: CaptureSlotId;
  readonly outcome: "verified" | RejectionReason;
  readonly refinement: AnchorRefinement | null;
  readonly views: readonly ViewCheck[];
}

export interface GeometricAnchor {
  readonly point: SnapshotVector3;
  readonly refinement: AnchorRefinement;
  readonly derivation: {
    readonly kind: "gemini-box-probe";
    readonly sourceView: CaptureSlotId;
    readonly sourceCaptureId: string;
    readonly sourceSnapshotId: string;
    /** The Gemini box rays were cast through. The box centre is NOT the anchor. */
    readonly box: NormalizedDetectionBox;
    readonly probeRays: number;
  };
  readonly worldGeneration: number;
  readonly verification: {
    readonly checkedAtIso: string;
    readonly corroboratingViews: readonly CaptureSlotId[];
    readonly views: readonly ViewCheck[];
    readonly alternates: readonly CandidateReport[];
  };
}

export interface SemanticGeometricHandoff {
  /** Identification, passed through untouched: observations, captures, snapshots, camera metadata. */
  readonly semantic: SelectedMultiViewObject;
  /** Verification: the only 3D position downstream code may use. */
  readonly anchor: GeometricAnchor;
  /** The retained captures as segmentation inputs (same frozen snapshots Gemini saw). */
  readonly views: readonly ViewInput[];
}

export type AssociationOutcome =
  | { readonly status: "verified"; readonly handoff: SemanticGeometricHandoff }
  | {
      readonly status: "rejected";
      readonly reason: RejectionReason;
      readonly message: string;
      readonly candidates: readonly CandidateReport[];
      /** The existing click workflow is always available when association fails. */
      readonly fallback: "user-click";
    };

export interface AssociationOptions {
  /** Independent views that must support the anchor. Default 1. */
  readonly minCorroboratingViews?: number;
  /** Slack around Gemini boxes, as a fraction of the image (boxes are loose). Default 0.03. */
  readonly boxMargin?: number;
  /** Probe ring radius as a fraction of box width/height. Default 0.1 (a small patch around the box centre, inside the box). */
  readonly probeFraction?: number;
  /**
   * The hit cluster is stable when its median spread is at most
   * `stableFactor` x the ring's expected world radius (+ `minSpread`). The
   * threshold scales with the box's world size on purpose: a fixed distance
   * would reject every sofa and accept every scattering on a small object.
   * Assumes a perspective camera (the viewer's only camera).
   */
  readonly stableFactor?: number;
  readonly minSpread?: number;
  /**
   * Share of probe rays that must land within the allowed spread of the chosen
   * point. refineAnchor's median outvotes a minority of strays; here a patch
   * that is a third background is treated as straddling, not as a surface.
   * Default 0.75.
   */
  readonly minInlierFraction?: number;
  readonly now?: () => string;
}

const VIEW_ORDER: readonly CaptureSlotId[] = ["front", "side", "top"];

const boxArea = (b: NormalizedDetectionBox) => (b.xMax - b.xMin) * (b.yMax - b.yMin);
const inBox = (b: NormalizedDetectionBox, u: number, v: number, margin: number) =>
  u >= b.xMin - margin && u <= b.xMax + margin && v >= b.yMin - margin && v <= b.yMax + margin;

function observationOf(object: { observations: readonly MultiViewObservation[] }, view: CaptureSlotId): MultiViewObservation | null {
  return object.observations.find((o) => o.view === view) ?? null;
}

/** Structural checks on the selection itself, before any geometry. */
function assertSelectionWellFormed(selected: SelectedMultiViewObject): Map<CaptureSlotId, PresentationCapture> {
  const bySlot = new Map<CaptureSlotId, PresentationCapture>();
  for (const capture of selected.captures) {
    if (bySlot.has(capture.slot)) throw new TypeError(`Selection has two captures for the ${capture.slot} slot`);
    if (capture.id !== capture.snapshot.id) throw new TypeError(`Capture ${capture.id} does not match its snapshot ${capture.snapshot.id}`);
    bySlot.set(capture.slot, capture);
  }
  return bySlot;
}

function isStale(snapshot: ViewSnapshot, live: LiveWorldState): boolean {
  try {
    assertCaptureCurrent(snapshot, live);
    return false;
  } catch (error) {
    if (error instanceof StaleSnapshotError) return true;
    throw error;
  }
}

function checkView(
  slot: CaptureSlotId,
  capture: PresentationCapture | undefined,
  anchor: SnapshotVector3,
  selected: SelectedMultiViewObject,
  peers: readonly MultiViewObjectDetection[],
  live: LiveWorldState,
  cast: CastFn,
  margin: number,
): ViewCheck {
  const observation = observationOf(selected, slot);
  const observed = observation ? { visible: observation.visible, box: observation.box } : null;
  const base = {
    slot,
    captureId: capture?.id ?? null,
    snapshotId: capture?.snapshot.id ?? null,
    observation: observed,
    projected: null,
    visibility: null,
    moreSpecificObjectIds: [] as string[],
  };
  if (!capture) return { ...base, verdict: "neutral", reason: "no-capture" };
  if (isStale(capture.snapshot, live)) return { ...base, verdict: "neutral", reason: "stale-snapshot" };
  if (!observation) return { ...base, verdict: "neutral", reason: "no-observation" };

  const projection = projectAnchorToImage(capture.snapshot, anchor, live.worldGeneration);
  if (projection.status === "behind-camera" || !projection.normalized) {
    return observation.visible
      ? { ...base, verdict: "contradicted", reason: "anchor-behind-camera" }
      : { ...base, verdict: "neutral", reason: "gemini-not-visible-consistent" };
  }
  const projected = projection.normalized;
  if (projection.status === "outside-frame") {
    return observation.visible
      ? { ...base, projected, verdict: "contradicted", reason: "anchor-outside-frame" }
      : { ...base, projected, verdict: "neutral", reason: "gemini-not-visible-consistent" };
  }

  const los = lineOfSight(capture.snapshot, anchor);
  const visibility = classifyVisibility(cast(los.origin, los.direction), projection.cameraDistance).visibility;

  if (!observation.visible || !observation.box) {
    // Gemini says the object is absent here. Geometry may only disagree when the anchor is plainly in view.
    return visibility === "visible"
      ? { ...base, projected, visibility, verdict: "contradicted", reason: "gemini-not-visible-geometry-visible" }
      : { ...base, projected, visibility, verdict: "neutral", reason: "gemini-not-visible-consistent" };
  }

  if (!inBox(observation.box, projected.u, projected.v, margin)) {
    return { ...base, projected, visibility, verdict: "contradicted", reason: "outside-box" };
  }

  // A smaller detection containing the anchor means the point sits on something
  // more specific than the target (the pillow on the sofa). Only trusted when
  // the anchor is genuinely visible here.
  const moreSpecificObjectIds = visibility !== "visible" ? [] : peers
    .filter((peer) => peer.id !== selected.objectId)
    .filter((peer) => {
      const peerObs = observationOf(peer, slot);
      return !!peerObs?.visible && !!peerObs.box &&
        inBox(peerObs.box, projected.u, projected.v, 0) &&
        boxArea(peerObs.box) < boxArea(observation.box!);
    })
    .map((peer) => peer.id);

  const reason: ViewReason = visibility === "visible" ? "inside-box-visible"
    : visibility === "occluded" ? "inside-box-occluded" : "inside-box-visibility-unverified";
  return {
    ...base,
    projected,
    visibility,
    moreSpecificObjectIds,
    verdict: visibility === "visible" ? "corroborated" : "neutral",
    reason,
  };
}

interface Candidate {
  readonly report: CandidateReport;
  readonly anchor?: GeometricAnchor;
  readonly corroborations: number;
}

function evaluateCandidate(
  sourceView: CaptureSlotId,
  selected: SelectedMultiViewObject,
  peers: readonly MultiViewObjectDetection[],
  captures: ReadonlyMap<CaptureSlotId, PresentationCapture>,
  live: LiveWorldState,
  cast: CastFn,
  options: Required<Omit<AssociationOptions, "now">> & { now: () => string },
): Candidate | null {
  const observation = observationOf(selected, sourceView);
  if (!observation?.visible || !observation.box) return null;
  const capture = captures.get(sourceView);
  const fail = (outcome: RejectionReason, refinement: AnchorRefinement | null, views: ViewCheck[] = []): Candidate => ({
    report: { sourceView, outcome, refinement, views },
    corroborations: 0,
  });
  if (!capture) return null;
  if (isStale(capture.snapshot, live)) return fail("stale-snapshot", null);

  // 1. Rays through the box: surface points actually hit in the splat.
  const { box } = observation;
  const cx = (box.xMin + box.xMax) / 2;
  const cy = (box.yMin + box.yMax) / 2;
  const offsets = probeOffsets((box.xMax - box.xMin) * options.probeFraction, (box.yMax - box.yMin) * options.probeFraction);
  const hits: SnapshotVector3[] = [];
  for (const [du, dv] of offsets) {
    const ray = generateSnapshotRay(capture.snapshot, cx + du, cy + dv, live.worldGeneration);
    const first = cast(ray.origin, ray.direction)[0];
    if (first) hits.push(first.point);
  }
  // Infinite radius: only the medoid, spread and hit count are wanted here; stability is judged below against the box's world size.
  const raw = refineAnchor(hits, offsets.length, Infinity);
  if (!raw) return fail("no-surface-hit", null);
  const edge = (u: number, v: number) => generateSnapshotRay(capture.snapshot, u, v, live.worldGeneration).direction;
  const chord = (a: SnapshotVector3, b: SnapshotVector3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const cam = capture.snapshot.camera.position;
  const depth = Math.hypot(raw.anchor.x - cam.x, raw.anchor.y - cam.y, raw.anchor.z - cam.z);
  const boxWorldSize = depth * Math.max(chord(edge(box.xMin, cy), edge(box.xMax, cy)), chord(edge(cx, box.yMin), edge(cx, box.yMax)));
  const allowedSpread = options.stableFactor * options.probeFraction * boxWorldSize + options.minSpread;
  const inliers = hits.filter((h) => chord(h, raw.anchor) <= allowedSpread).length;
  const refinement: AnchorRefinement = {
    ...raw,
    stable: raw.hitCount >= 3 && raw.spread <= allowedSpread && inliers / offsets.length >= options.minInlierFraction,
  };
  // A box spanning several depth layers (object plus background) yields scattered hits; do not average them.
  if (!refinement.stable) return fail("unstable-depth", refinement);
  const point = refinement.anchor;

  // 2. Every capture checked against the candidate, source included.
  const views: ViewCheck[] = VIEW_ORDER.map((slot) =>
    slot === sourceView
      ? checkSource(slot, capture, point, selected, observation, peers, live, cast, options.boxMargin)
      : checkView(slot, captures.get(slot), point, selected, peers, live, cast, options.boxMargin));

  const contradicted = views.some((v) => v.verdict === "contradicted");
  const specific = views.some((v) => v.moreSpecificObjectIds.length > 0);
  const corroborations = views.filter((v) => v.verdict === "corroborated").length;
  const outcome: Candidate["report"]["outcome"] = contradicted ? "contradicted"
    : specific ? "ambiguous-object"
    : corroborations < options.minCorroboratingViews ? "uncorroborated"
    : "verified";
  const report: CandidateReport = { sourceView, outcome, refinement, views };
  if (outcome !== "verified") return { report, corroborations };

  return {
    report,
    corroborations,
    anchor: {
      point,
      refinement,
      derivation: {
        kind: "gemini-box-probe",
        sourceView,
        sourceCaptureId: capture.id,
        sourceSnapshotId: capture.snapshot.id,
        box,
        probeRays: offsets.length,
      },
      worldGeneration: live.worldGeneration,
      verification: {
        checkedAtIso: options.now(),
        corroboratingViews: views.filter((v) => v.verdict === "corroborated").map((v) => v.slot),
        views,
        alternates: [],
      },
    },
  };
}

/** The source view must reproduce its own box: the anchor projects inside it and is the first thing seen. */
function checkSource(
  slot: CaptureSlotId,
  capture: PresentationCapture,
  anchor: SnapshotVector3,
  selected: SelectedMultiViewObject,
  observation: MultiViewObservation,
  peers: readonly MultiViewObjectDetection[],
  live: LiveWorldState,
  cast: CastFn,
  margin: number,
): ViewCheck {
  const check = checkView(slot, capture, anchor, selected, peers, live, cast, margin);
  if (check.reason === "inside-box-visible") return { ...check, verdict: "source", reason: "source" };
  // Anything else means the anchor does not even reproduce in the view it came from.
  return { ...check, verdict: "contradicted", observation: { visible: observation.visible, box: observation.box } };
}

const REASON_PRIORITY: readonly RejectionReason[] = [
  "ambiguous-object", "contradicted", "uncorroborated", "unstable-depth", "no-surface-hit", "stale-snapshot", "no-usable-observation",
];

const MESSAGES: Record<RejectionReason, string> = {
  "stale-snapshot": "The captures no longer match the current world; recapture Front/Side/Top.",
  "no-usable-observation": "Gemini reported no visible box in any usable capture for this object.",
  "no-surface-hit": "Rays through the Gemini box hit nothing in the splat (scene not settled, or box over empty space).",
  "unstable-depth": "Rays through the Gemini box hit surfaces at scattered depths (object plus background?); no single surface point can be trusted.",
  "contradicted": "The surface point found in one view conflicts with Gemini's boxes in another view; the observations may describe different objects.",
  "ambiguous-object": "The surface point also lies inside a smaller detected object (e.g. an item resting on the target); it may belong to that object instead.",
  "uncorroborated": "No other view independently supports the surface point (object seen in one view only, or hidden in the others).",
};

/**
 * Turn a confirmed Gemini selection into a verified geometric anchor, or say
 * why that is not possible. Synchronous: it only casts a handful of rays
 * (about 10 per candidate view, ~35 ms each on large scenes).
 *
 * `peers` are all detections from the same Gemini response; they are used only
 * to notice that the anchor sits on a different, more specific object.
 */
export function associateSemanticTarget(
  selected: SelectedMultiViewObject,
  peers: readonly MultiViewObjectDetection[],
  deps: { readonly live: LiveWorldState; readonly cast: CastFn },
  opts: AssociationOptions = {},
): AssociationOutcome {
  const options = {
    minCorroboratingViews: opts.minCorroboratingViews ?? 1,
    boxMargin: opts.boxMargin ?? 0.03,
    probeFraction: opts.probeFraction ?? 0.1,
    stableFactor: opts.stableFactor ?? 2,
    minSpread: opts.minSpread ?? 0.005,
    minInlierFraction: opts.minInlierFraction ?? 0.75,
    now: opts.now ?? (() => new Date().toISOString()),
  };
  const captures = assertSelectionWellFormed(selected);

  const candidates: Candidate[] = [];
  for (const view of VIEW_ORDER) {
    const candidate = evaluateCandidate(view, selected, peers, captures, deps.live, deps.cast, options);
    if (candidate) candidates.push(candidate);
  }
  const reports = candidates.map((c) => c.report);

  const verified = candidates
    .filter((c): c is Candidate & { anchor: GeometricAnchor } => c.report.outcome === "verified" && !!c.anchor)
    // Most independent support first, then the tightest hit cluster; ties keep Front, Side, Top order.
    .sort((a, b) => b.corroborations - a.corroborations || a.anchor.refinement.spread - b.anchor.refinement.spread);
  if (verified.length > 0) {
    const best = verified[0];
    const alternates = reports.filter((r) => r !== best.report);
    return {
      status: "verified",
      handoff: {
        semantic: selected,
        anchor: { ...best.anchor, verification: { ...best.anchor.verification, alternates } },
        views: selected.captures.map((c) => ({ slot: c.slot, snapshot: c.snapshot })),
      },
    };
  }

  const reason: RejectionReason = REASON_PRIORITY.find((r) => reports.some((c) => c.outcome === r)) ?? "no-usable-observation";
  return { status: "rejected", reason, message: MESSAGES[reason], candidates: reports, fallback: "user-click" };
}

/** JSON-safe summary of a handoff: ids, boxes, camera-independent facts; no image data. */
export function summarizeHandoff(handoff: SemanticGeometricHandoff): unknown {
  const { semantic, anchor } = handoff;
  return {
    semantic: {
      objectId: semantic.objectId,
      label: semantic.label,
      description: semantic.description,
      confirmedAtIso: semantic.confirmedAtIso,
      observations: semantic.observations,
      captures: semantic.captures.map((c) => ({
        slot: c.slot,
        captureId: c.id,
        snapshotId: c.snapshot.id,
        capturedAtIso: c.capturedAtIso,
        worldGeneration: c.snapshot.worldGeneration,
        cameraPosition: c.snapshot.camera.position,
      })),
    },
    anchor,
  };
}
