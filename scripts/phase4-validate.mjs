// Phase 4: OBB fit-quality checks on synthetic scenes (no browser needed).
// Run: npm run validate:phase4
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase4-"));
const bundle = path.join(tmp, "bundle.mjs");
const build = spawnSync(
  "npx",
  ["rolldown", path.join(root, "scripts/phase4-entry.ts"), "--format", "esm", "--file", bundle],
  { cwd: root, encoding: "utf8" },
);
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  process.exit(1);
}
const { fitOBB, GeometricContextManager, adaptiveEps, filterDepthOutliers, THREE } =
  await import(bundle);

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([name, true]);
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Points on a flat disc (table top), optionally yawed footprint = rectangle. */
function disc(radius, y, n = 600) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r = radius * Math.sqrt(rand());
    const a = rand() * Math.PI * 2;
    pts.push(V(r * Math.cos(a), y + (rand() - 0.5) * 0.03, r * Math.sin(a)));
  }
  return pts;
}
function rect(w, d, y, yaw, n = 600) {
  const pts = [];
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (let i = 0; i < n; i++) {
    const u = (rand() - 0.5) * w;
    const v = (rand() - 0.5) * d;
    pts.push(V(u * c + v * s, y + (rand() - 0.5) * 0.03, -u * s + v * c));
  }
  return pts;
}
/** Vase on top + stray floor hits: ~4% of the cloud. */
function clutter(count, radius) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    pts.push(
      i % 2
        ? V((rand() - 0.5) * 0.1, 0.75 + rand() * 0.35, (rand() - 0.5) * 0.1)
        : V((rand() - 0.5) * radius * 4, 0, (rand() - 0.5) * radius * 4),
    );
  }
  return pts;
}
const upDot = (q) => V(0, 1, 0).applyQuaternion(q).y;

test("upright fit keeps the box vertical where PCA tilts it", () => {
  const pts = [...disc(0.5, 0.75), ...clutter(24, 0.5)];
  const up = fitOBB(pts, { mode: "upright" });
  assert(up.method === "upright", "method should be upright");
  assert(near(upDot(up.obb.quaternion), 1, 1e-9), "upright box is not gravity-aligned");
  const pca = fitOBB(pts, { mode: "pca" });
  assert(upDot(pca.obb.quaternion) < 0.9999, "control: PCA expected to tilt on cluttered disc");
});

test("round tabletop: trimmed footprint ~1.0m, height thin, outliers ignored", () => {
  const pts = [...disc(0.5, 0.75), ...clutter(24, 0.5)];
  const { obb } = fitOBB(pts, { mode: "upright", margin: 0 }) ;
  assert(near(obb.size.x, 1.0, 0.08) && near(obb.size.z, 1.0, 0.08),
    `footprint ${obb.size.x.toFixed(2)}x${obb.size.z.toFixed(2)} not ~1.0`);
  assert(obb.size.y < 0.2, `height ${obb.size.y.toFixed(2)} should be thin (<0.2)`);
  assert(near(obb.position.y, 0.75, 0.05), `centre y ${obb.position.y.toFixed(2)} off tabletop`);
  const untrimmed = fitOBB(pts, { mode: "upright", margin: 0, trim: 0, trimY: 0 });
  assert(untrimmed.obb.size.y > 0.5, "control: untrimmed height should be inflated by clutter");
});

test("rectangular top yawed 30deg: yaw and size recovered", () => {
  const yaw = (30 * Math.PI) / 180;
  const pts = [...rect(1.4, 0.7, 0.75, yaw), ...clutter(24, 0.7)];
  const { obb } = fitOBB(pts, { mode: "upright", margin: 0 });
  const dims = [obb.size.x, obb.size.z].sort((a, b) => a - b);
  assert(near(dims[0], 0.7, 0.07) && near(dims[1], 1.4, 0.1), `size ${dims.map((d) => d.toFixed(2))}`);
  // Long axis direction should be yaw-aligned (mod 180deg).
  const long = (obb.size.x > obb.size.z ? V(1, 0, 0) : V(0, 0, 1)).applyQuaternion(obb.quaternion);
  const expected = V(Math.cos(yaw), 0, -Math.sin(yaw));
  assert(Math.abs(long.dot(expected)) > 0.99, `long axis misaligned (dot ${long.dot(expected).toFixed(3)})`);
});

test("upright obb round-trips: every trimmed-in point lies inside the box", () => {
  const pts = rect(1.2, 0.6, 0.7, 0.4);
  const { obb } = fitOBB(pts, { mode: "upright", margin: 0.02 });
  const inv = obb.getWorldMatrix().invert();
  const half = obb.halfExtents;
  const inside = pts.filter((p) => {
    const l = p.clone().applyMatrix4(inv);
    return Math.abs(l.x) <= half.x && Math.abs(l.y) <= half.y && Math.abs(l.z) <= half.z;
  }).length;
  assert(inside / pts.length > 0.93, `only ${inside}/${pts.length} inside`);
});

test("adaptive eps follows sample spacing and stays clamped", () => {
  const dense = rect(1, 1, 0.75, 0, 900);
  const eps = adaptiveEps(dense);
  assert(eps >= 0.05 && eps <= 0.3, `eps ${eps} out of clamp`);
  assert(eps < 0.2, `eps ${eps.toFixed(3)} too large for dense samples`);
});

test("DBSCAN with adaptive eps drops floor strip that eps=0.3 merges", () => {
  const top = rect(1, 1, 0.75, 0, 900);
  const strip = [];
  for (let i = 0; i < 80; i++) strip.push(V((rand() - 0.5) * 1, 0.75 - 0.22 - rand() * 0.02, 0.5 + 0.1 + rand() * 0.1));
  const all = [...top, ...strip];
  const mgr = new GeometricContextManager();
  const adaptive = mgr.registerAndMeasureObject("table", all, { minPts: 4 });
  const fixed = mgr.registerAndMeasureObject("table", all, { eps: 0.3, minPts: 4 });
  assert(adaptive && fixed, "clustering returned null");
  assert(adaptive.dimensions.height < 0.1, `adaptive height ${adaptive.dimensions.height.toFixed(2)}`);
  assert(fixed.dimensions.height > 0.15, "control: eps=0.3 expected to merge the strip");
});

test("depth filter removes see-through background, keeps deep continuous surface", () => {
  const cam = V(0, 1.2, 4);
  const surface = [];
  for (let i = 0; i < 200; i++) surface.push(V((rand() - 0.5) * 1, 0.75, 3 - rand() * 1.0)); // 1m deep
  const background = [];
  for (let i = 0; i < 20; i++) background.push(V(rand(), 1, -2));
  const kept = filterDepthOutliers([...surface, ...background], cam);
  assert(kept.length >= 195, `dropped real surface points (${kept.length})`);
  assert(kept.every((p) => p.z > 1.5), "background survived the depth filter");
});

test("dominant layer: table top + legs fits a thin slab, off by default", () => {
  const top = rect(1, 1, 0.75, 0, 800);
  const legs = [];
  for (let i = 0; i < 120; i++) legs.push(V(-0.1 + rand() * 0.2, 0.75 - rand() * 0.75, -0.1 + rand() * 0.2));
  const all = [...top, ...legs];
  const plain = fitOBB(all, { mode: "upright", margin: 0 });
  const layered = fitOBB(all, { mode: "upright", margin: 0, dominantLayer: true });
  assert(plain.obb.size.y > 0.6, `control height ${plain.obb.size.y.toFixed(2)}`);
  assert(layered.obb.size.y < 0.2, `layered height ${layered.obb.size.y.toFixed(2)}`);
  assert(layered.obb.size.x > 0.9 || layered.obb.size.z > 0.9, "footprint lost");
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
