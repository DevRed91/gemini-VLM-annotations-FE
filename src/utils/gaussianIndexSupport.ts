import type { SplatMesh } from "@sparkjsdev/spark";

/**
 * Storage-index lifting and masking are only defined for plain, non-LOD,
 * non-paged SplatMesh inputs. Spark decides LOD rendering from the presence of
 * `lodSplats` on the packed/ext source (plus `enableLod !== false`), so the
 * presence of `lodSplats` is the authoritative signal. `enableLod`, `paged`
 * and the `lod` build flag are checked as well. A mesh that carries `lodSplats`
 * but has `enableLod === false` still renders non-LOD, but is rejected
 * conservatively: its storage then contains a second, LOD-ordered splat set.
 */
export function nonLodSplatRejectionReason(splat: SplatMesh): string | null {
  const packed = splat.packedSplats as { lod?: unknown; lodSplats?: unknown } | undefined;
  const ext = splat.extSplats as { lod?: unknown; lodSplats?: unknown } | undefined;
  return splat.paged ? "paged" :
    splat.enableLod === true ? "enableLod" :
    packed?.lodSplats || ext?.lodSplats ? "lodSplats" :
    packed?.lod || ext?.lod ? "lod" :
    null;
}

export function isNonLodSplat(splat: SplatMesh): boolean {
  return nonLodSplatRejectionReason(splat) === null;
}

export function assertNonLodSplat(splat: SplatMesh, subject: string): void {
  const reason = nonLodSplatRejectionReason(splat);
  if (reason) {
    throw new Error(
      `${subject} support only non-LOD, non-paged SplatMesh inputs (found ${reason})`,
    );
  }
}
