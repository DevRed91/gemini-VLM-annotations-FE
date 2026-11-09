import * as THREE from "three";
import { DIAGNOSTIC_COLORS, colorCss } from "./clusterPalette.ts";
import type {
  AnnotationRequestDiagnostics,
  DetectionDiagnostics,
  QuatRecord,
  Vec3Record,
} from "./types.ts";

/**
 * Development-only 3D visualization objects for the annotation pipeline
 * (Task 1 instrumentation). Everything renders with depthTest disabled and a
 * high renderOrder so markers stay visible on top of the splat cloud.
 */

function toVec3(record: Vec3Record): THREE.Vector3 {
  return new THREE.Vector3(record.x, record.y, record.z);
}

function toQuat(record: QuatRecord): THREE.Quaternion {
  return new THREE.Quaternion(record.x, record.y, record.z, record.w);
}

/** Canvas-text sprite label; browser-only (uses 2D canvas), dev-only. */
export function makeTextLabel(
  text: string,
  options: { colorHex?: number; worldHeight?: number } = {},
): THREE.Sprite {
  const colorHex = options.colorHex ?? 0xffffff;
  const worldHeight = options.worldHeight ?? 0.085;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable for diagnostic labels");
  const font = "bold 26px ui-monospace, Menlo, monospace";
  const padding = 14;
  context.font = font;
  canvas.width = Math.ceil(context.measureText(text).width) + padding * 2;
  canvas.height = 44;
  context.font = font;
  context.fillStyle = "rgba(8, 10, 14, 0.78)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = colorCss(colorHex);
  context.lineWidth = 2;
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  context.fillStyle = colorCss(colorHex);
  context.fillText(text, padding, 30);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 40;
  sprite.scale.set((worldHeight * canvas.width) / canvas.height, worldHeight, 1);
  return sprite;
}

function attachLabel(
  group: THREE.Group,
  text: string,
  position: THREE.Vector3,
  options: { colorHex?: number; yOffset?: number } = {},
): void {
  const sprite = makeTextLabel(text, { colorHex: options.colorHex });
  sprite.position.copy(position);
  sprite.position.y += options.yOffset ?? 0.07;
  group.add(sprite);
}

export function makePoints(
  positions: readonly THREE.Vector3[],
  colorHex: number,
  size: number,
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      positions.flatMap((p) => [p.x, p.y, p.z]),
      3,
    ),
  );
  const material = new THREE.PointsMaterial({
    color: colorHex,
    size,
    sizeAttenuation: true,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 10;
  return points;
}

export function makeLineSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  colorHex: number,
  opacity = 0.8,
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const material = new THREE.LineBasicMaterial({
    color: colorHex,
    depthTest: false,
    transparent: true,
    opacity,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 8;
  return line;
}

export function makeRayLine(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  length: number,
  colorHex: number,
  opacity = 0.5,
): THREE.Line {
  return makeLineSegment(
    origin,
    origin.clone().addScaledVector(direction, length),
    colorHex,
    opacity,
  );
}

function makeMarkerMesh(
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  colorHex: number,
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color: colorHex,
    depthTest: false,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.renderOrder = 20;
  return mesh;
}

export function makeSphereMarker(
  position: THREE.Vector3,
  colorHex: number,
  radius: number,
): THREE.Mesh {
  return makeMarkerMesh(new THREE.SphereGeometry(radius, 16, 12), position, colorHex);
}

export function makeOctahedronMarker(
  position: THREE.Vector3,
  colorHex: number,
  radius: number,
): THREE.Mesh {
  return makeMarkerMesh(new THREE.OctahedronGeometry(radius), position, colorHex);
}

export function makeBoxWireframe(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion | null,
  size: THREE.Vector3,
  colorHex: number,
): THREE.LineSegments {
  const box = new THREE.BoxGeometry(size.x, size.y, size.z);
  const edges = new THREE.EdgesGeometry(box);
  box.dispose();
  const material = new THREE.LineBasicMaterial({
    color: colorHex,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  const segments = new THREE.LineSegments(edges, material);
  segments.position.copy(position);
  if (quaternion) segments.quaternion.copy(quaternion);
  segments.renderOrder = 9;
  return segments;
}

function aabbCentre(min: Vec3Record, max: Vec3Record): THREE.Vector3 {
  return toVec3(min).add(toVec3(max)).multiplyScalar(0.5);
}

function aabbSize(min: Vec3Record, max: Vec3Record): THREE.Vector3 {
  return toVec3(max).sub(toVec3(min));
}

/** Recursively dispose geometries, materials, and textures of an object tree. */
export function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      for (const item of material) {
        (item as THREE.SpriteMaterial).map?.dispose();
        item.dispose();
      }
    } else if (material) {
      (material as THREE.SpriteMaterial).map?.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

/**
 * Visualization for one detection record. Rebuilt (replaced wholesale) after
 * every pipeline stage, so the group always mirrors the current record and
 * earlier stages stay inspectable when a later one fails.
 */
export function buildDetectionGroup(record: DetectionDiagnostics): THREE.Group {
  const group = new THREE.Group();
  group.name = record.annotationId
    ? `annotation-diagnostics:${record.annotationId}`
    : `annotation-diagnostics:${record.label}`;

  // --- Stage: sample grid hits / misses ---
  const sampling = record.sampling;
  if (sampling) {
    // Cluster membership colours the hit stems once clustering is known.
    const hitColors = new Map<number, number>();
    for (const cluster of record.clustering?.clusters ?? []) {
      for (const index of cluster.pointIndices) hitColors.set(index, cluster.colorHex);
    }
    const noiseSet = new Set(record.clustering?.noiseIndices ?? []);

    const hits: THREE.Vector3[] = [];
    for (const cell of sampling.cells) {
      const origin = cell.rayOrigin ? toVec3(cell.rayOrigin) : null;
      const direction = cell.rayDirection ? toVec3(cell.rayDirection) : null;
      if (!cell.hit) {
        if (origin && direction) {
          group.add(makeRayLine(origin, direction, 12, DIAGNOSTIC_COLORS.missRay, 0.45));
        }
        continue;
      }
      if (!cell.position) continue;
      const position = toVec3(cell.position);
      hits.push(position);
      if (origin && direction) {
        // Short stem along the ray through the hit, showing the ray geometry
        // (e.g. rays that punch through a thin rug keep going downward).
        let color: number = DIAGNOSTIC_COLORS.sampleHit;
        if (cell.hitOrdinal !== null) {
          const clustered = hitColors.get(cell.hitOrdinal);
          if (clustered !== undefined) color = clustered;
          else if (noiseSet.has(cell.hitOrdinal)) color = DIAGNOSTIC_COLORS.noise;
        }
        group.add(
          makeLineSegment(
            position.clone().addScaledVector(direction, -0.03),
            position.clone().addScaledVector(direction, 0.09),
            color,
            0.85,
          ),
        );
      }
    }
    if (hits.length > 0 && !record.clustering) {
      group.add(makePoints(hits, DIAGNOSTIC_COLORS.sampleHit, 0.035));
    }
  }

  // --- Stage: all DBSCAN clusters (distinct colours) + noise ---
  const clustering = record.clustering;
  if (clustering && sampling) {
    const cellsByOrdinal = new Map<number, (typeof sampling.cells)[number]>();
    for (const cell of sampling.cells) {
      if (cell.hitOrdinal !== null) cellsByOrdinal.set(cell.hitOrdinal, cell);
    }
    const positionsFor = (indices: readonly number[]): THREE.Vector3[] =>
      indices
        .map((index) => cellsByOrdinal.get(index)?.position)
        .filter((p): p is Vec3Record => p !== null && p !== undefined)
        .map(toVec3);

    for (const cluster of clustering.clusters) {
      group.add(makePoints(positionsFor(cluster.pointIndices), cluster.colorHex, 0.045));
      const centroid = toVec3(cluster.centroid);
      group.add(makeOctahedronMarker(centroid, cluster.colorHex, cluster.isSelected ? 0.05 : 0.035));
      attachLabel(
        group,
        `C#${cluster.index} · ${cluster.size} pts${cluster.isSelected ? " SELECTED" : ""}`,
        centroid,
        { colorHex: cluster.colorHex },
      );
    }
    if (clustering.noiseIndices.length > 0) {
      const noisePoints = positionsFor(clustering.noiseIndices);
      group.add(makePoints(noisePoints, DIAGNOSTIC_COLORS.noise, 0.03));
      const mean = noisePoints
        .reduce((acc, p) => acc.add(p), new THREE.Vector3())
        .divideScalar(Math.max(1, noisePoints.length));
      attachLabel(group, `noise · ${clustering.noiseIndices.length} pts`, mean, {
        colorHex: DIAGNOSTIC_COLORS.noise,
      });
    }
  }

  // --- Stage: measurement (selected cluster AABB + measured centroid) ---
  const measurement = record.measurement;
  if (measurement) {
    group.add(
      makeBoxWireframe(
        aabbCentre(measurement.bounds.min, measurement.bounds.max),
        null,
        aabbSize(measurement.bounds.min, measurement.bounds.max),
        DIAGNOSTIC_COLORS.selectedBounds,
      ),
    );
    const centroid = toVec3(measurement.centroid);
    group.add(makeSphereMarker(centroid, DIAGNOSTIC_COLORS.measuredCentroid, 0.03));
  }

  // --- Stage: fitted OBB (drives the Gaussian highlight, not the tag) ---
  const obb = record.obb;
  if (obb) {
    const centre = toVec3(obb.position);
    group.add(makeBoxWireframe(centre, toQuat(obb.quaternion), toVec3(obb.size), DIAGNOSTIC_COLORS.obb));
    group.add(makeOctahedronMarker(centre, DIAGNOSTIC_COLORS.obb, 0.025));
    attachLabel(group, `OBB (${obb.method})`, centre, { colorHex: DIAGNOSTIC_COLORS.obb, yOffset: -0.02 });
  }

  // --- Stage: final annotation anchor ---
  const anchor = record.anchor;
  if (anchor) {
    const anchorPosition = toVec3(anchor.position);
    group.add(makeSphereMarker(anchorPosition, DIAGNOSTIC_COLORS.anchor, 0.045));
    const coincidesWithCentroid =
      measurement !== null &&
      anchorPosition.distanceToSquared(toVec3(measurement.centroid)) < 1e-8;
    if (measurement && coincidesWithCentroid) {
      attachLabel(
        group,
        "measured centroid = anchor",
        anchorPosition,
        { colorHex: DIAGNOSTIC_COLORS.anchor },
      );
    } else {
      if (measurement) {
        attachLabel(
          group,
          "measured centroid",
          toVec3(measurement.centroid),
          { colorHex: DIAGNOSTIC_COLORS.measuredCentroid },
        );
      }
      attachLabel(
        group,
        `anchor (${anchor.source})`,
        anchorPosition,
        { colorHex: DIAGNOSTIC_COLORS.anchor },
      );
    }
  } else if (measurement) {
    attachLabel(
      group,
      "measured centroid",
      toVec3(measurement.centroid),
      { colorHex: DIAGNOSTIC_COLORS.measuredCentroid },
    );
  }

  return group;
}

/**
 * Visualization for the request-level click stage (shared by all detections
 * of one request). Returns null when there is no click data (inject seam).
 */
export function buildRequestGroup(request: AnnotationRequestDiagnostics): THREE.Group | null {
  const click = request.click;
  if (!click) return null;
  const group = new THREE.Group();
  group.name = `annotation-diagnostics:click:#${request.index}`;
  const origin = click.rayOrigin ? toVec3(click.rayOrigin) : null;
  const direction = click.rayDirection ? toVec3(click.rayDirection) : null;
  if (click.hit) {
    const hitPosition = toVec3(click.hit.position);
    if (origin && direction) {
      group.add(makeLineSegment(origin, hitPosition, DIAGNOSTIC_COLORS.clickHit, 0.5));
    }
    group.add(makeSphereMarker(hitPosition, DIAGNOSTIC_COLORS.clickHit, 0.03));
    attachLabel(group, `click hit (${click.hit.distance.toFixed(2)} m)`, hitPosition, {
      colorHex: DIAGNOSTIC_COLORS.clickHit,
    });
  } else if (origin && direction) {
    group.add(makeRayLine(origin, direction, 20, DIAGNOSTIC_COLORS.missRay, 0.6));
    const markerPosition = origin.clone().addScaledVector(direction, 4);
    attachLabel(group, "click missed the splat", markerPosition, {
      colorHex: DIAGNOSTIC_COLORS.missRay,
    });
  }
  if (group.children.length === 0) return null;
  return group;
}
