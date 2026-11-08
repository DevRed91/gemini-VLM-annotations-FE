// THROWAWAY experiment: smallest possible ID-based highlight probe.
import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";

const W = 4096; // mask texture width; id -> (id & 4095, id >> 12)

export class GaussianIdProbe {
  readonly tex: THREE.DataTexture;
  private data: Uint8Array;
  private rows: number;
  private color = dyno.dynoVec3(new THREE.Vector3(1, 0, 1));
  private strength = dyno.dynoFloat(0.9);
  // Temporary visibility aid, separate from membership (mask) logic.
  private boost = dyno.dynoFloat(1);
  // Debug: when >0.5, membership comes from a region predicate on gsplat.center
  // instead of the mask (used to cross-check CPU indices vs shader gsplat.index).
  private dbgOn = dyno.dynoFloat(0);
  private dbgMin = dyno.dynoVec3(new THREE.Vector3());
  private dbgMax = dyno.dynoVec3(new THREE.Vector3());
  private selected: number[] = [];

  constructor(private splat: SplatMesh, numSplats: number) {
    this.rows = Math.ceil(numSplats / W);
    this.data = new Uint8Array(W * this.rows);
    this.tex = new THREE.DataTexture(this.data, W, this.rows, THREE.RedIntegerFormat, THREE.UnsignedByteType);
    this.tex.internalFormat = "R8UI";
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.unpackAlignment = 1;
    this.tex.needsUpdate = true;

    const mask = dyno.dynoUsampler2D(this.tex);
    const mod = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat, mask: "usampler2D", color: "vec3", strength: "float", boost: "float",
        dbgOn: "float", dbgMin: "vec3", dbgMax: "vec3",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) => dyno.unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        int gpIdx = ${inputs.gsplat}.index;
        bool gpSel;
        if (${inputs.dbgOn} > 0.5) {
          vec3 gpC = ${inputs.gsplat}.center;
          gpSel = all(greaterThanEqual(gpC, ${inputs.dbgMin})) && all(lessThanEqual(gpC, ${inputs.dbgMax}));
        } else {
          gpSel = texelFetch(${inputs.mask}, ivec2(gpIdx & 4095, gpIdx >> 12), 0).r > 0u;
        }
        if (gpSel) {
          ${outputs.gsplat}.rgba.rgb = mix(${inputs.gsplat}.rgba.rgb, ${inputs.color}, ${inputs.strength});
          ${outputs.gsplat}.scales *= ${inputs.boost};
        }
      `),
    });
    const block = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => ({
      gsplat: mod.apply({
        gsplat, mask, color: this.color, strength: this.strength, boost: this.boost,
        dbgOn: this.dbgOn, dbgMin: this.dbgMin, dbgMax: this.dbgMax,
      }).gsplat,
    }));
    // Compose with whatever is already installed (HoverTint) via the supported array.
    const existing = (splat as any).objectModifiers ?? [];
    (splat as any).objectModifiers = [...existing, block];
    splat.updateGenerator();
  }

  /** Write ids into the mask (no GPU upload / no version bump). */
  private writeIds(ids: ArrayLike<number>, v: number) {
    for (let i = 0; i < ids.length; i++) this.data[ids[i]] = v;
  }
  /** Upload only; caller decides whether to also call updateVersion(). */
  upload() { this.tex.needsUpdate = true; }

  clear(bump = true) {
    for (const id of this.selected) this.data[id] = 0;
    this.selected = [];
    this.upload();
    if (bump) this.splat.updateVersion();
  }
  replace(ids: ArrayLike<number>, bump = true) {
    // Fast path for big sets: wipe whole buffer.
    this.data.fill(0);
    this.writeIds(ids, 1);
    this.selected = Array.from(ids as ArrayLike<number>);
    this.upload();
    if (bump) this.splat.updateVersion();
  }
  setBoost(b: number) { this.boost.value = b; }
  setDebugRegion(min: THREE.Vector3 | null, max?: THREE.Vector3) {
    if (!min) { this.dbgOn.value = 0; return; }
    this.dbgMin.value.copy(min); this.dbgMax.value.copy(max!); this.dbgOn.value = 1;
  }
  get count() { return this.selected.length; }
}
