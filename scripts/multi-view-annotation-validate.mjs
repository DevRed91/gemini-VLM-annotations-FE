// Metal-backed browser validation for multi-view detection -> GPU highlight + scene annotation.
// Run on macOS: node scripts/multi-view-annotation-validate.mjs
// Optional env: MULTIVIEW_URL (existing Vite server), CHROME_EXE, MULTIVIEW_OUT (default /tmp/multiview-annotation).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.MULTIVIEW_URL ?? "http://127.0.0.1:5214";
const outDir = process.env.MULTIVIEW_OUT ?? "/tmp/multiview-annotation";
mkdirSync(outDir, { recursive: true });
let server;
let browser;
const errors = [];

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${lastError ?? "HTTP error"}`);
}

async function settle(page, ms = 1800) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(ms);
}

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.MULTIVIEW_URL) {
    const vite = new URL("node_modules/vite/bin/vite.js", `file://${root}/`).pathname;
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5214", "--strictPort", "--no-open"], {
      cwd: root,
      env: { ...process.env, VITE_ENABLE_GAUSSIAN_HIGHLIGHTING: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/`);
  }

  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/detect-multiview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      objects: [{
        id: "validation-main-table",
        label: "Main table",
        description: "Validation detection for the captured table.",
        observations: ["front", "side", "top"].map((view) => ({
          view,
          visible: true,
          box: { xMin: 0.08, yMin: 0.08, xMax: 0.92, yMax: 0.92 },
        })),
      }],
    }),
  }));
  await page.goto(`${baseURL}/?demo=1&present=1&inference=off`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__demo && window.__sl?.viewer?.splatLoaded), null, { timeout: 120000 });
  await page.evaluate(() => window.__sl.load("/Apartment.sog"));
  await page.waitForFunction(() => window.__sl.viewer.currentWorldUrl?.endsWith("Apartment.sog"), null, { timeout: 120000 });
  await settle(page, 2500);

  const renderer = await page.evaluate(() => {
    const gl = window.__sl.viewer.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable";
  });
  assert.doesNotMatch(renderer, /SwiftShader/i, `expected Metal GPU, got ${renderer}`);
  console.log(`PASS  Metal-backed WebGL renderer (${renderer})`);

  const home = await page.evaluate(() => window.__demo.readPose());
  const pose = async (spec) => page.evaluate(({ home, spec }) => {
    const THREE = window.__sl.THREE;
    const viewer = window.__sl.viewer;
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw);
    const q = yaw.multiply(new THREE.Quaternion().fromArray(home.rig.quaternion));
    if (spec.pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), spec.pitch));
    viewer.cameraOrientTarget = null;
    viewer.cameraRig.position.set(home.rig.position[0] + spec.dx, home.rig.position[1] + (spec.dy ?? 0), home.rig.position[2] + spec.dz);
    viewer.cameraRig.quaternion.copy(q);
    viewer.camera.quaternion.fromArray(home.cameraLocalQuaternion);
    viewer.camera.updateWorldMatrix(true, false);
  }, { home, spec });

  const views = [
    ["front", { yaw: 0, dx: 0, dz: 0 }],
    ["side", { yaw: Math.PI / 2, dx: 0.6, dz: 0 }],
    ["top", { yaw: 0, dx: 0, dz: 0, dy: 1.2, pitch: -Math.PI / 2 }],
  ];
  for (const [slot, spec] of views) {
    await pose(spec);
    await settle(page, 900);
    await page.evaluate((view) => window.__demo.capturePresentationSlot(view), slot);
  }
  assert.equal(await page.evaluate(() => window.__demo.state().presentation.count), 3);
  console.log("PASS  captured three Apartment.sog viewpoints");

  await page.getByRole("button", { name: "Send to Gemini" }).click();
  await page.waitForFunction(() => document.querySelector(".pres__object") !== null, null, { timeout: 30000 });
  const card = page.locator(".pres__object").first();
  await card.click();
  await page.waitForFunction(() => document.querySelector('.pres__object[aria-pressed="true"]') !== null);
  await page.getByRole("button", { name: "Continue with Selected Object" }).click();
  await page.waitForFunction(() => document.querySelector(".annotation-container .annotation-pin") !== null, null, { timeout: 120000 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".pres__review")).display === "none", null, { timeout: 30000 });

  const placed = await page.evaluate(() => {
    const viewer = window.__sl.viewer;
    const annotation = viewer.annotations.find((item) => item.sourceObjectId === "validation-main-table");
    const highlighter = viewer.objectHighlighter;
    const selection = highlighter?.getIndexSelection("multi-view:validation-main-table");
    return {
      annotationCount: viewer.annotations.filter((item) => item.sourceObjectId === "validation-main-table").length,
      label: annotation?.element.querySelector(".annotation-label")?.textContent,
      hasObb: Boolean(annotation?.worldObb),
      labelId: selection?.labelId,
      selectedIndices: selection?.selectedIds.length ?? 0,
      selectedCount: highlighter?.maskSnapshot().selectedCount ?? 0,
      format: highlighter?.mask.texture.internalFormat,
      textureType: highlighter?.mask.texture.type,
      reviewClosed: getComputedStyle(document.querySelector(".pres__review")).display === "none",
      notice: document.querySelector(".pres__notice")?.textContent,
    };
  });
  assert.equal(placed.annotationCount, 1, "one annotation should be stored for the detected object");
  assert.equal(placed.label, "Main table");
  assert.ok(placed.hasObb, "annotation should carry the fitted OBB");
  assert.ok(placed.selectedIndices > 0, "index selection should include lifted Gaussians");
  assert.ok(placed.selectedCount > 0, "R8UI mask should contain selected Gaussian labels");
  assert.equal(placed.format, "R8UI");
  assert.equal(placed.reviewClosed, true);
  assert.match(placed.notice, /Annotation placed: Main table/);
  console.log("PASS  multi-view result creates one visible annotation and a non-empty R8UI highlight", placed);

  // Reconfirming the same Gemini identity replaces its tag and keeps the same GPU label.
  await page.getByRole("button", { name: "Review detections" }).click();
  await page.locator(".pres__object").first().click();
  await page.getByRole("button", { name: "Continue with Selected Object" }).click();
  await page.waitForFunction(() => document.querySelector(".pres__review").style.display === "none", null, { timeout: 120000 });
  const replaced = await page.evaluate(() => {
    const viewer = window.__sl.viewer;
    return {
      count: viewer.annotations.filter((item) => item.sourceObjectId === "validation-main-table").length,
      labelId: viewer.objectHighlighter.getIndexSelection("multi-view:validation-main-table")?.labelId,
    };
  });
  assert.equal(replaced.count, 1, "reconfirming must not stack scene tags");
  assert.equal(replaced.labelId, placed.labelId, "the stable object key must reuse its GPU mask label");
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  console.log("PASS  same-object confirmation replaces the previous tag without page errors");
  await page.screenshot({ path: `${outDir}/multi-view-annotation.png` });
} finally {
  await browser?.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
}
