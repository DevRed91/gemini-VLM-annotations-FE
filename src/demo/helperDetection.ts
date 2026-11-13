/**
 * Annotation-helper detection for the demo HUD. READ-ONLY: it never deletes,
 * hides, or changes visibility of anything, and never touches production
 * raycasting.
 *
 * Why it matters (measured 2026-11-13, office_space.sog): every annotation adds
 * an invisible THREE.LineSegments OBB helper as a CHILD of the SplatMesh.
 * `Raycaster.intersectObject(splat)` is recursive and ignores `visible`, so
 * after one annotation exists, rays may return helper hits instead of splat
 * hits. Settled measurements taken in that state are unreliable.
 *
 * Three sources are inspected and de-duplicated by annotation id:
 *   1. LineSegments children of the splat   (the helper geometry itself)
 *   2. live viewer annotations (apartmentId, optional .helper)
 *   3. persisted scene annotation records   (annotationId)
 * A helper that belongs to a live annotation, and a persisted record with the
 * same id, are the SAME annotation and count once.
 */

export const HELPER_WARNING =
  "Annotation helpers detected. Recursive production raycasting may intersect helper geometry and distort settled hit measurements. Start with a clean scene for reliable comparison.";

export interface ObjectLike {
  readonly isLineSegments?: boolean;
  readonly uuid?: string;
}

export interface HelperDetectionInput {
  /** `currentSplat.children`, or null when no splat is loaded. */
  readonly splatChildren: readonly ObjectLike[] | null;
  /** Live viewer annotations. */
  readonly annotations: readonly { readonly apartmentId: string; readonly helper?: ObjectLike }[];
  /** Persisted records for the current scene. */
  readonly storedRecords: readonly { readonly annotationId: string }[];
}

export interface HelperDetection {
  /** Distinct annotations across all three sources. */
  readonly annotationCount: number;
  /** Distinct helper LineSegments attached to the splat. */
  readonly helperCount: number;
  /** Helper children that match no live annotation (still raycast-visible). */
  readonly unattributedHelpers: number;
  readonly liveAnnotations: number;
  readonly storedAnnotations: number;
  /** True when anything above could contaminate raycasts or indicates a non-clean scene. */
  readonly warn: boolean;
  /** Stable string for cheap change detection. */
  readonly signature: string;
}

export function detectAnnotationHelpers(input: HelperDetectionInput): HelperDetection {
  const ids = new Set<string>();
  for (const a of input.annotations) ids.add(a.apartmentId);
  for (const r of input.storedRecords) ids.add(r.annotationId);

  // Helper objects: every LineSegments child of the splat, plus any live
  // annotation helper not (yet) among the children. Keyed by object identity.
  const helpers = new Set<ObjectLike>();
  for (const child of input.splatChildren ?? []) {
    if (child.isLineSegments) helpers.add(child);
  }
  const attributed = new Set<ObjectLike>();
  for (const a of input.annotations) {
    if (a.helper) {
      helpers.add(a.helper);
      attributed.add(a.helper);
    }
  }
  // Orphans are counted as annotations of their own only if no id explains them.
  const unattributedHelpers = [...helpers].filter((h) => !attributed.has(h)).length;
  const annotationCount = ids.size + unattributedHelpers;

  return {
    annotationCount,
    helperCount: helpers.size,
    unattributedHelpers,
    liveAnnotations: input.annotations.length,
    storedAnnotations: input.storedRecords.length,
    warn: annotationCount > 0 || helpers.size > 0,
    signature: `${helpers.size}|${[...ids].sort().join(",")}|${unattributedHelpers}`,
  };
}

export function describeHelpers(d: HelperDetection): string {
  if (!d.warn) return "none";
  return `${d.annotationCount} annotation(s) · ${d.helperCount} helper(s) · ${d.storedAnnotations} stored`;
}
