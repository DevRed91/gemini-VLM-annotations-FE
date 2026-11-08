// Phase 4 browser validation: Gemini metadata persists once and every search
// stays local. The annotate endpoint is mocked so search-time call counts are
// exact; the real /Apartment.sog asset and viewer lifecycle are still exercised.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const strictAssert = require("node:assert/strict");
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.ANNOTATION_METADATA_URL ?? "http://127.0.0.1:5206";
const outputPath = path.join(root, "docs/chat-object-search-phase-4-annotation-metadata-results.json");

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
  throw new Error(`Vite did not become ready at ${url}: ${lastError ?? "unknown error"}`);
}

let server;
let browser;

try {
  const playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  if (!process.env.ANNOTATION_METADATA_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [
      vite, "--host", "127.0.0.1", "--port", "5206", "--strictPort", "--no-open",
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(240000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const annotationRequests = [];
  await page.route("**/api/annotate", async (route) => {
    annotationRequests.push({
      url: route.request().url(),
      time: new Date().toISOString(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        objects: [{
          label: "Dining Table",
          description: "A round dining table with a white marble top.",
          metadata: {
            schemaVersion: 1,
            category: "table",
            description: "A round dining table with a white marble top.",
            attributes: {
              shape: "round",
              material: "marble",
              color: "white",
              usage: "dining",
            },
            synonyms: ["round table", "marble dining table"],
            provenance: { source: "gemini", confidence: 0.9 },
          },
          box: [0.35, 0.35, 0.65, 0.65],
        }],
      }),
    });
  });

  const tests = [];
  const check = async (name, run) => {
    try {
      const details = await run();
      tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
      console.log(`PASS ${name}`);
    } catch (error) {
      tests.push({
        name,
        passed: false,
        error: error instanceof Error ? error.stack : String(error),
      });
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };

  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.__sl?.ready === true && window.__sl.splat?.numSplats > 0,
    null,
    { timeout: 240000 },
  );

  await check("mocked Gemini annotation workflow creates one structured annotation", async () => {
    await page.locator("#annotationToolButton").click();
    await page.locator("canvas").click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__sl.annotationCount === 1 && window.__sl.registry?.size === 1);
    const state = await page.evaluate(() => {
      const object = window.__sl.registry?.objects[0];
      return {
        annotationCount: window.__sl.annotationCount,
        annotationId: object?.objectId,
        label: object?.semanticLabel,
        attributes: object?.attributes,
        metadata: object?.metadata,
      };
    });
    strictAssert.equal(annotationRequests.length, 1);
    strictAssert.equal(state.annotationCount, 1);
    strictAssert.equal(state.annotationId, "annotation-1");
    strictAssert.equal(state.label, "Dining Table");
    strictAssert.equal(state.metadata?.schemaVersion, 1);
    strictAssert.equal(state.metadata?.category, "table");
    strictAssert.equal(state.metadata?.attributes?.material, "marble");
    strictAssert.equal(state.metadata?.attributes?.shape, "round");
    strictAssert.deepEqual(state.metadata?.synonyms, ["round table", "marble dining table"]);
    return state;
  });

  await check("structured metadata is saved as scene JSON", async () => {
    const persisted = await page.evaluate(() => Object.fromEntries(
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith("gemini-annotation-metadata:v1:"))
        .map(([key, value]) => [key, JSON.parse(value)]),
    ));
    strictAssert.equal(Object.keys(persisted).length, 1);
    const scene = Object.values(persisted)[0];
    strictAssert.equal(scene.schemaVersion, 1);
    strictAssert.equal(scene.annotations.length, 1);
    strictAssert.equal(scene.annotations[0].annotationId, "annotation-1");
    strictAssert.equal(scene.annotations[0].label, "Dining Table");
    strictAssert.equal(scene.annotations[0].metadata.attributes.marble, undefined);
    strictAssert.equal(scene.annotations[0].metadata.attributes.material, "marble");
    return {
      storageKey: Object.keys(persisted)[0],
      annotationCount: scene.annotations.length,
    };
  });

  const toggle = page.locator(".spatial-search-toggle");
  const panel = page.locator(".spatial-chat");
  const input = page.locator("#spatial-chat-input");
  const history = page.locator(".spatial-chat__history");
  const submitAndWait = async (query, expected) => {
    const before = await history.locator(".spatial-chat__message--assistant").count();
    await input.fill(query);
    await input.press("Enter");
    await page.waitForFunction(
      ({ expected: text, previousCount }) => {
        const messages = document.querySelectorAll(".spatial-chat__message--assistant .spatial-chat__message-text");
        if (messages.length <= previousCount) return false;
        return (messages.item(messages.length - 1)?.textContent ?? "") === text;
      },
      { expected, previousCount: before },
    );
  };

  await check("Table and stored-attribute searches are local and selectable", async () => {
    await toggle.click();
    strictAssert.equal(await panel.isVisible(), true);
    await submitAndWait("Table", "Found 1 matching annotation.");
    strictAssert.equal(annotationRequests.length, 1);
    await submitAndWait("Marble Table", "Found 1 matching annotation.");
    strictAssert.equal(annotationRequests.length, 1);
    await submitAndWait("Round Table", "Found 1 matching annotation.");
    strictAssert.equal(annotationRequests.length, 1);
    await submitAndWait("Wooden Table", "No matching annotated objects found.");
    strictAssert.equal(annotationRequests.length, 1);

    const resultButton = history.locator(".spatial-chat__select-result").last();
    await resultButton.click();
    const selected = await page.evaluate(() => window.__sl.chatSelection);
    strictAssert.deepEqual(selected, ["annotation-1"]);
    return { annotationRequestsDuringSearch: 0 };
  });

  await check("scene reload restores annotation metadata without another Gemini request", async () => {
    await page.evaluate(() => window.__sl.load("/Apartment.sog"));
    await page.waitForFunction(
      () => window.__sl.ready === true && window.__sl.annotationCount === 1 && window.__sl.registry?.size === 1,
      null,
      { timeout: 240000 },
    );
    const restored = await page.evaluate(() => {
      const object = window.__sl.registry?.objects[0];
      return {
        annotationId: object?.objectId,
        metadata: object?.metadata,
        annotationCount: window.__sl.annotationCount,
      };
    });
    strictAssert.equal(restored.annotationId, "annotation-1");
    strictAssert.equal(restored.metadata?.attributes?.material, "marble");
    strictAssert.equal(annotationRequests.length, 1);
    await submitAndWait("Marble Table", "Found 1 matching annotation.");
    strictAssert.equal(annotationRequests.length, 1);
    return restored;
  });

  await check("browser reload restores metadata and search makes zero annotation requests", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__sl?.ready === true && window.__sl.annotationCount === 1 && window.__sl.registry?.size === 1,
      null,
      { timeout: 240000 },
    );
    await toggle.click();
    await submitAndWait("Table", "Found 1 matching annotation.");
    strictAssert.equal(annotationRequests.length, 1);
    return { annotationRequestsDuringSearch: 0 };
  });

  await check("deleting the restored annotation removes its persisted metadata", async () => {
    const removed = await page.evaluate(() => {
      const viewer = window.__sl.viewer;
      return viewer.removeAnnotation(viewer.annotations[0]);
    });
    await removed;
    await page.waitForFunction(() => window.__sl.annotationCount === 0 && window.__sl.registry?.size === 0);
    const stored = await page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("gemini-annotation-metadata:v1:"))
      .map(([key, value]) => [key, JSON.parse(value).annotations.length]));
    strictAssert.ok(
      stored.every(([, count]) => count === 0),
      `Metadata records should be empty after deletion: ${JSON.stringify(stored)}`,
    );
  });

  const result = {
    environment: {
      viewerUrl: `${baseURL}/`,
      scene: "/Apartment.sog",
      browser: "headless Chromium",
      renderer: "SwiftShader",
      annotationEndpoint: "mocked",
    },
    startedAt: new Date().toISOString(),
    annotationRequests,
    tests,
    consoleErrors,
    pageErrors,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);
  if (tests.some((test) => !test.passed) || consoleErrors.length || pageErrors.length) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
