// Phase 3 viewer-selection validation against the real Apartment.sog viewer.
// Gaussian highlighting is intentionally left disabled: selection must work
// through annotation pins, labels, cards, and existing OBB wireframes only.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const strictAssert = require("node:assert/strict");
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.VIEWER_SELECTION_URL ?? "http://127.0.0.1:5205";
const outputPath = path.join(
  root,
  "docs/chat-object-search-phase-3-viewer-selection-results.json",
);
const expectedTests = [
  "annotated sofa has pin, label, card, and OBB helper",
  "searching sofa returns a selectable chat result",
  "individual chat result selects only annotation-1",
  "select all emphasizes every matching sofa annotation",
  "clear selection restores the original annotation visuals",
  "deleting a selected annotation removes its selection",
  "clear-all annotations removes every chat selection",
  "reloading the world clears old selection and visual state",
  "pin-only annotations emphasize without requiring an OBB",
  "new searches explicitly clear previous selection",
  "selection works with Gaussian highlighting disabled",
  "selection updates scale with annotations rather than Gaussian splats",
];

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
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

let server;
let browser;

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.VIEWER_SELECTION_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [
      vite, "--host", "127.0.0.1", "--port", "5205", "--strictPort", "--no-open",
    ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(240000);
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    const entry = { type: message.type(), text: message.text() };
    consoleMessages.push(entry);
    if (message.type() === "error") console.error(`[browser error] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(`[page error] ${error.message}`);
  });

  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__sl?.ready === true && window.__sl.splat?.numSplats > 0,
    null,
    { timeout: 240000 },
  );

  const tests = [];
  const evidence = { states: {}, timings: {} };
  const viewerTest = async (name, run) => {
    console.log(`RUN ${name}`);
    const started = Date.now();
    try {
      const details = await run();
      const elapsedMs = Date.now() - started;
      evidence.timings[name] = elapsedMs;
      tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
      console.log(`PASS ${name} (${elapsedMs} ms)`);
    } catch (error) {
      const elapsedMs = Date.now() - started;
      evidence.timings[name] = elapsedMs;
      tests.push({
        name,
        passed: false,
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const annotationState = (annotationIds) => page.evaluate((ids) => {
    const viewer = window.__sl.viewer;
    const selected = new Set(window.__sl.chatSelection);
    return ids.map((id) => {
      const annotation = viewer.annotations.find((entry) => entry.apartmentId === id);
      const container = annotation?.element;
      const pin = container?.querySelector(".annotation-pin");
      const label = container?.querySelector(".annotation-label");
      const card = container?.querySelector(".annotation-card");
      const material = annotation?.helper?.material;
      return {
        id,
        exists: Boolean(annotation),
        selected: selected.has(id),
        containerSelected: container?.classList.contains("annotation-container--chat-selected") ?? false,
        pinBackground: pin ? getComputedStyle(pin).backgroundColor : null,
        pinBoxShadow: pin ? getComputedStyle(pin).boxShadow : null,
        pinTransform: pin ? getComputedStyle(pin).transform : null,
        labelBorder: label ? getComputedStyle(label).borderColor : null,
        cardExists: Boolean(card),
        hasHelper: Boolean(annotation?.helper),
        helperColor: material?.color?.getHexString?.() ?? null,
        helperBaseColor: annotation?.helperBaseColor?.getHexString?.() ?? null,
      };
    });
  }, annotationIds);

  const currentIds = () => page.evaluate(() =>
    window.__sl.viewer.annotations.map((annotation) => annotation.apartmentId));
  const openPanel = async () => {
    const panel = page.locator(".spatial-chat");
    if (!(await panel.isVisible())) await page.locator(".spatial-search-toggle").click();
    await panel.waitFor();
  };
  const submitAndWait = async (query, expectedText) => {
    await page.locator("#spatial-chat-input").fill(query);
    await page.locator("#spatial-chat-input").press("Enter");
    await page.waitForFunction((expected) => {
      const messages = document.querySelectorAll(
        ".spatial-chat__message--assistant .spatial-chat__message-text",
      );
      return messages.item(messages.length - 1)?.textContent === expected;
    }, expectedText);
  };

  await viewerTest(expectedTests[0], async () => {
    assert(await page.evaluate(() => window.__sl.mode) === "obb-fallback",
      "Gaussian highlighting was unexpectedly enabled");
    await page.evaluate(() => window.__sl.inject("sofa", [0.1, 0.1, 0.5, 0.5]));
    await page.waitForFunction(() => window.__sl.annotationCount === 1);
    const [annotation] = await annotationState(["annotation-1"]);
    assert(annotation.exists && annotation.cardExists && annotation.hasHelper,
      `Sofa annotation resources are incomplete: ${JSON.stringify(annotation)}`);
    evidence.states.sofa = annotation;
    return annotation;
  });

  await viewerTest(expectedTests[1], async () => {
    await openPanel();
    await submitAndWait("sofa", "Found 1 matching annotation.");
    const latest = page.locator(".spatial-chat__message--assistant").last();
    strictAssert.equal(await latest.locator(".spatial-chat__result-label").textContent(), "sofa");
    strictAssert.equal(await latest.locator("code").textContent(), "annotation-1");
    strictAssert.equal(await latest.locator(".spatial-chat__select-result").count(), 1);
    strictAssert.equal(await latest.locator(".spatial-chat__select-all").count(), 1);
    return { text: await latest.locator(".spatial-chat__message-text").textContent() };
  });

  await viewerTest(expectedTests[2], async () => {
    const before = await annotationState(["annotation-1"]);
    await page.locator(".spatial-chat__select-result").last().click();
    await page.waitForFunction(() =>
      window.__sl.chatSelection.length === 1 && window.__sl.chatSelection[0] === "annotation-1");
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector(".annotation-container--chat-selected .annotation-pin")).backgroundColor ===
      "rgb(56, 189, 248)");
    const after = await annotationState(["annotation-1"]);
    assert(after[0].selected && after[0].containerSelected,
      `Individual selection state is incorrect: ${JSON.stringify(after[0])}`);
    assert(after[0].pinBackground !== before[0].pinBackground,
      "Selected pin did not change background color");
    assert(after[0].helperColor === "38bdf8",
      `Selected OBB color is incorrect: ${after[0].helperColor}`);
    evidence.states.individual = { before: before[0], after: after[0] };
    return after[0];
  });

  await viewerTest(expectedTests[3], async () => {
    await page.evaluate(() => window.__sl.inject("sofa", [0.4, 0.5, 0.8, 0.9]));
    await page.waitForFunction(() => window.__sl.annotationCount === 2);
    await submitAndWait("find all sofas", "Found 2 matching annotations.");
    await page.locator(".spatial-chat__select-all").last().click();
    await page.waitForFunction(() => window.__sl.chatSelection.length === 2);
    const states = await annotationState(["annotation-1", "annotation-2"]);
    assert(states.every((annotation) => annotation.selected && annotation.containerSelected),
      `Not every sofa was selected: ${JSON.stringify(states)}`);
    assert(states.every((annotation) => annotation.helperColor === "38bdf8"),
      `OBB selection color is inconsistent: ${JSON.stringify(states)}`);
    evidence.states.selectAll = states;
    return states;
  });

  await viewerTest(expectedTests[11], async () => {
    const ids = await currentIds();
    const timing = await page.evaluate((annotationIds) => {
      const viewer = window.__sl.viewer;
      const start = performance.now();
      const repetitions = 1000;
      for (let index = 0; index < repetitions; index++) {
        viewer.setChatSelection(index % 2 === 0 ? annotationIds : []);
      }
      const durationMs = performance.now() - start;
      return {
        repetitions,
        annotationCount: viewer.annotations.length,
        numSplats: window.__sl.splat.numSplats,
        durationMs,
        perOperationMs: durationMs / repetitions,
      };
    }, ids);
    assert(timing.annotationCount === 2, "Performance fixture lost an annotation");
    assert(timing.perOperationMs < 1,
      `Selection updates were unexpectedly slow: ${JSON.stringify(timing)}`);
    evidence.performance = timing;
    return timing;
  });

  await viewerTest(expectedTests[4], async () => {
    const before = await annotationState(["annotation-1", "annotation-2"]);
    await page.locator(".spatial-chat__clear-selection").last().click();
    await page.waitForFunction(() => window.__sl.chatSelection.length === 0);
    const after = await annotationState(["annotation-1", "annotation-2"]);
    assert(after.every((annotation) => !annotation.selected && !annotation.containerSelected),
      `Clear did not remove every visual state: ${JSON.stringify(after)}`);
    assert(after[0].helperColor === before[0].helperBaseColor &&
      after[1].helperColor === before[1].helperBaseColor,
      `Clear did not restore helper colors: ${JSON.stringify(after)}`);
    evidence.states.afterClear = after;
    return { before, after };
  });

  await viewerTest(expectedTests[5], async () => {
    await page.locator(".spatial-chat__select-result").last().click();
    await page.waitForFunction(() => window.__sl.chatSelection.length === 1);
    const selectedId = await page.evaluate(() => window.__sl.chatSelection[0]);
    await page.evaluate((id) => {
      const viewer = window.__sl.viewer;
      return viewer.removeAnnotation(
        viewer.annotations.find((annotation) => annotation.apartmentId === id),
      );
    }, selectedId);
    await page.waitForFunction(() => window.__sl.chatSelection.length === 0);
    const ids = await currentIds();
    assert(!ids.includes(selectedId), "Deleted annotation visual remains");
    evidence.states.afterDelete = { deletedId: selectedId, remainingIds: ids };
    return { deletedId: selectedId, remainingIds: ids };
  });

  await viewerTest(expectedTests[6], async () => {
    const remainingId = (await currentIds())[0];
    await page.evaluate((id) => window.__sl.viewer.setChatSelection([id]), remainingId);
    await page.waitForFunction((id) => window.__sl.chatSelection[0] === id, remainingId);
    await page.evaluate(() => window.__sl.clearAll());
    await page.waitForFunction(() => window.__sl.annotationCount === 0);
    assert(await page.evaluate(() => window.__sl.chatSelection.length === 0),
      "Clear-all left a chat selection");
    evidence.states.afterClearAll = { remainingIds: await currentIds() };
    return evidence.states.afterClearAll;
  });

  await viewerTest(expectedTests[7], async () => {
    await page.evaluate(() => window.__sl.inject("sofa", [0.1, 0.1, 0.5, 0.5]));
    await page.waitForFunction(() => window.__sl.annotationCount === 2);
    const id = (await currentIds()).at(-1);
    await page.evaluate((annotationId) => window.__sl.viewer.setChatSelection([annotationId]), id);
    await page.waitForFunction((annotationId) =>
      window.__sl.chatSelection[0] === annotationId, id);
    const before = await annotationState([id]);
    assert(before[0].containerSelected, "Reload fixture was not selected");
    await page.evaluate(() => window.__sl.load("/Apartment.sog"));
    await page.waitForFunction(() =>
      window.__sl.ready === true && window.__sl.annotationCount === 1);
    const afterIds = await currentIds();
    assert(afterIds.length === 1, `Reload did not restore persisted annotation: ${JSON.stringify(afterIds)}`);
    assert(await page.evaluate(() => window.__sl.chatSelection.length === 0),
      "Reload left a stale chat selection");
    const [reloadedAnnotation] = await annotationState(afterIds);
    assert(!reloadedAnnotation.containerSelected && !reloadedAnnotation.selected,
      `Reload left stale selection visuals: ${JSON.stringify(reloadedAnnotation)}`);
    evidence.states.afterWorldReload = { before: before[0], ids: afterIds };
    return evidence.states.afterWorldReload;
  });

  await viewerTest(expectedTests[8], async () => {
    await page.evaluate(() => {
      const hook = window.__sl;
      hook.viewer.createAnnotationElement(
        new hook.THREE.Vector3(0.2, 0.4, 0.2),
        "sofa",
        { description: "pin-only selection probe" },
      );
    });
    await page.waitForFunction(() => window.__sl.annotationCount === 2);
    const id = (await currentIds()).at(-1);
    await page.evaluate((annotationId) => window.__sl.viewer.setChatSelection([annotationId]), id);
    await page.waitForFunction((annotationId) =>
      window.__sl.chatSelection[0] === annotationId, id);
    await page.waitForFunction((annotationId) => {
      const container = window.__sl.viewer.annotations
        .find((annotation) => annotation.apartmentId === annotationId)?.element;
      return container?.classList.contains("annotation-container--chat-selected") &&
        getComputedStyle(container.querySelector(".annotation-pin")).backgroundColor ===
        "rgb(56, 189, 248)";
    }, id);
    const [annotation] = await annotationState([id]);
    assert(annotation.containerSelected && !annotation.hasHelper,
      `Pin-only selection state is invalid: ${JSON.stringify(annotation)}`);
    assert(annotation.pinBackground === "rgb(56, 189, 248)",
      `Pin-only pin was not emphasized: ${annotation.pinBackground}`);
    evidence.states.pinOnly = annotation;
    return annotation;
  });

  await viewerTest(expectedTests[9], async () => {
    assert(await page.evaluate(() => window.__sl.chatSelection.length === 1),
      "New-search fixture did not have a previous selection");
    await submitAndWait("chair", "No matching annotated objects found.");
    await page.waitForFunction(() => window.__sl.chatSelection.length === 0);
    assert(await page.evaluate(() => window.__sl.chatSelection.length === 0),
      "A new search left a stale selection");
    evidence.states.afterNewSearch = await page.evaluate(() => window.__sl.chatSelection);
    return evidence.states.afterNewSearch;
  });

  await viewerTest(expectedTests[10], async () => {
    const state = await page.evaluate(() => ({
      mode: window.__sl.mode,
      gaussianSelections: window.__sl.selections.length,
      shaderErrors: window.__sl.shaderErrors,
      glError: window.__sl.glError(),
      modifierCount: window.__sl.splat?.objectModifiers?.length ?? 0,
    }));
    assert(state.mode === "obb-fallback", `Gaussian mode unexpectedly enabled: ${state.mode}`);
    assert(state.gaussianSelections === 0, "Chat selection created Gaussian selections");
    assert(state.shaderErrors.length === 0, `Shader errors: ${JSON.stringify(state.shaderErrors)}`);
    assert(state.glError === 0, `WebGL error: ${state.glError}`);
    evidence.states.gaussianDisabled = state;
    return state;
  });

  const names = tests.map((entry) => entry.name);
  const missingTests = expectedTests.filter((name) => !names.includes(name));
  const unexpectedTests = names.filter((name) => !expectedTests.includes(name));
  const duplicateTests = names.filter((name, index) => names.indexOf(name) !== index);
  const failed = tests.filter((entry) => !entry.passed);
  const consoleErrors = consoleMessages.filter((message) => message.type === "error");
  const shaderErrors = await page.evaluate(() => window.__sl.shaderErrors);
  const finalGlError = await page.evaluate(() => window.__sl.glError());
  const result = {
    environment: {
      viewerUrl: `${baseURL}/`,
      world: "/Apartment.sog",
      browser: "headless Chromium",
      angle: "SwiftShader",
      viewport: [1280, 800],
      gaussianHighlighting: "disabled",
    },
    startedAt: new Date().toISOString(),
    tests,
    expectedTests,
    missingTests,
    unexpectedTests,
    duplicateTests,
    viewer: evidence,
    performance: evidence.performance,
    shaderErrors,
    finalGlError,
    consoleMessages,
    pageErrors,
    consoleErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Results written to ${path.relative(root, outputPath)}`);

  if (failed.length || missingTests.length || unexpectedTests.length || duplicateTests.length ||
      shaderErrors.length || finalGlError !== 0 || consoleErrors.length || pageErrors.length ||
      !result.performance) {
    console.error(JSON.stringify({
      failedTests: failed.map((entry) => entry.name),
      missingTests,
      unexpectedTests,
      duplicateTests,
      shaderErrors,
      finalGlError,
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
