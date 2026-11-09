# VLSplat Gaussian-Level Technical Feasibility

Investigation only; no code or dependencies changed.

**Labels:** **[Paper]** = VLSplat (arXiv 2611.01939v1). **[Verified]** = read in installed `@sparkjsdev/spark` 2.0.0 (`dist/` only; no `src/` ships, so references are to `dist/types/*.d.ts` and `dist/spark.module.js` line numbers). **[Proposed]** = my adaptation. **No experiments were run and no results are claimed.**

**Evidence limits:** The paper was read through its arXiv HTML via a summarising fetch tool. It returned Section 3.2 as a paraphrase plus short fragments, and 4,604 trailing characters (appendices) were not read. The exact form of Eq. 1 below, in particular whether extents use a square root, is therefore **my reconstruction from the paraphrase and must be checked against the PDF** before implementation.

---

## 1. Gaussian covariance (Section 3.2)

**[Paper]** Within a codebook group's high-confidence support S_k (members whose feature aligns with the prototype above τ_cb), Gaussians i and j are connected when the distance between their centres is within α times the sum of their covariance extents projected on the centre-to-centre direction. Connected components become candidate supports. Isolated components are dropped and a 3D box is fitted to the rest.

Reconstructed Eq. 1:

```
d̂ᵢⱼ = (μⱼ − μᵢ) / ‖μⱼ − μᵢ‖
edge(i,j)  ⇔  ‖μⱼ − μᵢ‖ ≤ α · ( √(d̂ᵀ Σᵢ d̂) + √(d̂ᵀ Σⱼ d̂) )
```

- **μᵢ**: 3D Gaussian centre.
- **Σᵢ**: 3×3 covariance, symmetric positive semi-definite.
- **Directional projection**: √(d̂ᵀΣd̂) is the standard deviation of Gaussian i along d̂, i.e. its 1σ half-extent in that direction. It is not the isotropic radius. A flat disc-like Gaussian has a small extent along its normal and a large one in-plane.
- **Anisotropic support overlap**: the right side is the sum of the two 1σ extents along the line joining the centres, scaled by α. The edge exists when those anisotropic supports touch or overlap along that line. Two long thin Gaussians lying end to end connect at large separation. Two side by side need a smaller one.
- **α**: overlap tolerance. α = 1 means 1σ extents just touch; α = 3 means 3σ extents touch. The paper's value is in appendices I did not read. A Euclidean threshold is the special case Σ = s²I, which gives ‖Δμ‖ ≤ 2αs.

**Covariance from scale and rotation** (standard 3DGS; **[Proposed]** use here):

```
R = rotationMatrix(q)       // q normalised, (x,y,z,w) in THREE
S = diag(sx, sy, sz)        // linear scales (std-dev), not log
Σ = R S² Rᵀ                 // object space
Σ_world = M Σ Mᵀ            // M = upper-left 3×3 of splat.matrixWorld
```

Then dᵀΣd = ‖S Rᵀ d‖², so **no 3×3 matrix is needed per Gaussian**: rotate d into the Gaussian frame, scale componentwise, take the norm. Under non-uniform transforms `Σ_world` needs M. The repo's mesh uses a flip quaternion and y offset (see prior doc), so use `matrixWorld`.

Caveat: I did not verify the .sog scale convention; check on real data.

---

## 2. SparkJS 2.0.0 feasibility

| Attribute | CPU access | Verified source | Notes |
|---|---|---|---|
| Centre | Yes | `getSplat`/`forEachSplat` (`PackedSplats.d.ts`, `ExtSplats.d.ts`); `unpackSplat` at `spark.module.js:1771`, `decodeExtSplat` at `:1622` | Packed: float16 centres (my reading of the layout; not re-verified). Ext: full precision. |
| Scales | Yes (std-dev, linear) | same | Packed encodes log scale in 8 bits over `LN_SCALE_MIN=-12` to `LN_SCALE_MAX=9` (`defines.d.ts`, `:584-585`). Quantised. |
| Rotation | Yes (`THREE.Quaternion`) | same | Packed uses octahedral quaternion encoding (`decodeQuatOctXy88R8` in shader string, line 8010). |
| Opacity, colour | Yes | same | `opacity` number and `THREE.Color`. Stored as bytes in packed mode. |
| Covariance Σ | **Not stored as such** by default; derive on CPU | n/a | `covSplats: true` (`SplatMesh.d.ts:40`) selects an alternate covariance path in the shader (`:9410+`, `readCovArrays` `:2984`, `packSplatCovEncoding` `:3526`). Whether it exposes a CPU-readable Σ for a loaded .sog was **not verified**. Do not rely on it. |
| Stable ID | **Storage index only** | `forEachSplat` index; `Gsplat.index` in object modifiers (`gaussianMaskManager.ts:181`) | Valid for non-LOD, non-paged meshes. Repo `assertNonLodSplat` guards this. Phase 2 validated index parity empirically; it is not a source guarantee. |
| Raycast → splat index | **No** | `SplatMesh.raycast` at `spark.module.js:12716` | Fills `intersects` from `raycast_packed_buffer` distances. I did not find an index in the returned structure. |
| GPU data | Texture-resident | `PackedSplats.getTexture()`, `.target` (`WebGLArrayRenderTarget`), `.source` (`DataArrayTexture`); `ExtSplats` has two texture arrays (`DynoExtSplats`) | Accessible only inside Dyno/GLSL (`fetchSplat`). Not readable without a readback pass (`Readback.d.ts`). |
| Subset extraction | Partial | `ExtSplats.extractSplats(indices, pageColoring)` (`ExtSplats.d.ts:65`, impl `:7413`); also called on `lodSplats` at `:11086`/`:11093` | I did not confirm a public equivalent on non-LOD `PackedSplats`. Alternative: build a new `PackedSplats` with `pushSplat`. |

**CPU vs GPU:** everything the connectivity experiment needs (μ, s, q, opacity) is CPU-readable through `forEachSplat`, which reuses callback objects (copy immediately). `.sog` loads into packed storage by default (**not** confirmed by reading the loader; check `splat.packedSplats` vs `splat.extSplats` at runtime). Covariance is derived, not read.

**Not available:** per-Gaussian semantic feature vectors, codebook assignments, or any attribute beyond the above. Spark has no slot for a 16-to-64-D feature per Gaussian. A .sog from standard 3DGS training contains none.

---

## 3. Covariance-aware connectivity experiment

**[Proposed]** Compare three groupers on the *same* candidate Gaussians so differences are attributable to the edge rule.

**Candidate set:** Gaussians inside a Gemini-box OBB from the existing `liftCluster` (Phase 2), opacity ≥ threshold. Nᶜ is typically 10³–10⁶.

1. **Euclidean**: edge if ‖Δμ‖ ≤ ε.
2. **DBSCAN on centres** (existing, ε, minPts) on Gaussian centres rather than the ≤625 raycast samples. This differs from production DBSCAN's input, so also report the production result for reference.
3. **Anisotropic (Eq. 1)**.

```
function anisotropicComponents(centres, scales, quats, alpha, cellSize):
    # preprocessing: rotation of d into each Gaussian frame uses conj(q)
    rmax[i] = alpha * max(scales[i]) * 2          # conservative query radius bound
    grid = spatialHash(centres, cellSize = max over i of rmax[i], capped)
    uf   = UnionFind(N)
    for i in 0..N-1:
        for j in grid.neighbours(i, radius = rmax[i] + rmaxMaxNeighbour):  # j > i only
            Δ = centres[j] - centres[i]; L = |Δ|
            if L == 0: uf.union(i, j); continue
            d = Δ / L
            ei = norm(scales[i] ⊙ rotateInv(quats[i], d))   # sqrt(dᵀΣᵢd)
            ej = norm(scales[j] ⊙ rotateInv(quats[j], d))
            if L <= alpha * (ei + ej): uf.union(i, j)
    comps = uf.groups()
    drop comps with size < minSize
    return largest comp (and optionally those overlapping Gemini box)
```

`rmax` is a conservative bound (ei ≤ max scale), so no valid edge is skipped. Large floaters inflate the cell size; cap them and report how many.

**Complexity:** build O(N); queries O(N·k) with k mean neighbours in range; union-find near-linear. The pairwise test costs about 30 flops. Worst case, large floaters make k ~ N, so O(N²).

**Data structures:** `Float32Array` centres (3N), scales (3N), quaternions (4N), plus `Int32Array` hash cells and union-find parents. About 44 MB at N = 10⁶.

**Compute placement:** CPU is sufficient for the first experiment; no GPU compute needed. WebGPU only pays off at N ≳ 10⁷ or for interactive updates. The repo's WebGPU scaffold is branch-only with no passes.

**Metrics (to be measured, none exist yet):**
- Component count, largest-component size.
- Agreement with a human-labelled index set for a few objects (needs manual labels; chairs and sofa are good because thin legs stress the anisotropic rule).
- Leakage into adjacent objects (touching table/chair).
- Sensitivity sweeps over ε and α.
- Wall time, and sensitivity to .sog scale quantisation.

---

## 4. VLSplat refinement

| Component | Paper | Reproducible here? |
|---|---|---|
| Reliable core vs uncertain candidates (Eq. 2) | Split by feature alignment with prototype ≥ τ_f | **Needs per-Gaussian features, which we lack.** Substitute **[Proposed]**: core = Gaussians inside the OBB/anisotropic component with high opacity; candidates = low-opacity or boundary-adjacent Gaussians. This is not the paper's criterion. |
| Intra-node refinement | Suppress noisy members | Possible as a heuristic on geometry only. |
| Inter-node acquisition (Eq. 3) | Recover parts (e.g. chair legs) from background groups inside the expanded ROI | **[Proposed]** approximate with the expanded-OBB candidate pool and the anisotropic connectivity from §3. No group labels exist to exclude foreground nodes. |
| Synthetic object-view rendering (Eq. 4) | Orbit cameras, render core vs core+gated candidates | Partly. Spark can render a masked subset using the repo's per-index modifier (`GaussianMaskManager`) and `WebGLRenderer.readRenderTargetPixels`. Opacity scaling by gate needs a modifier with a per-index float lookup (R8UI mask → float texture). Feasible but not built or tested here. |
| CLIP similarity | Compare renders to the node text prompt | CLIP is not in the stack. It would be a browser model (ONNX/transformers.js, not installed) or a server call. Neither exists. |
| Gate optimisation (Eq. 5) | Learnable gates by gradient descent on CLIP gain | Needs differentiable rendering or at least a gradient path. Gradient-free substitute **[Proposed]**: greedy leave-one-group-out scoring over candidate *clusters* (not individual Gaussians). Cost is clusters × views × CLIP forward passes. |
| Feature-direction update (Eq. 6) | Rotate feature toward/away from prototype, norm kept | **Not reproducible**: no feature storage. Needs training infrastructure and a changed asset format. |

**Summary:** what we can do without training is a *geometric* refinement plus CLIP-verified accept/reject of whole candidate clusters. That is VLSplat-inspired, not VLSplat. Faithful reproduction needs: (a) a feature-field lifting pipeline (Sec. 3.1), (b) feature storage per Gaussian, (c) differentiable rendering for gates.

---

## 5. Product feasibility

All figures below are **estimates from reasoning, not measurements.**

| | Offline preprocessing | Background GPU | Real-time interactive |
|---|---|---|---|
| Latency | Minutes per scene, no user wait | Seconds to tens of seconds per object | Needs ≲100 ms; unlikely for CLIP loops |
| Memory | Server-side, unconstrained | Browser: splat + CLIP weights + render targets. Mobile risk. | Same plus per-frame buffers |
| Complexity | Lowest. Python/Node script, outputs index sets or sidecar JSON. | High. Workers, model loading, GPU contention with the viewer | Highest |
| Expected accuracy | Highest: can train features and use full CLIP | Medium: geometry-only plus CLIP verification | Low: only §3 connectivity fits the budget |
| Fit with repo | Matches the Phase 3 and 4 offline validation scripts | New infrastructure | §3 only |

**Recommendation:** connectivity (§3) can run interactively in a Worker for a single object. CLIP refinement belongs offline or as a background job. Feature training must be offline.

---

## 6. Technical risks

1. **Eq. 1 reconstruction** unverified against PDF (see top).
2. **Quantised scales/centres** in packed mode: small Gaussians may collapse extents, and float16 centres limit precision on large scenes.
3. **Floaters and large background Gaussians** make neighbour search degenerate and bridge objects.
4. **Index stability** only for non-LOD, non-paged meshes. Production assets with LOD (e.g. `Apartment-lod.rad`) break CPU index parity.
5. **Eq. 1 ignores opacity** as I read it, so near-transparent Gaussians can bridge objects; filter first.
6. **Paper's results rely on learned features** that we do not have, so connectivity alone may not reproduce its gains.
7. **CLIP on synthetic renders** may be sensitive to view selection. Not validated.

---

## 7. Recommended first experiment

**CPU-only, Worker-free, no new dependencies, one scene.**

1. Reuse `liftCluster` to obtain candidate indices for 3 to 5 already-annotated objects (include one thin-structured object such as a chair).
2. In a `scripts/*.mjs`-style harness (like `phase3-validate.mjs`), implement the three groupers from §3 on the same candidate set.
3. Sweep ε for Euclidean/DBSCAN and α ∈ {1, 2, 3} for anisotropic.
4. Hand-label ground-truth index sets for the chosen objects (via the existing mask highlighter), then report precision/recall, component count, and wall time per method.
5. **Go/no-go:** proceed to CLIP-verified refinement only if anisotropic connectivity beats both baselines on thin objects without increasing leakage. Otherwise stop, since refinement built on weaker connectivity would not recover that loss.

Before step 2, confirm at runtime the storage type (`packedSplats` vs `extSplats`) and that decoded scales match expected object sizes.
