import { Box3, Vector3 } from "three";
import { DBSCAN } from "density-clustering";

export interface MeasuredObjectCluster {
  readonly label: string;
  readonly dimensions: { width: number; height: number; depth: number };
  readonly centroid: Vector3;
  readonly points: Vector3[];
  readonly box: Box3;
}

/**
 * DBSCAN radius scaled to the sample spacing: 3x the median nearest-neighbour
 * distance, clamped to [minEps, maxEps]. A fixed large radius merges the target
 * with legs, floor and background.
 */
export function adaptiveEps(
  points: readonly Vector3[],
  minEps = 0.05,
  maxEps = 0.3,
): number {
  if (points.length < 2) return maxEps;
  const nn = points.map((p, i) => {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j !== i) best = Math.min(best, p.distanceToSquared(points[j]));
    }
    return Math.sqrt(best);
  }).sort((a, b) => a - b);
  const median = nn[Math.floor(nn.length / 2)];
  return Math.min(maxEps, Math.max(minEps, 3 * median));
}

/**
 * Drop ray hits whose distance from `origin` is far from the median, e.g. hits
 * on background seen through gaps in the target. Tolerance is
 * max(k * 1.4826 * MAD, minTolerance) so deep-but-continuous objects survive.
 */
export function filterDepthOutliers(
  points: readonly Vector3[],
  origin: Vector3,
  k = 3,
  minTolerance = 0.25,
): Vector3[] {
  if (points.length < 5) return points.slice();
  const depths = points.map((p) => p.distanceTo(origin));
  const sorted = depths.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const dev = depths.map((d) => Math.abs(d - median)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  const tolerance = Math.max(k * 1.4826 * mad, minTolerance);
  return points.filter((_, i) => Math.abs(depths[i] - median) <= tolerance);
}

/** Phase 1 DBSCAN extraction; semantic identity is owned by the registry. */
export default class GeometricContextManager {
  registerAndMeasureObject(
    className: string,
    rawPoints: Vector3[],
    options: { eps?: number; minPts?: number } = {},
  ): MeasuredObjectCluster | null {
    const eps = options.eps ?? adaptiveEps(rawPoints);
    const minPts = options.minPts ?? 10;
    if (rawPoints.length < minPts) return null;

    const dataset = rawPoints.map((point) => [point.x, point.y, point.z]);
    const clusters = new DBSCAN().run(dataset, eps, minPts);
    if (clusters.length === 0) return null;

    const mainCluster = clusters.reduce((previous, current) =>
      current.length > previous.length ? current : previous,
    );
    const points = mainCluster.map((index) => rawPoints[index].clone());
    const box = new Box3().setFromPoints(points);
    const size = box.getSize(new Vector3());
    return {
      label: className,
      dimensions: { width: size.x, height: size.y, depth: size.z },
      centroid: box.getCenter(new Vector3()),
      points,
      box,
    };
  }
}
