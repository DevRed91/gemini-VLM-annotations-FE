// Phase 3 browser validation: deterministic multi-object fixtures and the real viewer.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.PHASE3_URL ?? "http://127.0.0.1:5200";
const repetitions = Number(process.env.PHASE3_REPETITIONS) || 20;
const fixtureUrl = `${baseURL}/phase3.html?repetitions=${repetitions}`;
const outputPath = path.join(root, "docs/phase3-results.json");
const expectedTests = [
  "OBB fitting produces normalized rigid transforms for basic, translated, and rotated points",
  "non-unit OBB quaternions are rejected at lifting boundary",
  "labels keep disjoint memberships and stable distinct colors",
  "latest label wins overlaps and clearing restores the underlying label",
  "label validation, deduplication, no-op suppression, and binary compatibility",
  "two disjoint objects render simultaneously and clear-one restores exact independent pixels",
  "overlap pixels follow update precedence and restore exactly",
  "label masks retain 4096-row addressing and shifted-ID negative controls",
  "coordinator updates only one object and never reuses IDs",
  "stale selections are ignored after clear-one, clear-all, and disposal",
  "hover, mask, and third-party effects compose with owned disposal",
  "two selections survive rigid splat motion and repeated lifecycle cleanup",
  "real Apartment.sog repeated selections meet measured resource and timing gates",
  "viewer injects two fixed real-scene detections with distinct visible index masks",
  "viewer clear-one restores the first object and hover preserves composition",
  "viewer reload clears selections, helpers, annotations, and modifiers",
  "viewer unsupported LOD source uses owned OBB fallback",
  "viewer stale world loads cannot replace the latest world",
];
let server;
let browser;

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
function assert(condition, message) {
  if (!condition) throw new Error(message);
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
async function shot(page) {
  const started = Date.now();
  console.log("  viewer capture: start");
  try {
    return await page.evaluate(async () => {
      const v = window.__sl.viewer;
      const scratch = document.createElement("canvas");
      scratch.width = v.renderer.domElement.width;
      scratch.height = v.renderer.domElement.height;
      const context = scratch.getContext("2d");
      const hasContent = () => {
        context.drawImage(v.renderer.domElement, 0, 0);
        const data = context.getImageData(0, 0, scratch.width, scratch.height).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return true;
        }
        return false;
      };
      let previous = null;
      for (let frame = 0; frame < 40; frame++) {
        await new Promise(requestAnimationFrame);
        v.renderer.render(v.scene, v.camera);
        v.renderer.getContext().finish();
        const current = window.__sl.capture();
        if (previous && current === previous && hasContent()) return current;
        previous = current;
      }
      throw new Error("Viewer did not produce non-black, pixel-stable output within forty frames");
    });
  } finally {
    console.log(`  viewer capture: ${Date.now() - started} ms`);
  }
}
async function diff(page, a, b) {
  return page.evaluate(async ([aUrl, bUrl]) => {
    const load = (source) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
    const [aImage, bImage] = await Promise.all([load(aUrl), load(bUrl)]);
    const read = (image) => {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const aPixels = read(aImage);
    const bPixels = read(bImage);
    let count = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < aPixels.length; i += 4) {
      if (aPixels[i] !== bPixels[i] || aPixels[i + 1] !== bPixels[i + 1] ||
          aPixels[i + 2] !== bPixels[i + 2]) {
        const pixel = i / 4;
        const x = pixel % aImage.width;
        const y = Math.floor(pixel / aImage.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count++;
      }
    }
    return { count, bbox: count ? [minX, minY, maxX, maxY] : null };
  }, [a, b]);
}
async function state(page) {
  return page.evaluate(() => {
    const hook = window.__sl;
    const viewer = hook.viewer;
    return {
      ready: hook.ready,
      mode: hook.mode,
      numSplats: hook.splat?.numSplats ?? 0,
      annotationCount: hook.annotationCount,
      modifiers: hook.splat?.objectModifiers?.length ?? 0,
      helpers: hook.splat?.children.filter((child) => child.type === "LineSegments").length ?? 0,
      selections: hook.selections.map((selection) => ({
        objectId: selection.objectId,
        label: selection.label,
        count: selection.selectedIds.length,
        color: selection.color,
        worldSize: selection.worldObb.size.toArray(),
      })),
      shaderErrors: hook.shaderErrors,
    };
  });
}
async function inject(page, label, box, expectedSelections) {
  const started = Date.now();
  console.log(`  viewer inject ${label}: start`);
  const fit = await page.evaluate(async ([name, detectionBox]) => {
    return window.__sl.inject(name, detectionBox);
  }, [label, box]);
  console.log(`  viewer inject ${label}: ${Date.now() - started} ms`);
  await page.waitForFunction(
    ({ selections, mode }) => window.__sl.selections.length === selections &&
      window.__sl.annotationCount === (mode === "index-mask" ? selections : 1),
    { selections: expectedSelections, mode: await page.evaluate(() => window.__sl.mode) },
    { timeout: 120000 },
  );
  return fit;
}

try {
  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    throw new Error("Playwright is required. Run npm install, or set PLAYWRIGHT_MODULE. " + String(error));
  }
  if (!process.env.PHASE3_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5200", "--strictPort", "--no-open"], {
      cwd: root,
      env: { ...process.env, VITE_ENABLE_GAUSSIAN_HIGHLIGHTING: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
    server.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));
    await waitForServer(`${baseURL}/phase3.html`);
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
  const skipFixtures = process.env.PHASE3_VIEWER_ONLY === "1";
  let fixtureReport = {
    startedAt: new Date().toISOString(),
    tests: [],
    performance: null,
    shaderErrors: [],
    finalGlError: 0,
  };
  if (!skipFixtures) {
    const fixturePage = await browser.newPage({ viewport: { width: 640, height: 480 } });
    collectPage(fixturePage, consoleMessages, pageErrors);
    await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
    await fixturePage.waitForFunction(() => window.__phase3?.ready === true, null, { timeout: 600000 });
    fixtureReport = await fixturePage.evaluate(() => window.__phase3.report);
    await fixturePage.close();
  }

  const viewerPage = await browser.newPage({ viewport: { width: 640, height: 480 } });
  viewerPage.setDefaultTimeout(180000);
  collectPage(viewerPage, consoleMessages, pageErrors);
  await viewerPage.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await viewerPage.waitForFunction(() => window.__sl?.ready && window.__sl.splat?.numSplats > 0,
    null, { timeout: 240000 });
  const viewerTests = [];
  const viewerEvidence = { detections: {}, states: {}, pixelDiffs: {} };
  const viewerTest = async (name, run) => {
    console.log(`RUN ${name}`);
    try {
      const details = await run();
      viewerTests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
      console.log(`PASS ${name}`);
    } catch (error) {
      viewerTests.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) });
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let baseline;
  let bOnly;
  let both;
  let firstSelection;
  let secondSelection;
  const firstBox = [0.1, 0.1, 0.5, 0.5];
  const secondBox = [0.4, 0.5, 0.8, 0.9];

  await viewerTest(expectedTests[13], async () => {
    baseline = await shot(viewerPage);
    await inject(viewerPage, "fixed-right", secondBox, 1);
    const rightState = await state(viewerPage);
    firstSelection = rightState.selections[0];
    assert(firstSelection?.count > 0, "First fixed detection produced no Gaussian indices");
    assert(firstSelection.count < rightState.numSplats * 0.75, "First detection selected most of the scene");
    bOnly = await shot(viewerPage);

    await inject(viewerPage, "fixed-left", firstBox, 2);
    const bothState = await state(viewerPage);
    secondSelection = bothState.selections.find((selection) => selection.objectId !== firstSelection.objectId);
    assert(secondSelection?.count > 0, "Second fixed detection produced no Gaussian indices");
    assert(secondSelection.count < bothState.numSplats * 0.75, "Second detection selected most of the scene");
    assert(firstSelection.objectId !== secondSelection.objectId, "Detections share an object ID");
    assert(JSON.stringify(firstSelection.color) !== JSON.stringify(secondSelection.color),
      "Detections share a label color");
    assert(bothState.modifiers === 2 && bothState.helpers === 2 && bothState.annotationCount === 2,
      `Unexpected viewer resources: ${JSON.stringify(bothState)}`);
    both = await shot(viewerPage);
    const rightDiff = await diff(viewerPage, bOnly, baseline);
    const leftDiff = await diff(viewerPage, both, bOnly);
    assert(rightDiff.count > 0 && leftDiff.count > 0, "One of the two viewer highlights is not visible");
    viewerEvidence.detections = { firstBox, secondBox, firstSelection, secondSelection };
    viewerEvidence.states.both = bothState;
    viewerEvidence.pixelDiffs.rightVsBaseline = rightDiff;
    viewerEvidence.pixelDiffs.bothVsRight = leftDiff;
    return { rightDiff, leftDiff, selections: bothState.selections };
  });

  await viewerTest(expectedTests[14], async () => {
    assert(secondSelection && firstSelection && bOnly && both, "Viewer two-selection fixture was not established");
    console.log("  viewer step: clear second selection");
    await viewerPage.evaluate((objectId) => window.__sl.clearOne(objectId), secondSelection.objectId);
    console.log("  viewer step: second selection cleared");
    await viewerPage.waitForFunction(() => window.__sl.selections.length === 1 && window.__sl.annotationCount === 1);
    console.log("  viewer step: capture clear-one reference");
    const restored = await shot(viewerPage);
    console.log("  viewer step: compare clear-one reference");
    const restoreDiff = await diff(viewerPage, restored, bOnly);
    assert(restoreDiff.count === 0, `Clear-one changed the remaining object by ${restoreDiff.count} pixels`);

    await viewerPage.evaluate(() => {
      const viewer = window.__sl.viewer;
      viewer.hoverTint.setHovered(viewer.annotations[0].worldObb);
    });
    console.log("  viewer step: capture hover");
    const hovered = await shot(viewerPage);
    const hoverDiff = await diff(viewerPage, hovered, restored);
    assert(hoverDiff.count > 0, "Viewer hover did not compose with the persistent selection");
    await viewerPage.evaluate(() => window.__sl.viewer.hoverTint.setHovered(null));
    const hoverCleared = await shot(viewerPage);
    const hoverClearDiff = await diff(viewerPage, hoverCleared, bOnly);
    assert(hoverClearDiff.count === 0, "Clearing hover did not restore persistent viewer pixels");
    viewerEvidence.pixelDiffs.clearOneVsIndependentReference = restoreDiff;
    viewerEvidence.pixelDiffs.hoverVsPersistent = hoverDiff;
    return { restoreDiff, hoverDiff, hoverClearDiff };
  });

  await viewerTest(expectedTests[15], async () => {
    const loaded = await viewerPage.evaluate(() => window.__sl.load("/Apartment.sog"));
    assert(loaded === true, "Static world reload failed");
    await viewerPage.waitForFunction(() => window.__sl.ready && window.__sl.mode === "index-mask");
    const reloadedState = await state(viewerPage);
    assert(reloadedState.selections.length === 0 && reloadedState.annotationCount === 0 &&
      reloadedState.helpers === 0 && reloadedState.modifiers === 2,
    `Reload leaked viewer state: ${JSON.stringify(reloadedState)}`);
    const reloaded = await shot(viewerPage);
    const reloadDiff = await diff(viewerPage, reloaded, baseline);
    assert(reloadDiff.count === 0, `Reload differed from baseline by ${reloadDiff.count} pixels`);
    viewerEvidence.states.reloaded = reloadedState;
    viewerEvidence.pixelDiffs.reloadVsBaseline = reloadDiff;
    return { state: reloadedState, reloadDiff };
  });

  await viewerTest(expectedTests[16], async () => {
    const loaded = await viewerPage.evaluate(() => window.__sl.load("/Apartment-lod.rad"));
    assert(loaded === true, "LOD world load failed");
    await viewerPage.waitForFunction(() => window.__sl.ready && window.__sl.mode === "obb-fallback");
    const lodBaseline = await shot(viewerPage);
    await inject(viewerPage, "lod-fallback", firstBox, 0);
    const fallbackState = await state(viewerPage);
    assert(fallbackState.selections.length === 0 && fallbackState.annotationCount === 1 &&
      fallbackState.helpers === 1 && fallbackState.modifiers === 2,
    `Unexpected LOD fallback resources: ${JSON.stringify(fallbackState)}`);
    const fallback = await shot(viewerPage);
    const fallbackDiff = await diff(viewerPage, fallback, lodBaseline);
    assert(fallbackDiff.count > 0, "LOD OBB fallback did not produce visible output");
    await viewerPage.evaluate(() => window.__sl.clearAll());
    const clearedState = await state(viewerPage);
    assert(clearedState.annotationCount === 0 && clearedState.helpers === 0 && clearedState.modifiers === 1,
      "LOD fallback cleanup left resources");
    const cleared = await shot(viewerPage);
    const clearDiff = await diff(viewerPage, cleared, lodBaseline);
    assert(clearDiff.count === 0, "LOD fallback clear-all differed from baseline");
    viewerEvidence.states.lodFallback = fallbackState;
    viewerEvidence.pixelDiffs.lodFallbackVsBaseline = fallbackDiff;
    return { fallbackState, fallbackDiff, clearDiff };
  });

  await viewerTest(expectedTests[17], async () => {
    const loadResults = await viewerPage.evaluate(async () => {
      const stale = window.__sl.load("/Apartment.sog");
      const latest = window.__sl.load("/Apartment-lod.rad");
      return Promise.all([stale, latest]);
    });
    await viewerPage.waitForFunction(() => window.__sl.ready && window.__sl.mode === "obb-fallback");
    const finalState = await state(viewerPage);
    assert(loadResults[0] === false && loadResults[1] === true,
      `Unexpected stale load results: ${JSON.stringify(loadResults)}`);
    assert(finalState.selections.length === 0 && finalState.annotationCount === 0 &&
      finalState.modifiers === 1 && finalState.shaderErrors.length === 0,
    `Stale load modified the active world: ${JSON.stringify(finalState)}`);
    viewerEvidence.states.afterStaleLoads = finalState;
    return { loadResults, finalState };
  });

  const viewerFinalGlError = await viewerPage.evaluate(() => window.__sl.glError());
  const viewerShaderErrors = await viewerPage.evaluate(() => window.__sl.shaderErrors);
  const tests = [...fixtureReport.tests, ...viewerTests];
  const names = tests.map((entry) => entry.name);
  const missingTests = expectedTests.filter((name) => !names.includes(name));
  const unexpectedTests = names.filter((name) => !expectedTests.includes(name));
  const duplicateTests = names.filter((name, index) => names.indexOf(name) !== index);
  const failed = tests.filter((entry) => !entry.passed);
  const consoleErrors = consoleMessages.filter((message) => message.type === "error");
  const result = {
    environment: {
      fixtureUrl,
      viewerUrl: `${baseURL}/`,
      browser: "headless Chromium",
      angle: "SwiftShader",
      fixtureViewport: [640, 480],
      viewerViewport: [640, 480],
    },
    startedAt: fixtureReport.startedAt,
    tests,
    expectedTests,
    missingTests,
    unexpectedTests,
    duplicateTests,
    performance: fixtureReport.performance,
    viewer: viewerEvidence,
    shaderErrors: [...fixtureReport.shaderErrors, ...viewerShaderErrors],
    finalGlError: fixtureReport.finalGlError,
    viewerFinalGlError,
    consoleMessages,
    pageErrors,
    consoleErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  for (const entry of fixtureReport.tests) {
    console.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.error ? `\n${entry.error}` : ""}`);
  }
  if (fixtureReport.performance) console.log(`Performance\n${JSON.stringify(fixtureReport.performance, null, 2)}`);
  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);
  if (failed.length || missingTests.length || unexpectedTests.length || duplicateTests.length ||
      result.shaderErrors.length || result.finalGlError !== 0 || viewerFinalGlError !== 0 ||
      consoleErrors.length || pageErrors.length || !result.performance ||
      result.performance.repetitions !== repetitions) {
    console.error(JSON.stringify({
      failedTests: failed.map((entry) => entry.name),
      missingTests,
      unexpectedTests,
      duplicateTests,
      shaderErrors: result.shaderErrors,
      finalGlError: result.finalGlError,
      viewerFinalGlError,
      consoleErrors,
      pageErrors,
      hasPerformance: Boolean(result.performance),
      expectedRepetitions: repetitions,
      actualRepetitions: result.performance?.repetitions ?? 0,
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
