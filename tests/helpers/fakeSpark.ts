// Minimal stand-in for @sparkjsdev/spark so the real GaussianMaskManager /
// GaussianObjectHighlighter / lifter logic runs in node.
import * as THREE from "three";

class FakeDyno {
  constructor(public readonly spec?: unknown) {}
  apply(_inputs?: unknown) { return { gsplat: this }; }
}

export const dyno = {
  Gsplat: "gsplat",
  Dyno: FakeDyno,
  dynoUsampler2D: (v: unknown) => ({ value: v }),
  dynoSampler2D: (v: unknown) => ({ value: v }),
  dynoInt: (v: number) => ({ value: v }),
  dynoFloat: (v: number) => ({ value: v }),
  unindentLines: (s: string) => s,
  dynoBlock: (_i: unknown, _o: unknown, fn: (x: { gsplat: unknown }) => unknown) => ({ block: fn }),
};

export interface FakeGaussian {
  center: [number, number, number];
  opacity?: number;
  scales?: [number, number, number];
  quaternion?: [number, number, number, number];
}

/** Splats are spheres of `radius`; raycast returns every sphere hit like Spark does. */
export class SplatMesh extends THREE.Object3D {
  numSplats: number;
  initialized = Promise.resolve();
  paged = false;
  enableLod: boolean | undefined = false;
  packedSplats: unknown = {};
  extSplats: unknown = undefined;
  objectModifiers: unknown[] | undefined = undefined;
  generatorUpdates = 0;
  versionUpdates = 0;

  constructor(public gaussians: FakeGaussian[] = [], public radius = 0.06) {
    super();
    this.numSplats = gaussians.length;
  }

  updateGenerator() { this.generatorUpdates++; }
  updateVersion() { this.versionUpdates++; }

  forEachSplat(cb: (i: number, c: THREE.Vector3, s: THREE.Vector3, q: THREE.Quaternion, o: number, col: THREE.Color) => void) {
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    this.gaussians.forEach((g, i) => {
      c.set(...g.center);
      s.set(...(g.scales ?? [this.radius, this.radius, this.radius]));
      q.set(...(g.quaternion ?? [0, 0, 0, 1]));
      cb(i, c, s, q, g.opacity ?? 1, col);
    });
  }

  raycast(raycaster: THREE.Raycaster, hits: THREE.Intersection[]) {
    this.updateWorldMatrix(true, false);
    const { origin, direction } = raycaster.ray;
    const p = new THREE.Vector3();
    this.gaussians.forEach((g, index) => {
      p.set(...g.center).applyMatrix4(this.matrixWorld);
      const oc = origin.clone().sub(p);
      const b = oc.dot(direction);
      const disc = b * b - (oc.lengthSq() - this.radius * this.radius);
      if (disc < 0) return;
      const t = -b - Math.sqrt(disc);
      if (t <= 0) return;
      hits.push({ distance: t, point: origin.clone().addScaledVector(direction, t), object: this, index } as THREE.Intersection);
    });
  }
}
