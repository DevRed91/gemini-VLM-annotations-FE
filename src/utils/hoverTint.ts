import * as THREE from "three";
import { dyno, SplatMesh } from "@sparkjsdev/spark";
import type { GsplatModifier } from "@sparkjsdev/spark";
import { OBB } from "./obb";

export { OBB } from "./obb";

/** Ray vs OBB (slab method in box-local space). */
const _inv = new THREE.Matrix4();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
export function rayIntersectsOBB(ray: THREE.Ray, obb: OBB): number | null {
  _inv.copy(obb.getWorldMatrix()).invert();
  _o.copy(ray.origin).applyMatrix4(_inv);
  _d.copy(ray.direction).transformDirection(_inv);

  const h = obb.halfExtents;
  let tMin = 0;
  let tMax = Infinity;
  const o = [_o.x, _o.y, _o.z];
  const d = [_d.x, _d.y, _d.z];
  const e = [h.x, h.y, h.z];

  for (let i = 0; i < 3; i++) {
    const axis = i;
    if (Math.abs(d[axis]) < 1e-9) {
      if (Math.abs(o[axis]) > e[axis]) return null;
      continue;
    }
    let t1 = (-e[axis] - o[axis]) / d[axis];
    let t2 = (e[axis] - o[axis]) / d[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin >= 0 ? tMin : null;
}

/** Nearest OBB hit along the ray (so overlapping units pick the closest). */
export function pickNearestOBB<T extends { obb: OBB }>(
  ray: THREE.Ray,
  items: Iterable<T>,
): T | null {
  let best: T | null = null;
  let bestT = Infinity;
  for (const item of items) {
    const t = rayIntersectsOBB(ray, item.obb);
    if (t !== null && t < bestT) {
      best = item;
      bestT = t;
    }
  }
  return best;
}

export interface HoverTintOptions {
  color?: readonly [number, number, number];
  strength?: number;
  feather?: number;
  /** World boxes need a per-frame transform; splat-local boxes ride the mesh. */
  space?: "world" | "splat";
}

/** Zero-extra-draw-call hover/persistent OBB tint with owned cleanup. */
export class HoverTint {
  private splatToBox = dyno.dynoMat4(new THREE.Matrix4());
  private halfExtents = dyno.dynoVec3(new THREE.Vector3());
  private color = dyno.dynoVec3(new THREE.Vector3(0.2, 0.9, 0.6));
  private active = dyno.dynoFloat(0);
  private strength = dyno.dynoFloat(0.45);
  private feather = dyno.dynoFloat(0.05);
  private current: OBB | null = null;
  private modifier: GsplatModifier | null = null;
  private disposed = false;
  private readonly space: "world" | "splat";

  private _boxInv = new THREE.Matrix4();
  private _m = new THREE.Matrix4();

  constructor(private splat: SplatMesh, options: HoverTintOptions = {}) {
    this.space = options.space ?? "world";
    if (options.color) this.color.value.fromArray(options.color);
    if (options.strength !== undefined) this.strength.value = options.strength;
    if (options.feather !== undefined) this.feather.value = options.feather;
    this.install();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("HoverTint has been disposed");
  }

  private install(): void {
    const tint = new dyno.Dyno({
      inTypes: {
        gsplat: dyno.Gsplat,
        splatToBox: "mat4",
        halfExtents: "vec3",
        color: "vec3",
        active: "float",
        strength: "float",
        feather: "float",
      },
      outTypes: { gsplat: dyno.Gsplat },
      statements: ({ inputs, outputs }) =>
        dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};
          if (${inputs.active} > 0.5) {
            vec3 hvLocalPos = (${inputs.splatToBox} * vec4(${inputs.gsplat}.center, 1.0)).xyz;
            vec3 hvD = abs(hvLocalPos) - ${inputs.halfExtents};
            if (hvD.x <= 0.0 && hvD.y <= 0.0 && hvD.z <= 0.0) {
              float hvEdge = max(hvD.x, max(hvD.y, hvD.z));
              float hvMask = 1.0 - smoothstep(-max(${inputs.feather}, 1e-5), 0.0, hvEdge);
              ${outputs.gsplat}.rgba.rgb = mix(
                ${inputs.gsplat}.rgba.rgb, ${inputs.color}, ${inputs.strength} * hvMask);
            }
          }
        `),
    });

    const modifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => ({
        gsplat: tint.apply({
          gsplat,
          splatToBox: this.splatToBox,
          halfExtents: this.halfExtents,
          color: this.color,
          active: this.active,
          strength: this.strength,
          feather: this.feather,
        }).gsplat,
      }),
    );
    this.modifier = modifier;
    this.splat.objectModifiers = [...(this.splat.objectModifiers ?? []), modifier];
    this.splat.updateGenerator();
  }

  setColor(r: number, g: number, b: number): void {
    this.assertActive();
    this.color.value.set(r, g, b);
    this.splat.updateVersion();
  }

  /** Set (or clear with null) the hovered box. */
  setHovered(obb: OBB | null): void {
    this.assertActive();
    if (obb === this.current && obb === null) return;
    this.current = obb;
    if (!obb) {
      this.active.value = 0;
    } else {
      this.refresh();
      this.active.value = 1;
    }
    this.splat.updateVersion();
  }

  /** Recompute uniforms if the hovered world box or splat mesh moved. */
  refresh(): void {
    if (this.disposed) return;
    const obb = this.current;
    if (!obb) return;
    if (this.space === "world") {
      this.splat.updateWorldMatrix(true, false);
      this._boxInv.copy(obb.getWorldMatrix()).invert();
      this._m.multiplyMatrices(this._boxInv, this.splat.matrixWorld);
    } else {
      this._m.identity();
    }
    this.splatToBox.value.copy(this._m);
    this.halfExtents.value.copy(obb.halfExtents);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active.value = 0;
    this.current = null;
    if (this.modifier) {
      const existing = this.splat.objectModifiers ?? [];
      const remaining = existing.filter((modifier) => modifier !== this.modifier);
      if (remaining.length !== existing.length) {
        this.splat.objectModifiers = remaining;
        this.splat.updateGenerator();
      }
    }
    this.modifier = null;
  }
}
