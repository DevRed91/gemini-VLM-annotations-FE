// Object-search track, Phase 1 validation: the DEV-only `window.__sl.search`
// seam runs the deterministic ObjectMatcher over the real per-world
// SpatialObjectRegistry. Covers normalization, synonyms, attributes,
// quantifiers, ambiguity, no-match, and controlled rejections against
// annotations created through both the cluster-fitted and pin-only paths.
// Modeled on scripts/registry-validate.mjs (Phase 0).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { deepStrictEqual } = require("node:assert");
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.SEARCH_URL ?? "http://127.0.0.1:5203";
const outputPath = path.join(root, "docs/chat-object-search-phase-1-results.json");
const expectedTests = [
  "searching an empty registry is a controlled no-match",
  "cluster-fitted annotations are searchable with case/whitespace-insensitive labels",
  "pin-only annotations are searchable with whitespace/punctuation normalization",
  "attribute search and quantifier 'one' pass through the real registry",
  "synonym folding matches the Phase 0 registry labels",
  "unmatched labels produce a no-match with a reason",
  "invalid queries throw controlled TypeErrors",
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
      annotationCount: hook.annotationCount,
      registry: hook.registry,
    };
  });
}
async function search(page, query, options) {
  return page.evaluate(
    ([innerQuery, innerOptions]) => window.__sl.search(innerQuery, innerOptions),
    [query, options ?? null],
  );
}
async function searchThrows(page, query) {
  return page.evaluate((innerQuery) => {
    try {
      window.__sl.search(innerQuery);
      return "no-throw";
    } catch (error) {
      return error instanceof TypeError ? "type-error" : `other:${String(error)}`;
    }
  }, query);
}
async function createPinOnly(page, label) {
  return page.evaluate((innerLabel) => {
    const hook = window.__sl;
    hook.viewer.createAnnotationElement(
      new hook.THREE.Vector3(0.2, 0.4, 0.2),
      innerLabel,
      {},
    );
    return hook.registry;
  }, label);
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
  if (!process.env.SEARCH_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5203", "--strictPort", "--no-open"], {
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
  const evidence = { states: {}, searches: {} };
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

  await viewerTest(expectedTests[0], async () => {
    const state = await registryState(page);
    assert(state.registry && state.registry.size === 0,
      `Registry did not start empty: ${JSON.stringify(state.registry)}`);
    const result = await search(page, { label: "sofa" });
    assert(result.status === "no-match" && result.matchCount === 0 && result.annotationIds.length === 0,
      `Empty registry search did not no-match: ${JSON.stringify(result)}`);
    assert(typeof result.reason === "string" && result.reason.length > 0, "no-match lacks a reason");
    return { state, result };
  });

  await viewerTest(expectedTests[1], async () => {
    // Cluster-fitted path: Gaussian cluster lift from the detection box.
    await page.evaluate(async () => {
      await window.__sl.inject("Sofa", [0.1, 0.1, 0.5, 0.5]);
    });
    await waitRegistrySize(page, 1);
    const state = await registryState(page);
    const [object] = state.registry.objects;
    assert(object.attributes?.obb === "cluster",
      `Expected a cluster-fitted annotation: ${JSON.stringify(object.attributes)}`);
    const result = await search(page, { label: "  SOFA  " });
    assert(result.status === "matched" && result.matchCount === 1,
      `Case/whitespace-insensitive search failed: ${JSON.stringify(result)}`);
    deepStrictEqual(result.annotationIds, ["annotation-1"]);
    evidence.states.afterCluster = state;
    evidence.searches.caseInsensitive = result;
    return { object, result };
  });

  await viewerTest(expectedTests[2], async () => {
    // Pin-only path (direct createAnnotationElement): registration is
    // independent of the Gaussian lift, matching the Phase 0 contract.
    await createPinOnly(page, "  Coffee   Table ");
    await waitRegistrySize(page, 2);
    const state = await registryState(page);
    const table = state.registry.objects.find((object) => object.objectId === "annotation-2");
    assert(table && table.attributes?.obb === "point" && table.semanticLabel === "Coffee   Table".trim(),
      `Pin-only annotation did not register as expected: ${JSON.stringify(table)}`);
    const result = await search(page, { label: "Coffee Table" });
    assert(result.status === "matched" && result.matchCount === 1,
      `Whitespace-normalized search failed: ${JSON.stringify(result)}`);
    deepStrictEqual(result.annotationIds, ["annotation-2"]);
    await createPinOnly(page, "Sofa!");
    await waitRegistrySize(page, 3);
    const ambiguous = await page.evaluate(() => window.__sl.search({ label: "sofa", quantifier: "one" }));
    assert(ambiguous.status === "ambiguous" && ambiguous.matchCount === 2,
      `Quantifier "one" did not report ambiguity: ${JSON.stringify(ambiguous)}`);
    deepStrictEqual(ambiguous.annotationIds, ["annotation-1", "annotation-3"]);
    deepStrictEqual(
      (await search(page, { label: "SOFA!", quantifier: "all" })).annotationIds,
      ["annotation-1", "annotation-3"],
      "Punctuation-normalized search failed");
    evidence.states.afterPinOnly = await registryState(page);
    evidence.searches.ambiguous = ambiguous;
    return { result, ambiguous };
  });

  await viewerTest(expectedTests[3], async () => {
    // Two pin-only annotations exist at this point (coffee table, "Sofa!"):
    // quantifier "one" must report ambiguity rather than pick one.
    const result = await search(page, { attributes: { obb: "point" }, quantifier: "one" });
    assert(result.status === "ambiguous",
      `Attribute search did not report ambiguity: ${JSON.stringify(result)}`);
    deepStrictEqual(result.annotationIds, ["annotation-2", "annotation-3"]);
    const unique = await search(page, { label: "coffee table", attributes: { obb: "point" }, quantifier: "one" });
    assert(unique.status === "matched",
      `Constrained attribute search did not match: ${JSON.stringify(unique)}`);
    deepStrictEqual(unique.annotationIds, ["annotation-2"]);
    const equivalent = await search(page, { label: " Coffee Table ", attributes: { obb: "point" }, quantifier: "one" });
    const equivalent2 = await search(page, { label: "coffee  table", attributes: { obb: "point" }, quantifier: "one" });
    deepStrictEqual(equivalent, equivalent2,
      "Equivalent queries do not yield identical results");
    evidence.searches.attribute = result;
    return { result, unique };
  });

  await viewerTest(expectedTests[4], async () => {
    await createPinOnly(page, "Couch");
    await waitRegistrySize(page, 4);
    const result = await search(page, { label: "couch" });
    // annotation-3 ("Sofa!") folds in as well: only listed synonyms ever fold.
    assert(result.status === "matched" && result.matchCount === 3,
      `Synonym search for couch did not fold: ${JSON.stringify(result)}`);
    deepStrictEqual(result.annotationIds, ["annotation-1", "annotation-3", "annotation-4"]);
    const symmetric = await search(page, { label: "sofa" });
    deepStrictEqual(symmetric.annotationIds, ["annotation-1", "annotation-3", "annotation-4"],
      `Folded search for sofa did not include the Couch record: ${JSON.stringify(symmetric)}`);
    evidence.searches.synonym = result;
    return { result, symmetric };
  });

  await viewerTest(expectedTests[5], async () => {
    const result = await search(page, { label: "bed" });
    assert(result.status === "no-match" && result.annotationIds.length === 0,
      `Unmatched label did not no-match: ${JSON.stringify(result)}`);
    assert(result.reason.includes('"bed"'), `Reason does not mention the label: ${result.reason}`);
    return { result };
  });

  await viewerTest(expectedTests[6], async () => {
    assert(await searchThrows(page, {}) === "type-error", "Empty query did not throw TypeError");
    assert(await searchThrows(page, { quantifier: "all" }) === "type-error", "Zero-criteria quantifier query did not throw TypeError");
    assert(await searchThrows(page, { label: "sofa", quantifier: "some" }) === "type-error", "Unsupported quantifier did not throw TypeError");
    assert(
      await searchThrows(page, { label: "sofa", attributes: { material: 3 } }) === "type-error",
      "Non-string attribute value did not throw TypeError");
    // Rejections are controlled: nothing was matched or mutated.
    const state = await registryState(page);
    assert(state.registry.size === 4, `Registry changed during searches: ${JSON.stringify(state.registry)}`);
    return { state };
  });

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
    consoleMessages,
    pageErrors,
    consoleErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);
  if (failed.length || missingTests.length || unexpectedTests.length || duplicateTests.length ||
      consoleErrors.length || pageErrors.length) {
    console.error(JSON.stringify({
      failedTests: failed.map((entry) => entry.name),
      missingTests,
      unexpectedTests,
      duplicateTests,
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
