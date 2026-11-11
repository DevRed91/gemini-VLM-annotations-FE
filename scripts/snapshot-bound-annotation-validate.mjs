// Browser validation for snapshot-bound annotation sampling (Milestone 1).
// Gemini is mocked at /annotate only; everything else is the real pipeline.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.SNAPSHOT_BOUND_URL ?? "http://127.0.0.1:5212";
let server;
let browser;
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function pass(name, detail) {
  results.push(name);
  console.log(`PASS ${name}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}
async function waitForServer(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Vite did not become ready at ${url}`);
}

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.SNAPSHOT_BOUND_URL) {
    const vite = new URL("node_modules/vite/bin/vite.js", `file://${root}/`).pathname;
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5212", "--strictPort", "--no-open"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (c) => process.stderr.write(`[vite] ${c}`));
    await waitForServer(`${baseURL}/`);
  }
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on("pageerror", (e) => console.error(`[page error] ${e.message}`));
  page.on("console", (m) => { if (["warning", "error"].includes(m.type())) console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`); });
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sl?.viewer?.splatLoaded === true, null, { timeout: 120000 });

  // Shared in-page instrumentation.
  await page.evaluate(() => {
    const viewer = window.__sl.viewer;
    window.__t = { rays: [], bodies: [], snapshots: [], delayMs: 0, camAtRay: [] };
    const origCapture = viewer.captureViewSnapshot.bind(viewer);
    viewer.captureViewSnapshot = () => {
      const s = origCapture();
      window.__t.snapshots.push(s);
      return s;
    };
    const spy = (splat) => {
      if (splat.__spied) return;
      splat.__spied = true;
      const orig = splat.raycast.bind(splat);
      splat.raycast = (rc, hits) => {
        window.__t.rays.push([...rc.ray.origin.toArray(), ...rc.ray.direction.toArray()]);
        window.__t.camAtRay.push(viewer.camera.getWorldPosition(viewer.camera.position.clone()).toArray());
        return orig(rc, hits);
      };
    };
    window.__t.spyCurrent = () => spy(viewer.currentSplat);
    window.__t.spyCurrent();
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? "");
      if (!url.includes("/annotate")) return originalFetch(input, init);
      window.__t.bodies.push(JSON.parse(init.body));
      const body = { objects: [{ label: "probe", description: "d", box: [0.3, 0.35, 0.6, 0.65] }] };
      return new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      })), window.__t.delayMs));
    };
    document.getElementById("annotationToolButton").click();
  });

  const click = (x = 450, y = 300) => page.evaluate(([cx, cy]) => {
    document.querySelector("canvas").dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true }));
  }, [x, y]);
  const resetPose = () => page.evaluate(() => {
    const v = window.__sl.viewer;
    v.cameraRig.position.set(0, 0, 0);
    v.cameraRig.rotation.set(0, 0, 0);
    v.camera.position.set(0, 0, 0);
    v.camera.rotation.set(0, 0, 0);
    v.camera.updateMatrixWorld(true);
  });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // ---- 1. Legacy vs snapshot sampling are identical for a static camera ----
  await resetPose(); await settle();
  const equiv = await page.evaluate(async () => {
    const v = window.__sl.viewer;
    const binding = v.captureBoundSnapshot();
    const box = [0.3, 0.35, 0.6, 0.65];
    const grid = [];
    const n = 6;
    const nonLod = true;
    void nonLod;
    const fresh = v.samplePointsFromBox(binding, box).map((p) => p.toArray());
    // Legacy path: live camera, same grid formula.
    const gridSize = (() => {
      const area = (box[3] - box[1]) * (box[2] - box[0]);
      const isNonLod = !v.currentSplat.context?.enableLod?.value;
      const max = isNonLod ? 25 : 6;
      return Math.max(6, Math.min(max, Math.round(6 + (max - 6) * Math.sqrt(area))));
    })();
    const legacy = [];
    for (let r = 0; r < gridSize; r++) for (let c = 0; c < gridSize; c++) {
      const x = box[1] + ((c + 0.5) / gridSize) * (box[3] - box[1]);
      const y = box[0] + ((r + 0.5) / gridSize) * (box[2] - box[0]);
      const p = v.splatRay(x, y)?.intersection?.point;
      if (p) legacy.push(p.toArray());
    }
    void grid; void n;
    return { fresh, legacy };
  });
  assert(equiv.fresh.length > 0, "snapshot sampling produced no hits; scene view may be empty");
  assert(equiv.fresh.length === equiv.legacy.length, `hit count differs: ${equiv.fresh.length} vs ${equiv.legacy.length}`);
  const maxDelta = Math.max(...equiv.fresh.map((p, i) => Math.max(...p.map((c, k) => Math.abs(c - equiv.legacy[i][k])))));
  assert(maxDelta < 1e-5, `snapshot and legacy hits differ by ${maxDelta}`);
  pass("snapshot sampling == legacy sampling for a static camera", { hits: equiv.fresh.length, maxDelta });

  // ---- 2. Sampled hits project back inside the requested box (coordinate convention) ----
  const proj = await page.evaluate(async () => {
    const { projectSnapshotPoint } = await import("/src/viewer/ViewSnapshot.ts");
    const v = window.__sl.viewer;
    const binding = v.captureBoundSnapshot();
    const box = [0.3, 0.35, 0.6, 0.65]; // [ymin, xmin, ymax, xmax], 0-1, top-left origin
    const pts = v.samplePointsFromBox(binding, box);
    const eps = 1e-4;
    const outside = pts.filter((p) => {
      const q = projectSnapshotPoint(binding.snapshot, p, v.worldGeneration).normalized;
      return !q || q.u < box[1] - eps || q.u > box[3] + eps || q.v < box[0] - eps || q.v > box[2] + eps;
    }).length;
    return { total: pts.length, outside };
  });
  assert(proj.total > 0 && proj.outside === 0, `${proj.outside}/${proj.total} hits project outside the box`);
  pass("sampled hits re-project inside the snapshot-space box (y down, x right)", proj);

  // ---- 3. Camera motion during the Gemini round trip does not change rays ----
  const runClick = async (moveDuring) => {
    await resetPose(); await settle();
    await page.evaluate(() => { window.__t.rays = []; window.__t.camAtRay = []; window.__t.bodies = []; window.__t.snapshots = []; window.__t.delayMs = 1500; });
    await click();
    if (moveDuring) {
      await page.waitForFunction(() => window.__t.bodies.length === 1, null, { timeout: 10000 });
      await page.evaluate(() => {
        const v = window.__sl.viewer;
        v.cameraRig.position.set(2.5, 0.4, -2);
        v.cameraRig.rotation.set(0.2, 1.1, 0);
        v.camera.updateMatrixWorld(true);
      });
    }
    await page.waitForFunction(() => window.__t.rays.length > 5, null, { timeout: 60000 });
    await page.waitForTimeout(1000);
    return page.evaluate(() => ({
      rays: window.__t.rays.slice(), camAtRay: window.__t.camAtRay.slice(),
      body: window.__t.bodies[0], snapshotImage: window.__t.snapshots[0]?.image.dataUrl,
      snapCam: window.__t.snapshots[0]?.camera.position,
    }));
  };
  const still = await runClick(false);
  const moved = await runClick(true);
  assert(still.rays.length > 0 && moved.rays.length > 0, "no sampling rays recorded");
  assert(still.body.image === still.snapshotImage, "request image is not the bound snapshot image");
  assert(moved.body.image === moved.snapshotImage, "moved-run request image is not the bound snapshot image");
  // The live camera really did move away before sampling.
  const liveDrift = Math.hypot(...moved.camAtRay[moved.camAtRay.length - 1].map((c, i) => c - [moved.snapCam.x, moved.snapCam.y, moved.snapCam.z][i]));
  assert(liveDrift > 1, `live camera did not move (drift ${liveDrift})`);
  // Sampling rays equal the static-camera baseline despite the motion.
  const firstClickRays = moved.rays.slice(0, still.rays.length);
  // The click path itself casts one ray (live, same tick) before sampling; compare the sampling tail.
  const tail = (a, n) => a.slice(a.length - n);
  const n = Math.min(still.rays.length, moved.rays.length) - 1;
  const rayDelta = Math.max(...tail(still.rays, n).flatMap((r, i) => r.map((c, k) => Math.abs(c - tail(moved.rays, n)[i][k]))));
  void firstClickRays;
  assert(rayDelta < 1e-6, `sampling rays changed with camera motion (max delta ${rayDelta})`);
  pass("camera motion during Gemini processing leaves sampling rays unchanged", { rays: n, liveDrift, rayDelta });

  // ---- 4. World replacement invalidates outstanding requests ----
  await resetPose(); await settle();
  const world = await page.evaluate(async () => {
    const v = window.__sl.viewer;
    const staleBinding = v.captureBoundSnapshot();
    window.__t.delayMs = 1500; window.__t.rays = []; window.__t.bodies = [];
    document.querySelector("canvas").dispatchEvent(new MouseEvent("click", { clientX: 450, clientY: 300, bubbles: true }));
    const raysAtClick = window.__t.rays.length; // click-path hit test only
    // Replace the world while Gemini is "processing".
    const loading = v.loadWorld("/office_space.sog");
    // Capture during (re)initialization must be rejected synchronously.
    let rejected = null;
    try { v.captureBoundSnapshot(); } catch (e) { rejected = { name: e.name, reason: e.reason }; }
    await loading;
    window.__t.spyCurrent();
    const raysAfterLoad = window.__t.rays.length;
    const annotationsAfterLoad = v.annotations.length;
    await new Promise((r) => setTimeout(r, 2500));
    let staleError = null;
    try { v.samplePointsFromBox(staleBinding, [0.3, 0.35, 0.6, 0.65]); } catch (e) { staleError = { name: e.name, reason: e.reason }; }
    return {
      raysAtClick, raysAfterLoad, raysAfterResponse: window.__t.rays.length,
      annotationsAfterLoad, annotationsAfterResponse: v.annotations.length, rejected, staleError,
    };
  });
  assert(world.rejected?.name === "StaleSnapshotError" && world.rejected.reason === "no-splat", `capture during init not rejected: ${JSON.stringify(world.rejected)}`);
  assert(world.raysAfterResponse === world.raysAfterLoad, "stale request cast rays after world replacement");
  assert(world.annotationsAfterResponse === world.annotationsAfterLoad, "stale request created an annotation after world replacement");
  assert(world.staleError?.name === "StaleSnapshotError" && ["world-generation", "splat-instance"].includes(world.staleError.reason), `old binding was not rejected: ${JSON.stringify(world.staleError)}`);
  pass("world replacement invalidates outstanding requests and bindings", world);

  console.log(`\n${results.length} browser checks passed`);
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
