import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const root = fileURLToPath(new URL("../", import.meta.url));
const baseURL = process.env.CHAT_URL ?? "http://127.0.0.1:5204";
const outputPath = path.join(root, "docs/chat-object-search-phase-2-results.json");
const screenshotPath = path.join(root, "docs/chat-object-search-phase-2.png");
let server;
let browser;

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

const tests = [];
async function check(name, run) {
  try {
    const details = await run();
    tests.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    tests.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createPin(page, label, description) {
  return page.evaluate(({ label: name, description: detail }) => {
    const hook = window.__sl;
    const viewer = hook.viewer;
    const annotation = viewer.createAnnotationElement(
      new hook.THREE.Vector3(0.2, 0.4, 0.2), name, { description: detail },
    );
    return { id: annotation.apartmentId, registry: hook.registry };
  }, { label, description });
}

try {
  let playwright;
  try {
    playwright = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    throw new Error("Playwright is required. Run npm install, or set PLAYWRIGHT_MODULE. " + String(error));
  }
  if (!process.env.CHAT_URL) {
    const vite = path.join(root, "node_modules/vite/bin/vite.js");
    server = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", "5204", "--strictPort", "--no-open"], {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(45000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseURL}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__sl?.ready && window.__sl.splat?.numSplats > 0, null, { timeout: 240000 });

  const toggle = page.locator(".spatial-search-toggle");
  const panel = page.locator(".spatial-chat");
  const input = page.locator("#spatial-chat-input");
  const history = page.locator(".spatial-chat__history");
  const latestAssistant = () => history.locator(".spatial-chat__message--assistant").last();
  const submitAndWait = async (query, expected, includes = false) => {
    const before = await history.locator(".spatial-chat__message--assistant").count();
    await input.fill(query);
    await input.press("Enter");
    await page.waitForFunction(
      ({ expected: text, partial, previousCount }) => {
        const messages = document.querySelectorAll(".spatial-chat__message--assistant .spatial-chat__message-text");
        if (messages.length <= previousCount) return false;
        const latest = messages.item(messages.length - 1)?.textContent ?? "";
        return partial ? latest.includes(text) : latest === text;
      },
      { expected, partial: includes, previousCount: before },
    );
  };
  const waitForLatestReply = (text, includes = false) => page.waitForFunction(
    ({ expected, partial }) => {
      const messages = document.querySelectorAll(".spatial-chat__message--assistant .spatial-chat__message-text");
      const latest = messages.item(messages.length - 1)?.textContent ?? "";
      return partial ? latest.includes(expected) : latest === expected;
    },
    { expected: text, partial: includes },
  );

  await check("panel opens and clearly limits search to current annotations", async () => {
    assert.equal(await panel.isVisible(), false);
    await toggle.click();
    assert.equal(await panel.isVisible(), true);
    assert.match(await panel.locator(".spatial-chat__scope").textContent(), /annotations in this scene only/i);
    assert.match(await panel.locator(".spatial-chat__status").textContent(), /current scene's annotations/i);
  });

  const table = await createPin(page, "Round Marble Table", "A white marble table beside the sofa.");
  const sofa1 = await createPin(page, "Red Sofa", "A red upholstered sofa.");
  const sofa2 = await createPin(page, "Sofa", "A fabric sofa.");
  await page.waitForFunction((count) => window.__sl.registry?.size === count, 3);

  await check("partial label search finds Round Marble Table", async () => {
    await submitAndWait("table", "Found 1 matching annotation.");
    assert.equal(await history.getByText("Round Marble Table", { exact: true }).count(), 1);
    assert.equal(await history.getByText(table.id, { exact: true }).count(), 1);
  });

  await check("local color/material parsing filters registered annotation attributes", async () => {
    await submitAndWait("marble table", "Found 1 matching annotation.");
    assert.equal(await history.getByText("Round Marble Table", { exact: true }).count(), 2);
    await submitAndWait("red sofa", "Found 1 matching annotation.");
    assert.equal(await history.getByText(sofa1.id, { exact: true }).count(), 1);
  });

  await check("plural all query returns every result and one query reports ambiguity", async () => {
    await submitAndWait("find all sofas", "Found 2 matching annotations.");
    assert.equal(await latestAssistant().locator(".spatial-chat__result-status--matched").count(), 2);
    await submitAndWait("the sofa", "I found 2 matching objects. Please narrow your search.");
    assert.equal(await latestAssistant().locator(".spatial-chat__result-status--ambiguous").count(), 2);
    assert.equal(await latestAssistant().getByText(sofa1.id, { exact: true }).count(), 1);
    assert.equal(await latestAssistant().getByText(sofa2.id, { exact: true }).count(), 1);
  });

  await check("no-match and unsupported input return clear local responses", async () => {
    await submitAndWait("bed", "No matching annotated objects found.");
    await submitAndWait("annotated objects", "couldn't identify an object name", true);
  });

  await check("clear conversation keeps annotations intact", async () => {
    await page.locator(".spatial-chat__clear").click();
    await history.getByText(/conversation cleared/i).waitFor();
    assert.equal(await page.evaluate(() => window.__sl.annotationCount), 3);
    assert.equal(await page.evaluate(() => window.__sl.registry.size), 3);
  });

  await check("deleting an annotation removes it from visible result rows", async () => {
    await submitAndWait("all sofas", "Found 2 matching annotations.");
    await page.evaluate((id) => {
      const viewer = window.__sl.viewer;
      const annotation = viewer.annotations.find((entry) => entry.apartmentId === id);
      return viewer.removeAnnotation(annotation);
    }, sofa1.id);
    await waitForLatestReply("Results updated after an annotation change", true);
    assert.equal(await history.getByText(sofa1.id, { exact: true }).count(), 0);
    assert.equal(await history.getByText(sofa2.id, { exact: true }).count(), 1);
  });

  await check("world reload clears previous conversation and restores persisted annotations", async () => {
    await page.evaluate(() => window.__sl.load("/Apartment.sog"));
    await page.waitForFunction(() => window.__sl.ready && window.__sl.registry?.size === 2, null, { timeout: 240000 });
    await history.getByText(/scene ready/i).waitFor();
    assert.equal(await history.getByText(table.id, { exact: true }).count(), 0);
    assert.equal(await history.getByText(sofa2.id, { exact: true }).count(), 0);
    assert.equal(await input.isDisabled(), false);
  });

  await check("panel remains within narrow mobile viewport and closes accessibly", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    if (!(await panel.isVisible())) await toggle.click();
    const box = await panel.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844,
      `Panel is outside mobile viewport: ${JSON.stringify(box)}`);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await panel.locator(".spatial-chat__close").click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  if (!(await panel.isVisible())) await toggle.click();
  await createPin(page, "Long Object Label For Responsive Search Result Layout", "A test annotation.");
  for (let index = 0; index < 12; index++) {
    await submitAndWait("bed", "No matching annotated objects found.");
  }
  await submitAndWait("responsive search result", "Found 1 matching annotation.");
  const scrollState = await history.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.ok(scrollState.scrollTop + scrollState.clientHeight >= scrollState.scrollHeight - 2,
    `Conversation did not scroll to the latest message: ${JSON.stringify(scrollState)}`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const result = {
    environment: { viewerUrl: `${baseURL}/`, browser: "headless Chromium", renderer: "SwiftShader", testedViewports: [[1280, 800], [390, 844]] },
    startedAt: new Date().toISOString(),
    tests,
    consoleErrors,
    pageErrors,
    screenshot: path.relative(root, screenshotPath),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Results written to ${path.relative(process.cwd(), outputPath)}`);
  console.log(`Screenshot written to ${path.relative(process.cwd(), screenshotPath)}`);
  if (tests.some((entry) => !entry.passed) || consoleErrors.length || pageErrors.length) {
    process.exitCode = 1;
    console.error(JSON.stringify({ failedTests: tests.filter((entry) => !entry.passed), consoleErrors, pageErrors }, null, 2));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
}
