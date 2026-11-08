// Object-search track, Phase 0 validation: every viewer annotation registers
// into the per-world SpatialObjectRegistry, removals unregister, and a world
// reload installs a fresh empty registry. No fixture page: runs against the
// real viewer via the DEV-only `window.__sl` seam (Gaussian highlighting is
// deliberately left off — registration is independent of the highlighter).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.REGISTRY_URL ?? "http://127.0.0.1:5201";
const outputPath = path.join(root, "docs/chat-object-search-phase-0-results.json");
const expectedTests = [
  "per-world registry is created on load and starts empty",
  "a created annotation registers one spatial object under its canonical ID",
  "the same object annotated twice yields distinct spatial objects",
  "removing an annotation unregisters exactly its spatial object",
  "clear-all drops every annotation and empties the retained registry",
  "reloading a world installs a fresh empty registry with monotonic IDs",
  "pin-only annotations register a zero-size point OBB",
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
async function registryState(page) {
  return page.evaluate(() => {
    const hook = window.__sl;
    return {
      ready: hook.ready,
      numSplats: hook.splat?.numSplats ?? 0,
      annotationCount: hook.annotationCount,
      helpers: hook.splat?.children.filter((child) => child.type === "LineSegments").length ?? 0,
      registry: hook.registry,
      shaderErrors: hook.shaderErrors,
    };
  });
}
async function inject(page, label, box) {
  return page.evaluate(async ([name, detectionBox]) => {
    await window.__sl.inject(name, detectionBox);
    return window.__sl.registry;
  }, [label, box]);
}
function finitePositiveObb(snapshot) {
  // worldObb serializes across page.evaluate as { position: {x, y, z}, size: {x, y, z}, ... }.
  const size = snapshot?.worldObb?.size;
  return size && [size.x, size.y, size.z].every((value) => Number.isFinite(value) && value > 0);
}
async function waitRegistrySize(page, size, timeout = 30000) {
  await page.waitForFunction(
    (expected) => window.__sl.registry?.size === expected,
    size,
    { timeout },
  );
}

try {
  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    throw new Error("Playwright is required. Run npm install, or set PLAYWRIGHT_MODULE. " + String(error));
  }
  if (!process.env.REGISTRY_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5201", "--strictPort", "--no-open"], {
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
  await page.waitForFunction(
    () => window.__sl?.ready && window.__sl?.splat?.numSplats > 0,
    null,
    { timeout: 240000 },
  );

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
  const boxA = [0.1, 0.1, 0.5, 0.5];

  await viewerTest(expectedTests[0], async () => {
    const state = await registryState(page);
    assert(state.registry, "No registry installed after a successful world load");
    assert(state.registry.size === 0 && state.registry.objects.length === 0,
      `Registry is not empty on first load: ${JSON.stringify(state.registry)}`);
    assert(state.annotationCount === 0, `Unexpected annotations on first load: ${state.annotationCount}`);
    evidence.states.initial = state;
    return state;
  });

  await viewerTest(expectedTests[1], async () => {
    const registry = await inject(page, "fixed-sofa", boxA);
    await waitRegistrySize(page, 1);
    const state = await registryState(page);
    assert(state.registry.objects.length === 1, "Registry did not hold exactly one object");
    const [object] = state.registry.objects;
    assert(object.objectId === "annotation-1", `Unexpected objectId: ${object.objectId}`);
    assert(object.semanticLabel === "fixed-sofa", `Unexpected semanticLabel: ${object.semanticLabel}`);
    assert(finitePositiveObb(object), `Cluster OBB is not a finite positive-size OBB: ${JSON.stringify(object.worldObb)}`);
    assert(object.attributes?.obb === "cluster", `Unexpected obb attribute: ${object.attributes?.obb}`);
    assert(object.attributes?.description === "test", `Unexpected description attribute: ${JSON.stringify(object.attributes)}`);
    assert(state.annotationCount === 1 && state.helpers >= 1,
      `Annotation or helper missing: ${JSON.stringify(state)}`);
    evidence.states.firstAnnotation = state;
    return { object, state };
  });

  await viewerTest(expectedTests[2], async () => {
    await inject(page, "fixed-sofa", boxA);
    await waitRegistrySize(page, 2);
    const state = await registryState(page);
    const ids = state.registry.objects.map((object) => object.objectId);
    assert(JSON.stringify(ids) === JSON.stringify(["annotation-1", "annotation-2"]),
      `Duplicate annotation did not register as separate objects: ${JSON.stringify(ids)}`);
    const labels = state.registry.objects.map((object) => object.semanticLabel);
    assert(labels[0] === labels[1], `Duplicate annotation changed the label: ${JSON.stringify(labels)}`);
    assert(state.annotationCount === 2, "Second annotation did not appear as a DOM annotation");
    evidence.states.duplicate = state;
    return { ids, state };
  });

  await viewerTest(expectedTests[3], async () => {
    const removed = await page.evaluate(() => {
      const viewer = window.__sl.viewer;
      const annotation = viewer.annotations.find((item) => item.apartmentId === "annotation-2");
      if (!annotation) return { found: false };
      return viewer.removeAnnotation(annotation).then(() => ({ found: true }));
    });
    const state = await registryState(page);
    assert(removed.found, "Annotation-2 was not found on the viewer");
    assert(state.registry.size === 1 && state.registry.objects[0].objectId === "annotation-1",
      `Registry after removal: ${JSON.stringify(state.registry)}`);
    assert(state.annotationCount === 1, "Removal left an annotation visual behind");
    evidence.states.afterRemoval = state;
    return { removed, state };
  });

  await viewerTest(expectedTests[4], async () => {
    await page.evaluate(() => window.__sl.clearAll());
    await page.waitForFunction(() => window.__sl.annotationCount === 0);
    const state = await registryState(page);
    assert(state.registry === null || state.registry.size === 0,
      `Clear-all emptied the annotations but not the registry: ${JSON.stringify(state.registry)}`);
    assert(state.registry !== null, "Clear-all must retain the per-world registry instance");
    evidence.states.afterClearAll = state;
    return state;
  });

  await viewerTest(expectedTests[5], async () => {
    const loaded = await page.evaluate(() => window.__sl.load("/Apartment-lod.rad"));
    assert(loaded === true, "LOD world load failed");
    await page.waitForFunction(() => window.__sl.ready && window.__sl.splat?.numSplats > 0);
    await waitRegistrySize(page, 0);
    await page.evaluate(() => window.__sl.inject("fixed-lamp", [0.1, 0.1, 0.5, 0.5]));
    await waitRegistrySize(page, 1);
    const state = await registryState(page);
    const [object] = state.registry.objects;
    assert(object.objectId === "annotation-3",
      `IDs are not monotonic across worlds: ${object.objectId}`);
    assert(object.semanticLabel === "fixed-lamp", `Unexpected label after reload: ${object.semanticLabel}`);
    assert(!state.registry.objects.some((entry) => entry.objectId === "annotation-1"),
      "Fresh registry remembered a previous world's object ID");
    evidence.states.afterReload = state;
    return { state };
  });

  await viewerTest(expectedTests[6], async () => {
    await page.evaluate(() => {
      const hook = window.__sl;
      const position = new hook.THREE.Vector3(0.2, 0.4, 0.2);
      hook.viewer.createAnnotationElement(position, "point-probe", { description: "point" });
    });
    await waitRegistrySize(page, 2);
    const state = await registryState(page);
    const pointObject = state.registry.objects.find((object) => object.objectId === "annotation-4");
    assert(pointObject, `Pin-only annotation did not register: ${JSON.stringify(state.registry)}`);
    assert(pointObject.attributes?.obb === "point", `Unexpected obb attribute: ${JSON.stringify(pointObject.attributes)}`);
    const size = pointObject.worldObb.size;
    assert(size.x === 0 && size.y === 0 && size.z === 0,
      `Point OBB is not zero-size: ${JSON.stringify(size)}`);
    const position = pointObject.worldObb.position;
    assert([position.x, position.y, position.z].every(Number.isFinite),
      `Point OBB position is not finite: ${JSON.stringify(position)}`);
    evidence.states.pointProbeRegistered = state;
    await page.evaluate(() => {
      const viewer = window.__sl.viewer;
      const annotation = viewer.annotations.find((item) => item.apartmentId === "annotation-4");
      return viewer.removeAnnotation(annotation);
    });
    await waitRegistrySize(page, 1);
    evidence.states.pointProbe = await registryState(page);
    return { pointObject };
  });

  const finalGlError = await page.evaluate(() => window.__sl.glError());
  const shaderErrors = await page.evaluate(() => window.__sl.shaderErrors);
  const names = tests.map((entry) => entry.name);
  const missingTests = expectedTests.filter((name) => !names.includes(name));
  const unexpectedTests = names.filter((name) => !expectedTests.includes(name));
  const duplicateTests = names.filter((name, index) => names.indexOf(name) !== index);
  const failed = tests.filter((entry) => !entry.passed);
  const consoleErrors = consoleMessages.filter((message) => message.type === "error");
  const result = {
    environment: {
      viewerUrl: `${baseURL}/`,
      browser: "headless Chromium",
      angle: "SwiftShader",
      viewport: [640, 480],
    },
    startedAt: new Date().toISOString(),
    tests,
    expectedTests,
    missingTests,
    unexpectedTests,
    duplicateTests,
    viewer: evidence,
    shaderErrors,
    finalGlError,
    consoleMessages,
    pageErrors,
    consoleErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);
  if (failed.length || missingTests.length || unexpectedTests.length || duplicateTests.length ||
      result.shaderErrors.length || result.finalGlError !== 0 ||
      consoleErrors.length || pageErrors.length) {
    console.error(JSON.stringify({
      failedTests: failed.map((entry) => entry.name),
      missingTests,
      unexpectedTests,
      duplicateTests,
      shaderErrors: result.shaderErrors,
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
