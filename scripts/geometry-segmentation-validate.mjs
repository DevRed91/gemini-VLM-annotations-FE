// Browser validation for the geometry-guided segmentation experiment (?demo=1&present=1&seg=1).
// Run: node scripts/geometry-segmentation-validate.mjs
//
// Needs the annotation backend running with SEGMENTATION_PROVIDER=mock and this page's origin allowed:
//   SEG_API_BASE=http://127.0.0.1:3917   (default)   CORS_ALLOWED_ORIGINS=http://127.0.0.1:5213
// The MOCK provider returns synthetic discs: this script validates wiring and geometry on a real splat,
// NOT SAM 3 quality. Optional env: SEG_GL=swiftshader, SEG_URL (use a running dev server), CHROME_EXE,
// SEG_OUT (screenshot/JSON dir, default /tmp/segmentation-validate).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.SEG_URL ?? "http://127.0.0.1:5213";
const apiBase = process.env.SEG_API_BASE ?? "http://127.0.0.1:3917";
const outDir = process.env.SEG_OUT ?? "/tmp/segmentation-validate";
mkdirSync(outDir, { recursive: true });
let server;
let browser;
const results = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${lastError ?? "HTTP error"}`);
}

async function settle(page, ms = 1500) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(ms);
}

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.SEG_URL) {
    const vite = new URL("node_modules/vite/bin/vite.js", `file://${root}/`).pathname;
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5213", "--strictPort", "--no-open"], {
      cwd: root,
      env: { ...process.env, VITE_API_BASE_URL: apiBase },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/`);
  }
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    args: process.env.SEG_GL === "swiftshader"
      ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
      : ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseURL}/?demo=1&present=1&inference=off&seg=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__demo && window.__seg && window.__sl?.viewer?.splatLoaded), null, { timeout: 120000 });
  await settle(page, 3500); // Spark raycast returns nothing until the splat has settled

  // ---------------------------------------------------------------- wiring
  const wiring = await page.evaluate(() => ({
    panel: Boolean(document.querySelector("[data-segmentation]")),
    mounted: document.querySelector("[data-segmentation]")?.textContent.includes("Geometry-guided SAM 3"),
    productionApi: typeof window.__sl.viewer.annotateFromDetection === "function",
  }));
  check("segmentation panel mounted only via ?seg=1", wiring.panel && wiring.mounted);

  // ------------------------------------------- 1. click is consumed by pick mode
  const before = await page.evaluate(() => ({
    annotations: window.__sl.viewer.annotations.length,
    captures: window.__demo.counters.captures,
    loading: !document.querySelector(".annotation-loading")?.classList.contains("hidden"),
  }));
  await page.evaluate(() => {
    window.__sl.viewer.isSelecting = true; // production annotation tool ON: a leaked click would call Gemini
    window.__seg.controller.setPicking(true);
  });
  await page.mouse.click(640, 360);
  const afterClick = await page.evaluate(() => {
    const s = window.__seg.controller.state();
    return {
      picking: s.picking,
      status: s.status,
      hasAnchor: Boolean(s.anchor),
      annotations: window.__sl.viewer.annotations.length,
      captures: window.__demo.counters.captures,
      loading: !document.querySelector(".annotation-loading")?.classList.contains("hidden"),
    };
  });
  await page.evaluate(() => { window.__sl.viewer.isSelecting = false; });
  check("pick click consumed: no production capture, no loading spinner, no annotation",
    afterClick.captures === before.captures && !afterClick.loading && afterClick.annotations === before.annotations,
    `captures ${before.captures}->${afterClick.captures}`);
  check("pick mode disarmed after one click; result reported", !afterClick.picking && (afterClick.hasAnchor || /No splat hit/.test(afterClick.status)), afterClick.status);

  // ------------------------------------------- 2. anchor on real geometry
  // Scan a coarse grid for a stable anchor (the centre may be empty space).
  const pick = await page.evaluate(() => {
    const c = window.__seg.controller;
    const t0 = performance.now();
    const tried = [];
    for (const v of [0.55, 0.65, 0.75, 0.45]) {
      for (const u of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const p = c.pickAt(u, v, { width: innerWidth, height: innerHeight });
        tried.push([u, v, p ? p.refinement.hitCount : 0]);
        if (p && p.refinement.stable) {
          return { u, v, ms: performance.now() - t0, tried: tried.length, r: p.refinement, camera: p.cameraPosition };
        }
      }
    }
    return { none: true, tried: tried.length };
  });
  check("found a stable anchor on the real splat", !pick.none, pick.none ? `${pick.tried} probes` : `u=${pick.u} v=${pick.v}, ${pick.r.hitCount}/9 rays, spread ${pick.r.spread.toFixed(4)}`);
  if (pick.none) throw new Error("no stable anchor found; cannot continue");
  console.log(`      anchor ${JSON.stringify(pick.r.anchor)}  (${pick.tried} pick attempt(s), ${pick.ms.toFixed(0)} ms total)`);

  // ------------------------------------------- 3. capture three views orbiting the anchor
  const setPoseAround = (yawDeg, top = false) =>
    page.evaluate(({ yawDeg, top }) => {
      const THREE = window.__sl.THREE;
      const viewer = window.__sl.viewer;
      const anchor = new THREE.Vector3(...["x", "y", "z"].map((k) => window.__seg.controller.state().anchor.refinement.anchor[k]));
      const home = window.__seg.controller.state().anchor.cameraPosition;
      const offset = new THREE.Vector3(home.x, home.y, home.z).sub(anchor);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
      // Top view: same distance from the anchor, directly above it.
      if (top) offset.set(0, offset.length(), 0);
      const position = anchor.clone().add(offset);
      const look = new THREE.PerspectiveCamera();
      look.position.copy(position);
      look.lookAt(anchor);
      viewer.cameraOrientTarget = null;
      viewer.cameraRig.position.copy(position);
      viewer.cameraRig.quaternion.copy(look.quaternion);
      viewer.camera.position.set(0, 0, 0);
      viewer.camera.quaternion.set(0, 0, 0, 1);
      viewer.camera.updateWorldMatrix(true, false);
    }, { yawDeg, top });

  for (const [slot, yaw, top] of [["front", 0, false], ["side", 45, false], ["top", 0, true]]) {
    await setPoseAround(yaw, top);
    await settle(page, 1800);
    await page.evaluate((s) => window.__demo.capturePresentationSlot(s), slot);
  }
  const count = await page.evaluate(() => window.__demo.state().presentation.count);
  check("three views captured", count === 3, `count ${count}`);

  // ------------------------------------------- 4. projection round trip on the real cameras
  const projection = await page.evaluate(async () => {
    const vs = await import("/src/viewer/ViewSnapshot.ts");
    const geo = await import("/src/segmentation/geometry.ts");
    const state = window.__seg.controller.state();
    const anchor = state.anchor.refinement.anchor;
    const gen = window.__sl.viewer.worldGeneration;
    return window.__demo.state().presentation.captures.map((c) => {
      const p = geo.projectAnchorToImage(c.snapshot, anchor, gen);
      let miss = null;
      if (p.image) {
        const ray = vs.generateSnapshotRay(c.snapshot, p.image.x / c.snapshot.image.width, p.image.y / c.snapshot.image.height, gen);
        const t = (anchor.x - ray.origin.x) * ray.direction.x + (anchor.y - ray.origin.y) * ray.direction.y + (anchor.z - ray.origin.z) * ray.direction.z;
        miss = Math.hypot(ray.origin.x + ray.direction.x * t - anchor.x, ray.origin.y + ray.direction.y * t - anchor.y, ray.origin.z + ray.direction.z * t - anchor.z);
      }
      return { slot: c.slot, status: p.status, image: p.image, miss, size: [c.snapshot.image.width, c.snapshot.image.height] };
    });
  });
  for (const v of projection) {
    console.log(`      ${v.slot}: ${v.status}${v.image ? ` at (${v.image.x.toFixed(0)}, ${v.image.y.toFixed(0)}) of ${v.size.join("x")}` : ""}`);
  }
  check("front view (the picking pose) projects the anchor in-frame near the image centre",
    projection[0].status === "in-view" && Math.hypot(projection[0].image.x / projection[0].size[0] - 0.5, projection[0].image.y / projection[0].size[1] - 0.5) < 0.12);
  check("every in-frame projection's pixel ray passes through the anchor (< 1e-6)",
    projection.filter((p) => p.image).every((p) => p.miss < 1e-6),
    projection.map((p) => (p.miss === null ? "–" : p.miss.toExponential(1))).join(" "));

  // ------------------------------------------- 5. helper pollution: direct caster is immune
  const pollution = await page.evaluate(async () => {
    const THREE = window.__sl.THREE;
    const viewer = window.__sl.viewer;
    const geo = await import("/src/segmentation/geometry.ts");
    const cast = geo.createSplatCaster(viewer.currentSplat);
    const o = viewer.camera.getWorldPosition(new THREE.Vector3());
    const d = viewer.camera.getWorldDirection(new THREE.Vector3());
    const ray = { origin: { x: o.x, y: o.y, z: o.z }, direction: { x: d.x, y: d.y, z: d.z } };
    const direct0 = cast(ray.origin, ray.direction)[0] ?? null;
    const legacy = () => {
      const rc = new THREE.Raycaster(o, d);
      const hit = rc.intersectObject(viewer.currentSplat)[0];
      return hit ? { distance: hit.distance, type: hit.object.type } : null;
    };
    const legacy0 = legacy();
    await window.__sl.inject("probe", [0.35, 0.35, 0.65, 0.65]);
    const helpers = viewer.currentSplat.children.length;
    const direct1 = cast(ray.origin, ray.direction)[0] ?? null;
    const legacy1 = legacy();
    return { direct0: direct0?.distance ?? null, direct1: direct1?.distance ?? null, legacy0, legacy1, helpers };
  });
  console.log(`      direct ${pollution.direct0} -> ${pollution.direct1}; legacy ${JSON.stringify(pollution.legacy0)} -> ${JSON.stringify(pollution.legacy1)}; splat children ${pollution.helpers}`);
  check("an annotation helper was added under the splat", pollution.helpers > 0, `${pollution.helpers} children`);
  check("direct splat cast is unchanged by the helper", pollution.direct0 !== null && pollution.direct0 === pollution.direct1);
  await page.evaluate(() => window.__sl.clearAll());

  // ------------------------------------------- 6. full experiment against the real backend (mock provider)
  await page.evaluate(() => window.__seg.controller.configure({ text: "object", variants: ["text", "point", "point+text"], occlusionPolicy: "send" }));
  const run = await page.evaluate(async () => {
    const c = window.__seg.controller;
    const result = await c.run();
    const state = c.state();
    return {
      status: state.status,
      exported: JSON.stringify(c.exportResult()),
      views: result?.views.map((v) => ({
        slot: v.slot,
        projection: v.projection?.status,
        visibility: v.visibility?.visibility,
        variants: v.variants.map((x) => ({
          variant: x.variant, status: x.status, reason: x.reason, mock: x.mock,
          hasAnchor: x.primary === null ? null : x.masks[x.primary].containsAnchor,
        })),
      })),
      spread: result?.crossViewSpread,
      probes: result?.centroidProbes.map((p) => ({ v: p.variant, s: p.slot, d: p.distanceToAnchor })),
      bannerShown: document.querySelector(".seg__mock")?.textContent ?? null,
    };
  });
  console.log(JSON.stringify(run.views, null, 1).replace(/\n\s*/g, " ").slice(0, 900));
  check("run completed against the real backend", /Done/.test(run.status), run.status);
  check("MOCK banner shown and results flagged mock", /MOCK/.test(run.bannerShown ?? "") && run.views.every((v) => v.variants.filter((x) => x.status === "ok").every((x) => x.mock === true)));
  check("point prompts produce a mask that contains the anchor in every prompted view",
    run.views.filter((v) => v.projection === "in-view").every((v) => v.variants.find((x) => x.variant === "point")?.hasAnchor === true));
  check("every view has visibility recorded (visible / occluded / unverified)", run.views.filter((v) => v.projection === "in-view").every((v) => ["visible", "occluded", "unverified"].includes(v.visibility)));
  check("export contains stats but no mask data or images", !run.exported.includes("counts") && !run.exported.includes("data:image") && run.exported.includes("areaFraction"));
  await page.screenshot({ path: `${outDir}/segmentation-panel.png` });
  writeFileSync(`${outDir}/run.json`, JSON.stringify({ pick, projection, pollution, run: { ...run, exported: undefined } }, null, 2));

  check("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
} catch (error) {
  console.error(error);
  check("script completed", false, String(error).slice(0, 200));
} finally {
  await browser?.close();
  server?.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
