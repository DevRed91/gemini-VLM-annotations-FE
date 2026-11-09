import * as THREE from "three";

/**
 * Development-only diagnostic colours (Task 1 instrumentation).
 *
 * The semantic markers are deliberately distinct from every cluster colour so
 * the four key points stay identifiable on screen:
 *   - click hit (yellow) — the user's click raycast intersection
 *   - OBB centre (cyan) — PCA-fitted OBB, drives the Gaussian highlight
 *   - measured centroid (magenta) — AABB centre of the selected cluster,
 *     drives the annotation tag anchor
 *   - final anchor (red) — where the annotation element was actually placed
 */
export const DIAGNOSTIC_COLORS = {
  /** Yellow — click raycast hit marker and click ray. */
  clickHit: 0xffd400,
  /** Pale blue — sample-grid hits before clustering has run. */
  sampleHit: 0x9fd8ff,
  /** Red — sample-grid rays with no splat intersection. */
  missRay: 0xff3355,
  /** Grey — DBSCAN noise points. */
  noise: 0x9aa0a6,
  /** Orange — measured AABB of the selected cluster. */
  selectedBounds: 0xffa500,
  /** Magenta — measured centroid (production anchor candidate). */
  measuredCentroid: 0xff44ff,
  /** Cyan — fitted OBB wireframe and OBB centre. */
  obb: 0x33e0ff,
  /** Bright red — final annotation anchor. */
  anchor: 0xff2200,
} as const;

/** Overlay (2D canvas) colours, kept in sync with DIAGNOSTIC_COLORS. */
export const DIAGNOSTIC_CSS_COLORS = {
  clickHit: "#ffd400",
  rawBox: "#ff44ff",
  sanitizedBox: "#33e0ff",
  sampleHitFill: "rgba(96, 255, 140, 0.22)",
  sampleMissFill: "rgba(255, 64, 96, 0.40)",
  gridOutline: "rgba(255, 255, 255, 0.15)",
  selectedCentroid: "#ff44ff",
  noise: "#9aa0a6",
  anchor: "#ff2200",
  obb: "#33e0ff",
  selectedBounds: "#ffa500",
  panelBackground: "rgba(10, 12, 16, 0.82)",
  panelText: "#e8eaf0",
  panelDim: "#9aa0a6",
} as const;

/**
 * Deterministic, pairwise-distinct cluster colours.
 * Golden-angle hue stepping keeps adjacent clusters distinguishable no matter
 * how many clusters DBSCAN emits.
 */
export function clusterColor(index: number): number {
  const hue = (index * 0.618033988749895) % 1;
  return new THREE.Color().setHSL(hue, 0.85, 0.55).getHex();
}

/** The first `count` cluster colours, for legend/validation use. */
export function clusterColors(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => clusterColor(index));
}

/** CSS hex string for a numeric 0xRRGGBB colour (overlay swatches). */
export function colorCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}
