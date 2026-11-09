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
 * Read-only view of the DBSCAN run inside `registerAndMeasureObject`, for the
 * development-only pipeline diagnostics. `noise` is the complement of cluster
 * membership; `libraryNoise` is the raw `DBSCAN#noise` list, which can still
 * contain border points that a later cluster expansion adopted.
 */
export interface DBSCANClusterReport {
  /** Clusters in DBSCAN output order; each is an array of rawPoints indices. */
  readonly clusters: readonly (readonly number[])[];
  /** Indices of raw points that belong to no cluster. */
  readonly noise: readonly number[];
  /** Raw DBSCAN noise list (may overlap cluster membership). */
  readonly libraryNoise: readonly number[];
}

/** Phase 1 DBSCAN extraction; semantic identity is owned by the registry. */
export default class GeometricContextManager {
  registerAndMeasureObject(
    className: string,
    rawPoints: Vector3[],
    options: {
      eps?: number;
      minPts?: number;
      /** Optional diagnostics sink; never affects clustering or selection. */
      onClusters?: (report: DBSCANClusterReport) => void;
    } = {},
  ): MeasuredObjectCluster | null {
    const eps = options.eps ?? 0.3;
    const minPts = options.minPts ?? 10;
    if (rawPoints.length < minPts) return null;

    const dataset = rawPoints.map((point) => [point.x, point.y, point.z]);
    const dbscan = new DBSCAN();
    const clusters = dbscan.run(dataset, eps, minPts);
    if (options.onClusters) {
      const assigned = new Uint8Array(rawPoints.length);
      for (const cluster of clusters) {
        for (const index of cluster) assigned[index] = 1;
      }
      const noise: number[] = [];
      for (let index = 0; index < rawPoints.length; index++) {
        if (!assigned[index]) noise.push(index);
      }
      options.onClusters({
        clusters,
        noise,
        libraryNoise: [...dbscan.noise],
      });
    }
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
