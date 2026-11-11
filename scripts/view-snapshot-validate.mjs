// Browser integration check for the synchronous ViewSnapshot frame capture.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.VIEW_SNAPSHOT_URL ?? "http://127.0.0.1:5211";
let server;
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.VIEW_SNAPSHOT_URL) {
    const vite = new URL("node_modules/vite/bin/vite.js", `file://${root}/`).pathname;
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5211", "--strictPort", "--no-open"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/`);
  }

  browser = await playwright.chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_EXE || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1.5 });
  page.on("pageerror", (error) => console.error(`[page error] ${error.message}`));
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__sl?.viewer?.captureViewSnapshot), null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const viewer = window.__sl.viewer;
    const renderer = viewer.renderer;
    const canvas = renderer.domElement;
    const originalRender = renderer.render.bind(renderer);
    const originalReadback = canvas.toDataURL.bind(canvas);
    let renderCount = 0;
    let readbackCount = 0;
    let renderElapsedMs = 0;
    let readbackElapsedMs = 0;
    let worldMatrixAtRender;
    let projectionAtRender;
    renderer.render = (scene, camera) => {
      renderCount += 1;
      const renderStartedAt = performance.now();
      const result = originalRender(scene, camera);
      renderElapsedMs += performance.now() - renderStartedAt;
      worldMatrixAtRender = Array.from(camera.matrixWorld.elements);
      projectionAtRender = Array.from(camera.projectionMatrix.elements);
      return result;
    };
    canvas.toDataURL = (...args) => {
      readbackCount += 1;
      const readbackStartedAt = performance.now();
      const result = originalReadback(...args);
      readbackElapsedMs += performance.now() - readbackStartedAt;
      return result;
    };

    const captureStartedAt = performance.now();
    const snapshot = viewer.captureViewSnapshot();
    const captureElapsedMs = performance.now() - captureStartedAt;
    const imageFromSameCanvasBuffer = originalReadback("image/jpeg", 0.7);
    const captured = {
      isPromise: Boolean(snapshot && typeof snapshot.then === "function"),
      renderCount,
      readbackCount,
      captureElapsedMs,
      renderElapsedMs,
      readbackElapsedMs,
      imageMatchesCanvas: snapshot.image.dataUrl === imageFromSameCanvasBuffer,
      imageWidth: snapshot.image.width,
      imageHeight: snapshot.image.height,
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
      cameraWorldMatchesRendered: JSON.stringify(snapshot.camera.worldMatrix) === JSON.stringify(worldMatrixAtRender),
      cameraProjectionMatchesRendered: JSON.stringify(snapshot.camera.projectionMatrix) === JSON.stringify(projectionAtRender),
      viewportWidth: snapshot.viewport.rect.width,
      viewportHeight: snapshot.viewport.rect.height,
      worldGeneration: snapshot.worldGeneration,
      frozen: Object.isFrozen(snapshot) && Object.isFrozen(snapshot.camera) && Object.isFrozen(snapshot.image),
      hasImage: snapshot.image.dataUrl.startsWith("data:image/jpeg;base64,"),
    };
    renderer.render = originalRender;
    canvas.toDataURL = originalReadback;
    return captured;
  });

  assert(!result.isPromise, "captureViewSnapshot must return synchronously");
  assert(result.renderCount === 1, `expected one render, got ${result.renderCount}`);
  assert(result.readbackCount === 1, `expected one capture readback, got ${result.readbackCount}`);
  assert(result.imageMatchesCanvas, "snapshot image differs from the canvas buffer immediately after capture");
  assert(result.cameraWorldMatchesRendered, "camera world matrix differs from the matrix used by render");
  assert(result.cameraProjectionMatchesRendered, "projection matrix differs from the matrix used by render");
  assert(result.imageWidth === result.bufferWidth && result.imageHeight === result.bufferHeight, "snapshot dimensions do not match drawing buffer");
  assert(result.viewportWidth > 0 && result.viewportHeight > 0, "captured viewport rectangle is invalid");
  assert(result.frozen && result.hasImage, "snapshot was not frozen or did not contain a JPEG image");
  console.log("PASS browser snapshot image and camera state belong to the same rendered frame");
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
