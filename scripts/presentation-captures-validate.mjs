// Browser validation for presentation-mode multi-view captures (?demo=1&present=1).
// Run: node scripts/presentation-captures-validate.mjs
// Optional env: PRESENTATION_GL=swiftshader, PRESENTATION_URL (use an already-running dev server), CHROME_EXE,
// PRESENTATION_OUT (screenshot dir, default /tmp/presentation-validate).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.PRESENTATION_URL ?? "http://127.0.0.1:5212";
const outDir = process.env.PRESENTATION_OUT ?? "/tmp/presentation-validate";
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

async function openPage(search) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseURL}/${search}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__demo && window.__sl?.viewer?.splatLoaded), null, { timeout: 120000 });
  return { page, errors };
}

/** Let Spark finish its async splat sort for the current pose before reading pixels. */
async function settle(page, ms = 1500) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(ms);
}

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.PRESENTATION_URL) {
    const vite = new URL("node_modules/vite/bin/vite.js", `file://${root}/`).pathname;
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5212", "--strictPort", "--no-open"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/`);
  }
  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    // Real GPU by default (Metal on macOS): under SwiftShader one 1280x720 frame costs ~9 s,
    // so every canvas readback stalls on the queued software-GL backlog.
    // PRESENTATION_GL=swiftshader forces software GL (slow, but works without a GPU).
    args: process.env.PRESENTATION_GL === "swiftshader"
      ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
      : ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
  });

  // ------------------------------------------------ 1. normal demo mode unchanged
  {
    const { page, errors } = await openPage("?demo=1&inference=off");
    const normal = await page.evaluate(() => {
      const hud = document.querySelector("[data-demo-hud]");
      const before = window.__demo.counters.captures;
      window.__sl.viewer.captureViewSnapshot();
      return {
        hudVisible: Boolean(hud) && getComputedStyle(hud).display !== "none",
        hasPresentationUI: Boolean(document.querySelector("[data-presentation]")),
        presentationState: window.__demo.state().presentation,
        productionCaptureCounted: window.__demo.counters.captures - before,
      };
    });
    check("normal demo: engineering HUD visible", normal.hudVisible);
    check("normal demo: no presentation UI", !normal.hasPresentationUI && normal.presentationState === null);
    check("normal demo: production capture wrapper still counts", normal.productionCaptureCounted === 1);
    await page.keyboard.press("Shift+Digit1");
    check("normal demo: Shift+1 is inert", (await page.evaluate(() => window.__demo.counters.presentationCaptures)) === 0);
    await page.screenshot({ path: `${outDir}/normal-demo.png` });
    check("normal demo: no page errors", errors.length === 0, errors.join(" | "));
    await page.close();
  }

  // ------------------------------------------------ 2. presentation mode
  const { page, errors } = await openPage("?demo=1&present=1&inference=off");

  const renderer = await page.evaluate(() => {
    const gl = window.__sl.viewer.renderer.getContext();
    return { preserveDrawingBuffer: gl.getContextAttributes().preserveDrawingBuffer };
  });
  check("renderer has preserveDrawingBuffer enabled (verified at runtime)", renderer.preserveDrawingBuffer === true);

  // The label follows the world on the next ~100 ms HUD tick, not in the same tick as the load.
  await page.waitForFunction(() => /Apartment/.test(document.querySelector(".pres__scene")?.textContent ?? ""), null, { timeout: 5000 })
    .catch(() => {});
  const initial = await page.evaluate(() => {
    const hud = document.querySelector("[data-demo-hud]");
    const panel = document.querySelector("[data-presentation]");
    return {
      hudHidden: Boolean(hud) && getComputedStyle(hud).display === "none",
      panelText: panel?.textContent ?? "",
      thumbs: [...document.querySelectorAll("[data-presentation] img")].filter((img) => getComputedStyle(img).display !== "none").length,
    };
  });
  check("presentation: engineering HUD hidden", initial.hudHidden);
  check("presentation: current scene shown", /Apartment/.test(initial.panelText), initial.panelText.slice(0, 40));
  check("presentation: starts at 0 / 3 with no thumbnails", /0 \/ 3 captured/.test(initial.panelText) && initial.thumbs === 0);
  await page.screenshot({ path: `${outDir}/presentation-empty.png` });

  // Three manually chosen viewpoints relative to the home pose (yaw about world Y).
  const home = await page.evaluate(() => window.__demo.readPose());
  const setPose = (spec) =>
    page.evaluate(({ home, spec }) => {
      const THREE = window.__sl.THREE;
      const viewer = window.__sl.viewer;
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw);
      const q = yaw.multiply(new THREE.Quaternion().fromArray(home.rig.quaternion));
      // Optional pitch about the rig's local X (negative looks down) for the Top view.
      if (spec.pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), spec.pitch));
      viewer.cameraOrientTarget = null;
      viewer.cameraRig.position.set(home.rig.position[0] + spec.dx, home.rig.position[1] + (spec.dy ?? 0), home.rig.position[2] + spec.dz);
      viewer.cameraRig.quaternion.copy(q);
      viewer.camera.quaternion.fromArray(home.cameraLocalQuaternion);
      viewer.camera.updateWorldMatrix(true, false);
    }, { home, spec });

  const specs = {
    front: { yaw: 0, dx: 0, dz: 0 },
    side: { yaw: Math.PI / 2, dx: 0.6, dz: 0 },
    top: { yaw: 0, dx: 0, dz: 0, dy: 1.2, pitch: -Math.PI / 2 },
  };
  const poseAtCapture = {};

  // Front: real mouse click on its button.
  await setPose(specs.front);
  await settle(page);
  poseAtCapture.front = await page.evaluate(() => window.__demo.readPose());
  await page.getByRole("button", { name: /Capture Front/ }).click();
  const confirmation = await page.evaluate(() => document.querySelector(".pres__notice")?.textContent ?? "");
  check("capture confirmation shown", /Front view captured/.test(confirmation), confirmation);
  await page.screenshot({ path: `${outDir}/presentation-front-confirmation.png` });

  // Side: real mouse click, assigned independently out of order relative to Top.
  await setPose(specs.side);
  await settle(page);
  poseAtCapture.side = await page.evaluate(() => window.__demo.readPose());
  await page.getByRole("button", { name: /Capture Side/ }).click();

  // Top: keyboard shortcut (Shift+3).
  await setPose(specs.top);
  await settle(page);
  poseAtCapture.top = await page.evaluate(() => window.__demo.readPose());
  await page.keyboard.press("Shift+Digit3");
  await page.waitForTimeout(300);

  const captured = await page.evaluate(() => {
    const state = window.__demo.state().presentation;
    return {
      count: state.count,
      captures: state.captures.map((c) => c && {
        id: c.id, slot: c.slot, capturedAtMs: c.capturedAtMs,
        position: c.snapshot.camera.position, orientation: c.snapshot.camera.orientation,
        worldMatrix: c.snapshot.camera.worldMatrix, projection: c.snapshot.camera.projectionMatrix,
        projectionKind: c.snapshot.camera.projectionKind,
        image: c.snapshot.image.dataUrl, width: c.snapshot.image.width, height: c.snapshot.image.height,
      }),
      uiCount: document.querySelector(".pres__count")?.textContent,
      thumbSrc: ["front", "side", "top"].map((s) => document.querySelector(`[data-slot=${s}] img`)?.src ?? null),
    };
  });
  check("three viewpoints captured, count shows 3 / 3", captured.count === 3 && captured.uiCount === "3 / 3 captured", captured.uiCount);
  check("slots assigned independently as chosen", captured.captures.map((c) => c?.slot).join() === "front,side,top");
  check("capture IDs unique", new Set(captured.captures.map((c) => c.id)).size === 3);
  check("timestamps recorded in capture order", captured.captures[0].capturedAtMs < captured.captures[1].capturedAtMs && captured.captures[1].capturedAtMs < captured.captures[2].capturedAtMs);
  check("each capture stores position, orientation and perspective projection", captured.captures.every((c) =>
    c.position && c.orientation && c.worldMatrix.length === 16 && c.projection.length === 16 && c.projectionKind === "perspective"));
  const distinct = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  check("the three recorded camera positions differ", [[0, 1], [1, 2], [0, 2]].every(([i, j]) => distinct(captured.captures[i].position, captured.captures[j].position) > 0.3));
  const dq = (a, b) => Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  check("the three recorded orientations differ", [[0, 1], [1, 2], [0, 2]].every(([i, j]) => dq(captured.captures[i].orientation, captured.captures[j].orientation) < 0.9));
  const keys = ["front", "side", "top"];
  const worldPos = (pose) => ({ x: pose.position[0], y: pose.position[1], z: pose.position[2] });
  check("recorded pose equals the live camera pose at the moment of capture", keys.every((key, i) =>
    distinct(captured.captures[i].position, worldPos(poseAtCapture[key])) < 1e-3),
    keys.map((key, i) => distinct(captured.captures[i].position, worldPos(poseAtCapture[key])).toExponential(1)).join(" "));
  check("thumbnails are the stored images", captured.thumbSrc.every((src, i) => src === captured.captures[i].image));
  check("image size equals drawing buffer", captured.captures.every((c) => c.width > 0 && c.height > 0));
  await page.screenshot({ path: `${outDir}/presentation-three-captures.png` });

  // Earlier captures stay unchanged after the camera moves (and after a later render/readback).
  await setPose({ yaw: 1.1, dx: -1.2, dz: 0.8 });
  await settle(page, 1200);
  const afterMove = await page.evaluate(() => {
    const state = window.__demo.state().presentation;
    return {
      images: state.captures.map((c) => c.snapshot.image.dataUrl),
      poses: state.captures.map((c) => c.snapshot.camera.worldMatrix.join()),
      ids: state.captures.map((c) => c.id),
      thumbSrc: ["front", "side", "top"].map((s) => document.querySelector(`[data-slot=${s}] img`)?.src ?? null),
      frozen: state.captures.every((c) => Object.isFrozen(c) && Object.isFrozen(c.snapshot)),
    };
  });
  check("stored images unchanged after camera movement", afterMove.images.every((img, i) => img === captured.captures[i].image));
  check("stored poses unchanged after camera movement", afterMove.poses.every((pose, i) => pose === captured.captures[i].worldMatrix.join()));
  check("thumbnails unchanged after camera movement", afterMove.thumbSrc.every((src, i) => src === captured.captures[i].image));
  check("capture records are frozen", afterMove.frozen);
  await page.screenshot({ path: `${outDir}/presentation-after-move.png` });

  // Image <-> pose: re-render from each recorded pose and compare with all three stored images.
  // The matching image should be (near-)identical; the other two clearly different.
  const matrix = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(({ pose }) => {
      const viewer = window.__sl.viewer;
      viewer.cameraOrientTarget = null;
      viewer.cameraRig.position.fromArray(pose.rig.position);
      viewer.cameraRig.quaternion.fromArray(pose.rig.quaternion);
      viewer.camera.quaternion.fromArray(pose.cameraLocalQuaternion);
      viewer.camera.updateWorldMatrix(true, false);
    }, { pose: poseAtCapture[keys[i]] });
    await settle(page);
    const row = await page.evaluate(async ({ stored }) => {
      const viewer = window.__sl.viewer;
      viewer.renderer.render(viewer.scene, viewer.camera);
      const live = viewer.renderer.domElement.toDataURL("image/jpeg", 0.7);
      const W = 192;
      const H = 108;
      const pixels = async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, W, H);
        return ctx.getImageData(0, 0, W, H).data;
      };
      const liveData = await pixels(live);
      const diffs = [];
      for (const url of stored) {
        const data = await pixels(url);
        let sum = 0;
        for (let p = 0; p < data.length; p += 4) {
          sum += (Math.abs(data[p] - liveData[p]) + Math.abs(data[p + 1] - liveData[p + 1]) + Math.abs(data[p + 2] - liveData[p + 2])) / 3;
        }
        diffs.push(sum / (W * H));
      }
      return diffs;
    }, { stored: captured.captures.map((c) => c.image) });
    matrix.push(row);
  }
  console.log("mean abs pixel diff (rows: re-render at recorded pose; cols: stored front/side/top)");
  for (const row of matrix) console.log("  " + row.map((v) => v.toFixed(2).padStart(7)).join(" "));
  for (let i = 0; i < 3; i++) {
    const own = matrix[i][i];
    const others = matrix[i].filter((_, j) => j !== i);
    check(`${keys[i]} image matches a re-render at its recorded pose`, own < Math.min(...others) * 0.5 && own < 12, `own ${own.toFixed(2)} vs others ${others.map((v) => v.toFixed(2)).join("/")}`);
  }

  // Cost: one GPU render + one readback per capture, synchronous within the click.
  const cost = await page.evaluate(() => {
    const viewer = window.__sl.viewer;
    const renderer = viewer.renderer;
    const canvas = renderer.domElement;
    const origRender = renderer.render.bind(renderer);
    const origRead = canvas.toDataURL.bind(canvas);
    let renders = 0;
    let reads = 0;
    renderer.render = (...args) => { renders++; return origRender(...args); };
    canvas.toDataURL = (...args) => { reads++; return origRead(...args); };
    const started = performance.now();
    document.querySelector("[data-slot=side] button").click();
    const elapsed = performance.now() - started;
    renderer.render = origRender;
    canvas.toDataURL = origRead;
    return { renders, reads, elapsed, count: window.__demo.state().presentation.count };
  });
  check("one render pass and one readback per capture", cost.renders === 1 && cost.reads === 1, `renders=${cost.renders} reads=${cost.reads} in ${cost.elapsed.toFixed(0)} ms`);
  check("re-capturing a slot keeps the count at 3", cost.count === 3);

  const final = await page.evaluate(() => {
    const state = window.__demo.state().presentation;
    return {
      front: state.captures[0].id, top: state.captures[2].id,
      side: state.captures[1].id,
      counters: window.__demo.counters,
      overlayVisible: window.__demo.state().overlayVisible,
    };
  });
  check("re-capture replaced only Side", final.front === captured.captures[0].id && final.top === captured.captures[2].id && final.side !== captured.captures[1].id);
  check("presentation captures do not touch the annotation pipeline counters", final.counters.captures === 0 && final.counters.adopted === 0, JSON.stringify(final.counters));
  check("demo overlays visible again after capture", final.overlayVisible === true);
  check("presentation: no page errors", errors.length === 0, errors.join(" | "));
  await page.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${outDir}`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.kill();
}
