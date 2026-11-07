import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";
import type { GsplatModifier } from "@sparkjsdev/spark";
import { assertNonLodSplat } from "./gaussianIndexSupport";

const MASK_WIDTH = 4096;
const PALETTE_SIZE = 256;

export type GaussianMaskColor = readonly [number, number, number];

export interface GaussianMaskUpdate {
  changed: boolean;
  validIds: number;
  duplicateIds: number;
  invalidIds: number;
  changedBytes: number;
  /** CPU validation, deduplication and changed-byte writes. */
  rewriteMs: number;
  /** CPU submission work only: needsUpdate plus Spark version invalidation. */
  submissionMs: number;
}

export interface GaussianMaskLabelSnapshot {
  label: number;
  color: [number, number, number];
  selectedIds: Uint32Array;
  updateOrder: number;
}

export interface GaussianMaskSnapshot {
  selectedCount: number;
  submissions: number;
  textureBytes: number;
  labels: GaussianMaskLabelSnapshot[];
}

interface LabelMembership {
  indices: Uint32Array;
  lookup: ReadonlySet<number>;
  updateOrder: number;
}

interface ValidatedIds {
  indices: Uint32Array;
  lookup: ReadonlySet<number>;
  duplicateIds: number;
  invalidIds: number;
}

export interface GaussianMaskOptions {
  /** Blend between the source splat color and its label color. Default 0.9. */
  strength?: number;
}

function validateLabel(label: number): void {
  if (!Number.isInteger(label) || label < 1 || label >= PALETTE_SIZE) {
    throw new RangeError("label must be an integer in [1, 255]");
  }
}

/** Deterministic label color; label one remains magenta for Phase 2 compatibility. */
export function defaultGaussianMaskColor(label: number): GaussianMaskColor {
  validateLabel(label);
  if (label === 1) return [1, 0, 1];
  const hue = (label * 0.618033988749895) % 1;
  const saturation = 0.78;
  const value = 1;
  const sector = Math.floor(hue * 6);
  const f = hue * 6 - sector;
  const p = value * (1 - saturation);
  const q = value * (1 - f * saturation);
  const t = value * (1 - (1 - f) * saturation);
  switch (sector % 6) {
    case 0: return [value, t, p];
    case 1: return [q, value, p];
    case 2: return [p, value, t];
    case 3: return [p, q, value];
    case 4: return [t, p, value];
    default: return [value, p, q];
  }
}

function colorBytes(color: GaussianMaskColor): [number, number, number] {
  if (!color || color.length !== 3 || !color.every((component) => Number.isFinite(component))) {
    throw new TypeError("color must contain three finite RGB components");
  }
  return color.map((component) =>
    Math.round(Math.min(1, Math.max(0, component)) * 255)
  ) as [number, number, number];
}

/**
 * One label-aware, per-storage-index highlight modifier for a non-LOD SplatMesh.
 * Label zero is unselected; labels 1..255 index a 256-entry RGB palette.
 * The most recently added/updated label owns overlapping texels.
 */
export class GaussianMaskManager {
  readonly texture: THREE.DataTexture;
  readonly paletteTexture: THREE.DataTexture;
  readonly numSplats: number;

  private readonly splat: SplatMesh;
  private readonly modifier: GsplatModifier;
  private readonly strength: ReturnType<typeof dyno.dynoFloat>;
  private readonly data: Uint8Array;
  private readonly paletteData: Uint8Array;
  private readonly memberships = new Map<number, LabelMembership>();
  private disposed = false;
  private submissions = 0;
  private paletteSubmissions = 0;
  private updateSequence = 0;
  private selectedCount = 0;

  static async create(
    splat: SplatMesh,
    options: GaussianMaskOptions = {},
  ): Promise<GaussianMaskManager> {
    await splat.initialized;
    assertNonLodSplat(splat, "Gaussian masks");
    if (!Number.isSafeInteger(splat.numSplats) || splat.numSplats < 0) {
      throw new RangeError("splat.numSplats must be a non-negative safe integer");
    }
    return new GaussianMaskManager(splat, options);
  }

  private constructor(splat: SplatMesh, options: GaussianMaskOptions) {
    this.splat = splat;
    this.numSplats = splat.numSplats;
    const strength = options.strength ?? 0.9;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError("strength must be a finite number in [0, 1]");
    }

    const rows = Math.max(1, Math.ceil(this.numSplats / MASK_WIDTH));
    this.data = new Uint8Array(MASK_WIDTH * rows);
    this.texture = new THREE.DataTexture(
      this.data,
      MASK_WIDTH,
      rows,
      THREE.RedIntegerFormat,
      THREE.UnsignedByteType,
    );
    this.texture.internalFormat = "R8UI";
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this.paletteData = new Uint8Array(PALETTE_SIZE * 4);
    for (let label = 1; label < PALETTE_SIZE; label++) {
      this.paletteData.set([...colorBytes(defaultGaussianMaskColor(label)), 255], label * 4);
    }
    this.paletteTexture = new THREE.DataTexture(
      this.paletteData,
      PALETTE_SIZE,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.paletteTexture.minFilter = THREE.NearestFilter;
    this.paletteTexture.magFilter = THREE.NearestFilter;
    this.paletteTexture.generateMipmaps = false;
    this.paletteTexture.needsUpdate = true;

    const mask = dyno.dynoUsampler2D(this.texture);
    const palette = dyno.dynoSampler2D(this.paletteTexture);
    const numSplats = dyno.dynoInt(this.numSplats);
    this.strength = dyno.dynoFloat(strength);
    const tint = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        mask: "usampler2D",
        palette: "sampler2D",
        numSplats: "int",
        strength: "float",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        int gmIndex = ${inputs.gsplat}.index;
        if (gmIndex >= 0 && gmIndex < ${inputs.numSplats}) {
          uint gmLabel = texelFetch(
            ${inputs.mask}, ivec2(gmIndex & 4095, gmIndex >> 12), 0).r;
          if (gmLabel > 0u) {
            vec3 gmColor = texelFetch(
              ${inputs.palette}, ivec2(int(gmLabel), 0), 0).rgb;
            ${outputs.gsplat}.rgba.rgb = mix(
              ${inputs.gsplat}.rgba.rgb, gmColor, ${inputs.strength});
          }
        }
      `),
    });
    this.modifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({
        gsplat: tint.apply({
          gsplat,
          mask,
          palette,
          numSplats,
          strength: this.strength,
        }).gsplat,
      }),
    );

    splat.objectModifiers = [...(splat.objectModifiers ?? []), this.modifier];
    splat.updateGenerator();
  }

  /** Number of storage indices currently displaying any label. */
  get count(): number {
    return this.selectedCount;
  }

  /** Ascending storage indices currently displaying any label. */
  get selectedIds(): Uint32Array {
    const selected: number[] = [];
    for (let id = 0; id < this.numSplats; id++) {
      if (this.data[id] !== 0) selected.push(id);
    }
    return Uint32Array.from(selected);
  }

  get uploadSubmissions(): number {
    return this.submissions;
  }

  get paletteUploadSubmissions(): number {
    return this.paletteSubmissions;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  getSelectedIds(label: number): Uint32Array {
    validateLabel(label);
    return this.memberships.get(label)?.indices.slice() ?? new Uint32Array(0);
  }

  getLabelAt(id: number): number {
    if (!Number.isSafeInteger(id) || id < 0 || id >= this.numSplats) {
      throw new RangeError("storage index is out of range");
    }
    return this.data[id];
  }

  getLabelColor(label: number): [number, number, number] {
    validateLabel(label);
    return [
      this.paletteData[label * 4] / 255,
      this.paletteData[label * 4 + 1] / 255,
      this.paletteData[label * 4 + 2] / 255,
    ];
  }

  setLabelColor(label: number, color: GaussianMaskColor): void {
    this.assertActive();
    validateLabel(label);
    const bytes = colorBytes(color);
    const offset = label * 4;
    if (bytes.every((component, index) => this.paletteData[offset + index] === component)) {
      return;
    }
    this.paletteData.set(bytes, offset);
    this.paletteTexture.needsUpdate = true;
    this.paletteSubmissions++;
    this.splat.updateVersion();
  }

  setStrength(strength: number): void {
    this.assertActive();
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new RangeError("strength must be a finite number in [0, 1]");
    }
    if (this.strength.value === strength) return;
    this.strength.value = strength;
    this.splat.updateVersion();
  }

  /** Add or replace one object's membership. This label wins all new overlaps. */
  replaceLabel(label: number, ids: ArrayLike<number>): GaussianMaskUpdate {
    this.assertActive();
    validateLabel(label);
    const rewriteStart = performance.now();
    const next = this.validateIds(ids);
    const previous = this.memberships.get(label);
    const affected = new Set<number>(previous?.indices);
    for (const id of next.indices) affected.add(id);

    if (next.indices.length > 0) {
      this.memberships.set(label, {
        indices: next.indices,
        lookup: next.lookup,
        updateOrder: ++this.updateSequence,
      });
    } else {
      this.memberships.delete(label);
    }
    const changedBytes = this.recomputeAffected(affected);
    return this.finishUpdate(rewriteStart, changedBytes, {
      validIds: next.indices.length,
      duplicateIds: next.duplicateIds,
      invalidIds: next.invalidIds,
    });
  }

  /** Remove one object and restore the most recently updated underlying labels. */
  clearLabel(label: number): GaussianMaskUpdate {
    this.assertActive();
    validateLabel(label);
    const rewriteStart = performance.now();
    const previous = this.memberships.get(label);
    if (!previous) return this.finishUpdate(rewriteStart, 0, {});
    this.memberships.delete(label);
    const changedBytes = this.recomputeAffected(new Set(previous.indices));
    return this.finishUpdate(rewriteStart, changedBytes, {});
  }

  /**
   * Legacy whole-mask replacement: remove every label and assign ids to label one.
   * This preserves the Phase 2 binary-mask API and magenta color.
   */
  replace(ids: ArrayLike<number>): GaussianMaskUpdate {
    this.assertActive();
    const rewriteStart = performance.now();
    const next = this.validateIds(ids);
    const affected = new Set<number>(next.indices);
    for (const membership of this.memberships.values()) {
      for (const id of membership.indices) affected.add(id);
    }
    this.memberships.clear();
    if (next.indices.length > 0) {
      this.memberships.set(1, {
        indices: next.indices,
        lookup: next.lookup,
        updateOrder: ++this.updateSequence,
      });
    }
    const changedBytes = this.recomputeAffected(affected);
    return this.finishUpdate(rewriteStart, changedBytes, {
      validIds: next.indices.length,
      duplicateIds: next.duplicateIds,
      invalidIds: next.invalidIds,
    });
  }

  clear(): GaussianMaskUpdate {
    this.assertActive();
    const rewriteStart = performance.now();
    const affected = new Set<number>();
    for (const membership of this.memberships.values()) {
      for (const id of membership.indices) affected.add(id);
    }
    this.memberships.clear();
    const changedBytes = this.recomputeAffected(affected);
    return this.finishUpdate(rewriteStart, changedBytes, {});
  }

  snapshot(): GaussianMaskSnapshot {
    return {
      selectedCount: this.selectedCount,
      submissions: this.submissions,
      textureBytes: this.data.byteLength + this.paletteData.byteLength,
      labels: [...this.memberships.values()].length === 0
        ? []
        : [...this.memberships.entries()]
          .sort(([a], [b]) => a - b)
          .map(([label, membership]) => ({
            label,
            color: this.getLabelColor(label),
            selectedIds: membership.indices.slice(),
            updateOrder: membership.updateOrder,
          })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const existing = this.splat.objectModifiers ?? [];
    const remaining = existing.filter((modifier) => modifier !== this.modifier);
    if (remaining.length !== existing.length) {
      this.splat.objectModifiers = remaining;
      this.splat.updateGenerator();
    }
    this.memberships.clear();
    this.selectedCount = 0;
    this.texture.dispose();
    this.paletteTexture.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("GaussianMaskManager has been disposed");
  }

  private validateIds(ids: ArrayLike<number>): ValidatedIds {
    if (!ids || !Number.isSafeInteger(ids.length) || ids.length < 0) {
      throw new TypeError("ids must be an array-like collection of storage indices");
    }
    const next = new Set<number>();
    let duplicateIds = 0;
    let invalidIds = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!Number.isSafeInteger(id) || id < 0 || id >= this.numSplats) {
        invalidIds++;
      } else if (next.has(id)) {
        duplicateIds++;
      } else {
        next.add(id);
      }
    }
    return {
      indices: Uint32Array.from(next).sort(),
      lookup: next,
      duplicateIds,
      invalidIds,
    };
  }

  private winningLabel(id: number): number {
    let winner = 0;
    let latestOrder = -1;
    for (const [label, membership] of this.memberships) {
      if (membership.updateOrder > latestOrder && membership.lookup.has(id)) {
        winner = label;
        latestOrder = membership.updateOrder;
      }
    }
    return winner;
  }

  private recomputeAffected(affected: ReadonlySet<number>): number {
    let changedBytes = 0;
    for (const id of affected) {
      const previous = this.data[id];
      const next = this.winningLabel(id);
      if (previous === next) continue;
      this.data[id] = next;
      changedBytes++;
      if (previous === 0) this.selectedCount++;
      if (next === 0) this.selectedCount--;
    }
    return changedBytes;
  }

  private finishUpdate(
    rewriteStart: number,
    changedBytes: number,
    diagnostics: Pick<GaussianMaskUpdate, "validIds" | "duplicateIds" | "invalidIds"> | {
      validIds?: number;
      duplicateIds?: number;
      invalidIds?: number;
    },
  ): GaussianMaskUpdate {
    const rewriteMs = performance.now() - rewriteStart;
    let submissionMs = 0;
    if (changedBytes > 0) {
      const submissionStart = performance.now();
      this.texture.needsUpdate = true;
      this.submissions++;
      this.splat.updateVersion();
      submissionMs = performance.now() - submissionStart;
    }
    return {
      changed: changedBytes > 0,
      validIds: diagnostics.validIds ?? 0,
      duplicateIds: diagnostics.duplicateIds ?? 0,
      invalidIds: diagnostics.invalidIds ?? 0,
      changedBytes,
      rewriteMs,
      submissionMs,
    };
  }
}
