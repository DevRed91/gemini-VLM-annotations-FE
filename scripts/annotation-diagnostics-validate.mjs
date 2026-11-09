// Task 1 annotation-diagnostics validation (development-only tooling):
//  A) production-invariant source checks: DBSCAN params/selection, sanitize
//     thresholds, grid formula, dev-only construction, cleanup wiring;
//  B) production bundle exclusion: no diagnostics module code in dist;
//  C) browser validation against the real viewer via the DEV `window.__sl`
//     seam and its deterministic `inject()` path (no Gemini required):
//     full per-stage records, distinct cluster colours, 3D groups + overlay,
//     keyboard toggles, and cleanup on annotation removal / clear-all /
//     world reload.
// Writes docs/annotation-diagnostics-results.json.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.DIAGNOSTICS_URL ?? "http://127.0.0.1:5207";
const outputPath = path.join(root, "docs/annotation-diagnostics-results.json");
const sourceChecks = [
  ["script.ts", /const dbscanParams = \{ eps: 0\.3, minPts: nonLod \? 10 : 4 \};/, "DBSCAN params unchanged (eps 0.3, minPts 10 non-LOD / 4 LOD)"],
  ["script.ts", /Math\.min\(1, Math\.max\(0, value\)\)/, "sanitize clamps boxes to [0,1] as before"],
  ["script.ts", /< 0\.02/, "sanitize keeps the 0.02 minimum box size"],
  ["script.ts", /minGridSize = 6;[\s\S]*maxGridSize = nonLod \? 25 : 6;/, "sample-grid formula unchanged (6..25 non-LOD / 6 LOD)"],
  ["script.ts", /if \(import\.meta\.env\.DEV\) \{\s*\n\s*this\.annotationDiagnostics = new AnnotationDiagnostics\(this\.scene\);/, "diagnostics constructed only in DEV builds"],
  ["script.ts", /this\.annotationDiagnostics\?\.detachAnnotation\(annotation\.apartmentId\);/, "per-annotation diagnostic cleanup wired"],
  ["script.ts", /this\.annotationDiagnostics\?\.clear\(\);/, "world-clear diagnostic cleanup wired"],
  ["GeometricContextManager.ts", /current\.length > previous\.length \? current : previous/, "largest-cluster selection logic unchanged"],
  ["GeometricContextManager.ts", /if \(options\.onClusters\) \{/, "DBSCAN collector is opt-in and inert by default"],
];
const expectedTests = [
  "diagnostics seam is available and enabled in DEV",
  "deterministic inject records every pipeline stage",
  "cluster colours are pairwise distinct",
  "3D visualization groups and overlay exist after inject",
  "D and O keyboard toggles hide and show diagnostics",
  "removing an annotation removes its diagnostic visuals",
  "clear-all removes every diagnostic visual",
  "click-path request with a mocked Gemini response records the click and response stages",
  "reloading a world clears records and visuals",
  "production annotation behaviour is preserved",
];
let server;
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(url) {
  let lastError;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${lastError ?? "HTTP error"}`);
}

async function runSourceChecks() {
  const results = [];
  for (const [file, pattern, description] of sourceChecks) {
    const content = fs.readFileSync(path.join(root, "src", file === "script.ts" ? "script.ts" : `GeometricContextManager/GeometricContextManager.ts`), "utf8");
    const passed = pattern.test(content);
    results.push({ file, description, passed });
    console.log(`${passed ? "PASS" : "FAIL"} source check: ${description} (${file})`);
    if (!passed) throw new Error(`Source invariant failed: ${description} (${file})`);
  }
  return results;
}

async function runBundleCheck() {
  const vite = path.join(root, "node_modules/vite/bin/vite.js");
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [vite, "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
  });
  const bundles = fs.readdirSync(path.join(root, "dist/assets")).filter((name) => name.endsWith(".js"));
  const forbidden = ["DiagnosticOverlay", "buildDetectionGroup", "clusterColor(", "AnnotationDiagnostics(", "detachAnnotationGroup"];
  const hits = [];
  for (const bundle of bundles) {
    const content = fs.readFileSync(path.join(root, "dist/assets", bundle), "utf8");
    for (const marker of forbidden) {
      if (content.includes(marker)) hits.push(`${bundle}: ${marker}`);
    }
  }
  assert(hits.length === 0, `Diagnostics code leaked into the production bundle: ${hits.join(", ")}`);
  console.log("PASS production bundle contains no diagnostics module code");
  return { bundles: bundles.length, checkedMarkers: forbidden };
}

/**
 * The world is only ready for annotation once splat raycasts actually hit
 * (Spark resolves `splat.initialized` slightly before raycast data is usable;
 * users always click after the world has rendered, so tests wait for this).
 */
async function waitForRaycastReady(page) {
  await page.waitForFunction(
    () => {
      if (!window.__sl?.ready || !(window.__sl?.splat?.numSplats > 0)) return false;
      return window.__sl.viewer.getAnnotationPosition(0.5, 0.5) !== null;
    },
    null,
    { timeout: 240000 },
  );
}

function collectPage(page, consoleMessages, pageErrors) {
  page.on("console", (message) => {
    const entry = { page: page.url(), type: message.type(), text: message.text() };
    consoleMessages.push(entry);
    if (message.type() === "error") console.error(`[browser error] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[page error] ${error.message}`);
  });
}

async function diagnosticsState(page) {
  return page.evaluate(() => {
    const hook = window.__sl;
    const diagnostics = hook.diagnostics;
    return {
      ready: hook.ready,
      annotationCount: hook.annotationCount,
      registry: hook.registry,
      lastFit: hook.lastFit
        ? { method: hook.lastFit.method, points: hook.lastFit.points.length }
        : null,
      diagnostics: diagnostics
        ? {
            enabled: diagnostics.isEnabled,
            overlayVisible: diagnostics.isOverlayVisible,
            liveGroupCount: diagnostics.liveGroupCount,
            visualObjectCount: diagnostics.visualObjectCount,
            overlayHasContent: diagnostics.overlayHasContent,
            overlayCanvasId: diagnostics.overlayCanvasId,
            requestCount: diagnostics.list().length,
          }
        : null,
    };
  });
}

async function inject(page, label, box) {
  return page.evaluate(async ([name, detectionBox]) => {
    const fit = await window.__sl.inject(name, detectionBox);
    const diagnostics = window.__sl.diagnostics;
    return { fit, last: diagnostics.last() };
  }, [label, box]);
}

try {
  const sourceResults = await runSourceChecks();
  const bundleResult = await runBundleCheck();

  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    throw new Error("Playwright is required. Run npm install, or set PLAYWRIGHT_MODULE. " + String(error));
  }
  if (!process.env.DIAGNOSTICS_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5207", "--strictPort", "--no-open"], {
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
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const consoleMessages = [];
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  page.setDefaultTimeout(180000);
  collectPage(page, consoleMessages, pageErrors);
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await waitForRaycastReady(page);

  const tests = [];
  const evidence = { states: {} };
  const viewerTest = async (name, run) => {
    console.log(`RUN ${name}`);
    try {
      const details = await run();
      tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
      console.log(`PASS ${name}`);
    } catch (error) {
      tests.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) });
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const box = [0.1, 0.1, 0.5, 0.5];

  await viewerTest(expectedTests[0], async () => {
    const state = await diagnosticsState(page);
    assert(state.diagnostics, "window.__sl.diagnostics is missing in DEV");
    assert(state.diagnostics.enabled === true, "diagnostics must be enabled by default");
    assert(state.diagnostics.overlayVisible === true, "overlay must be visible by default");
    evidence.states.initial = state;
    return state;
  });

  await viewerTest(expectedTests[1], async () => {
    const { fit, last } = await inject(page, "checkered-rug", box);
    await page.waitForFunction(
      () => window.__sl.diagnostics.overlayHasContent === true,
      null,
      { timeout: 10000 },
    );
    assert(fit, "inject produced no cluster fit (lifting failed)");
    assert(last, "no diagnostic request recorded");
    assert(last.source === "inject", `unexpected source: ${last.source}`);
    assert(last.detections.length === 1, `expected one detection record, got ${last.detections.length}`);
    const record = last.detections[0];
    assert(record.label === "checkered-rug", `unexpected label: ${record.label}`);
    assert(JSON.stringify(record.rawBox) === JSON.stringify(box), `rawBox mismatch: ${JSON.stringify(record.rawBox)}`);
    assert(JSON.stringify(record.sanitizedBox) === JSON.stringify(box), `sanitizedBox mismatch: ${JSON.stringify(record.sanitizedBox)}`);
    const sampling = record.sampling;
    assert(sampling, "no sampling record");
    assert(sampling.gridSize >= 6, `unexpected grid size: ${sampling.gridSize}`);
    assert(sampling.cells.length === sampling.gridSize ** 2, "cell count must be gridSize^2");
    assert(sampling.hitCount + sampling.missCount === sampling.cells.length, "hit+miss must equal cells");
    assert(sampling.hitCount > 0, "expected at least one sample hit");
    assert(sampling.cells.every((cell) => cell.hit === false || (cell.position && cell.distance > 0)), "hit cells need a position and distance");
    const clustering = record.clustering;
    assert(clustering, "no clustering record");
    assert(clustering.eps === 0.3 && clustering.minPts === 10, "clustering params must mirror production");
    assert(clustering.sampledCount === sampling.hitCount, "sampledCount must equal hit count");
    assert(clustering.selectedClusterIndex !== null, "no cluster selected");
    const selected = clustering.clusters[clustering.selectedClusterIndex];
    assert(selected, "selected cluster missing");
    assert(selected.isSelected === true, "selected cluster not flagged");
    assert(clustering.clusters.every((cluster) => cluster.size <= selected.size), "selected cluster must be the largest");
    assert(record.measurement, "no measurement record");
    const anchor = record.anchor;
    assert(anchor && anchor.source === "cluster-centroid", `unexpected anchor source: ${anchor?.source}`);
    assert(
      Math.hypot(anchor.position.x - record.measurement.centroid.x,
        anchor.position.y - record.measurement.centroid.y,
        anchor.position.z - record.measurement.centroid.z) < 1e-6,
      "success-path anchor must be the measured centroid",
    );
    assert(record.annotationId && /^annotation-\d+$/.test(record.annotationId), `unexpected annotationId: ${record.annotationId}`);
    assert(record.failures.length === 0, `unexpected failures: ${JSON.stringify(record.failures)}`);
    evidence.states.inject = last;
    return {
      gridSize: sampling.gridSize,
      hitCount: sampling.hitCount,
      missCount: sampling.missCount,
      clusters: clustering.clusters.map((cluster) => cluster.size),
      noise: clustering.noiseIndices.length,
      anchor: anchor.position,
      annotationId: record.annotationId,
    };
  });

  await viewerTest(expectedTests[2], async () => {
    const colors = await page.evaluate(() => window.__sl.diagnostics.clusterColors(16));
    assert(Array.isArray(colors) && colors.length === 16, "palette probe returned wrong count");
    assert(new Set(colors).size === 16, "cluster colours must be pairwise distinct");
    const record = await page.evaluate(() => window.__sl.diagnostics.last().detections[0]);
    const recordColors = record.clustering.clusters.map((cluster) => cluster.colorHex);
    assert(new Set(recordColors).size === recordColors.length, "recorded cluster colours must be distinct");
    return { colors, recordColors };
  });

  await viewerTest(expectedTests[3], async () => {
    const state = await diagnosticsState(page);
    assert(state.diagnostics.liveGroupCount >= 1, "expected at least one live 3D group");
    assert(state.diagnostics.visualObjectCount > 0, "expected diagnostic objects in the scene");
    assert(state.diagnostics.overlayHasContent === true, "overlay must have painted content");
    const overlayPainted = await page.evaluate(() => {
      const canvas = document.getElementById(window.__sl.diagnostics.overlayCanvasId);
      if (!canvas || canvas.width === 0) return false;
      const context = canvas.getContext("2d");
      const sample = context.getImageData(0, 0, Math.min(canvas.width, 200), Math.min(canvas.height, 60)).data;
      return sample.some((value) => value !== 0);
    });
    assert(overlayPainted, "overlay canvas is blank");
    evidence.stateAfterInject = state;
    return state;
  });

  await viewerTest(expectedTests[4], async () => {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })));
    let state = await diagnosticsState(page);
    assert(state.diagnostics.enabled === false, "D must disable diagnostics");
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d" })));
    state = await diagnosticsState(page);
    assert(state.diagnostics.enabled === true, "D must re-enable diagnostics");
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o" })));
    state = await diagnosticsState(page);
    assert(state.diagnostics.enabled === true && state.diagnostics.overlayVisible === false, "O must toggle only the overlay");
    const overlayHidden = await page.evaluate(() =>
      document.getElementById(window.__sl.diagnostics.overlayCanvasId).style.display === "none");
    assert(overlayHidden, "overlay canvas must be hidden");
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "o" })));
    state = await diagnosticsState(page);
    assert(state.diagnostics.overlayVisible === true, "O must restore the overlay");
    // Input focus must not leak toggles into the chat box.
    const guard = await page.evaluate(() => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
      const enabled = window.__sl.diagnostics.isEnabled;
      input.remove();
      return enabled;
    });
    assert(guard === true, "typing d in an input must not toggle diagnostics");
    return state;
  });

  await viewerTest(expectedTests[5], async () => {
    const before = await diagnosticsState(page);
    assert(before.diagnostics.liveGroupCount >= 1, "expected a live group before removal");
    const removed = await page.evaluate(async () => {
      const viewer = window.__sl.viewer;
      const annotation = viewer.annotations[viewer.annotations.length - 1];
      if (!annotation) return { found: false };
      await viewer.removeAnnotation(annotation);
      return { found: true, id: annotation.apartmentId };
    });
    assert(removed.found, "no annotation to remove");
    const state = await diagnosticsState(page);
    assert(state.diagnostics.liveGroupCount === 0, `diagnostic groups must be gone, got ${state.diagnostics.liveGroupCount}`);
    assert(state.diagnostics.requestCount === 1, "records (data) must survive annotation removal");
    return { removed, state };
  });

  await viewerTest(expectedTests[6], async () => {
    await inject(page, "checkered-rug", box);
    await inject(page, "checkered-rug", box);
    let state = await diagnosticsState(page);
    assert(state.annotationCount === 2, `expected two annotations, got ${state.annotationCount}`);
    assert(state.diagnostics.liveGroupCount >= 2, "expected live groups for both injects");
    await page.evaluate(() => window.__sl.clearAll());
    await page.waitForFunction(
      () => window.__sl.annotationCount === 0 && window.__sl.diagnostics.liveGroupCount === 0,
      null,
      { timeout: 30000 },
    );
    state = await diagnosticsState(page);
    assert(state.diagnostics.liveGroupCount === 0, "clear-all must remove every diagnostic visual");
    return state;
  });

  await viewerTest(expectedTests[7], async () => {
    // Exercise the real click -> requestAnnotationFromGemini flow with a
    // fetch mock scoped to /annotate only (loads keep the real fetch).
    const canned = {
      objects: [
        { label: "click-rug", description: "A checkered rug.", box: [0.2, 0.4, 0.5, 0.6] },
      ],
    };
    await page.evaluate((body) => {
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : String(input?.url ?? "");
        if (url.includes("/annotate")) {
          return Promise.resolve(new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        }
        return originalFetch(input, init);
      };
      document.getElementById("annotationToolButton").click();
      const canvas = document.querySelector("canvas");
      canvas.dispatchEvent(new MouseEvent("click", { clientX: 320, clientY: 200, bubbles: true }));
    }, canned);
    await page.waitForFunction(
      () => window.__sl.annotationCount === 1,
      null,
      { timeout: 60000 },
    );
    const state = await diagnosticsState(page);
    const last = await page.evaluate(() => window.__sl.diagnostics.last());
    assert(last.source === "click", `expected click request source, got ${last.source}`);
    assert(last.click, "click-path request must record the click stage");
    assert(Math.abs(last.click.normalizedX - 0.5) < 1e-6, `unexpected click X: ${last.click.normalizedX}`);
    assert(last.click.hit && last.click.hit.distance > 0, "canvas-centre click must hit the splat");
    assert(
      typeof last.click.cameraPosition?.x === "number" &&
      typeof last.click.cameraQuaternion?.x === "number",
      "click record must freeze the camera pose",
    );
    assert(
      typeof last.snapshotDataUrl === "string" && last.snapshotDataUrl.startsWith("data:image/jpeg"),
      "captured snapshot must be retained on the request",
    );
    assert(
      last.response && last.response.objects?.[0]?.label === "click-rug",
      "raw Gemini response must be recorded verbatim",
    );
    const record = last.detections[0];
    assert(record.label === "click-rug", `unexpected detection label: ${record.label}`);
    assert(JSON.stringify(record.rawBox) === JSON.stringify([0.2, 0.4, 0.5, 0.6]), "raw detection box mismatch");
    assert(record.sampling && record.sampling.hitCount > 0, "detection sampling missing");
    assert(record.clustering && record.clustering.selectedClusterIndex !== null, "detection clustering missing");
    assert(record.anchor?.source === "cluster-centroid", "click-path anchor must be the cluster centroid");
    assert(record.annotationId && /^annotation-\d+$/.test(record.annotationId), `unexpected annotation id: ${record.annotationId}`);
    // Annotation IDs are monotonic across clear-all by design; the click-path
    // annotation must be exactly the one registered in the spatial registry.
    assert(state.registry.objects.some((object) => object.objectId === record.annotationId),
      "click-path annotation must be registered under its record's ID");
    assert(state.diagnostics.liveGroupCount >= 2, "click request group plus detection group must be live");
    evidence.states.clickPath = last;
    return {
      clickHit: last.click.hit,
      gridSize: record.sampling.gridSize,
      hitCount: record.sampling.hitCount,
      clusters: record.clustering.clusters.map((cluster) => cluster.size),
      anchor: record.anchor,
    };
  });

  await viewerTest(expectedTests[8], async () => {
    await page.evaluate(() => window.__sl.load("/Apartment.sog"));
    await waitForRaycastReady(page);
    const state = await diagnosticsState(page);
    assert(state.diagnostics.requestCount === 0, "world reload must clear all records");
    assert(state.diagnostics.liveGroupCount === 0, "world reload must clear all visuals");
    assert(state.diagnostics.overlayHasContent === false, "world reload must clear the overlay");
    return state;
  });

  await viewerTest(expectedTests[9], async () => {
    // Same-URL reload restores the persisted annotations from this session, so
    // compare against the post-reload baseline instead of absolute counts.
    const baseline = await diagnosticsState(page);
    const restored = baseline.annotationCount;
    const { fit, last } = await inject(page, "checkered-rug", box);
    await page.waitForFunction(
      () => window.__sl.diagnostics.overlayHasContent === true,
      null,
      { timeout: 10000 },
    );
    const state = await diagnosticsState(page);
    const record = last?.detections?.[0];
    if (!fit) {
      throw new Error(
        `inject did not lift: sampling=${JSON.stringify(record?.sampling && {
          gridSize: record.sampling.gridSize,
          hitCount: record.sampling.hitCount,
          missCount: record.sampling.missCount,
        })} failures=${JSON.stringify(record?.failures)}`,
      );
    }
    assert(fit.method === "pca" || fit.method === "aabb-fallback", `unexpected fit method: ${fit.method}`);
    assert(state.annotationCount === restored + 1, `expected ${restored + 1} annotations after inject, got ${state.annotationCount}`);
    const newId = record?.annotationId;
    assert(newId && state.registry.objects.some((object) => object.objectId === newId),
      `new annotation ${newId} must register in the spatial registry`);
    assert(state.diagnostics.enabled === true, "diagnostics stays enabled across worlds");
    evidence.states.final = state;
    return { restored, newId, method: fit.method, registrySize: state.registry.size };
  });

  const consoleErrors = consoleMessages.filter((message) => message.type === "error");
  const failed = tests.filter((entry) => !entry.passed);
  const result = {
    environment: {
      url: `${baseURL}/`,
      browser: "headless Chromium",
      angle: "SwiftShader",
      viewport: [640, 480],
    },
    sourceChecks: sourceResults,
    bundleCheck: bundleResult,
    tests,
    evidence,
    consoleMessages,
    consoleErrors,
    pageErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  for (const entry of tests) {
    console.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.error ? `\n${entry.error}` : ""}`);
  }
  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);

  if (failed.length || consoleErrors.length || pageErrors.length) {
    console.error(JSON.stringify({
      failedTests: failed.length,
      consoleErrors,
      pageErrors,
    }, null, 2));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
