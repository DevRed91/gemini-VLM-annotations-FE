/**
 * Is `SplatMesh.raycast` able to return real hits yet? Spark's raycast
 * silently returns NO intersections (not an error) when its inputs are not
 * ready, so casting early would record nine false "misses".
 *
 * Signals checked, all read from Spark 2.0 (node_modules/@sparkjsdev/spark/
 * dist/spark.module.js, SplatMesh.raycast ~line 12716):
 *   - viewer.splatLoaded        world finished loading (set after `initialized`)
 *   - SplatMesh.isStaticInitialized   wasm raycast kernels loaded (static)
 *   - splat.isInitialized       asyncInitialize finished
 *   - splat.raycastable         not disabled
 *   - packedSplats | extSplats | paged   a data source exists
 *   - splat.context.numSplats.value > 0  generator updated; raycast loops over
 *                                        exactly this count
 * No timeout is involved: this is the condition raycast itself tests.
 */

export interface SplatReadinessInput {
  readonly raycastable?: boolean;
  readonly isInitialized?: boolean;
  readonly packedSplats?: unknown;
  readonly extSplats?: unknown;
  readonly paged?: unknown;
  readonly context?: { readonly numSplats?: { readonly value?: number } };
}

export interface ReadinessReport {
  readonly ready: boolean;
  /** Human-readable name of the first unmet condition; null when ready. */
  readonly waitingFor: string | null;
}

export function splatRaycastReadiness(
  splat: SplatReadinessInput | null,
  splatLoaded: boolean,
  staticInitialized: boolean,
): ReadinessReport {
  const wait = (waitingFor: string): ReadinessReport => ({ ready: false, waitingFor });
  if (!splat) return wait("no splat object");
  if (!splatLoaded) return wait("world load");
  if (!staticInitialized) return wait("Spark wasm init");
  if (splat.isInitialized === false) return wait("splat initialization");
  if (splat.raycastable === false) return wait("raycastable flag");
  if (!splat.packedSplats && !splat.extSplats && !splat.paged) return wait("splat data");
  const count = splat.context?.numSplats?.value ?? 0;
  if (!(count > 0)) return wait("splat generator (numSplats = 0)");
  return { ready: true, waitingFor: null };
}
