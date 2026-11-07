import { Box3, Vector3 } from "three";
import { DBSCAN } from "density-clustering";

export interface MeasuredObjectCluster {
  readonly label: string;
  readonly dimensions: { width: number; height: number; depth: number };
  readonly centroid: Vector3;
  readonly points: Vector3[];
  readonly box: Box3;
}

/** Phase 1 DBSCAN extraction; semantic identity is owned by the registry. */
export default class GeometricContextManager {
  registerAndMeasureObject(
    className: string,
    rawPoints: Vector3[],
    options: { eps?: number; minPts?: number } = {},
  ): MeasuredObjectCluster | null {
    const eps = options.eps ?? 0.3;
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
