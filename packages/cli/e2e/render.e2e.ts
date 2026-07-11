/**
 * End-to-end: `blueprint generate` the fixture, `blueprint view` it, and drive a real
 * headless Chromium to prove the blueprint renders, drills down, gates telemetry behind an
 * explicit environment, and refuses to default to prod. Skips cleanly when the Playwright
 * browser is not installed (`npx playwright install chromium`).
 */

import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumInstalled, generateGraph, runCli, startView } from "./harness";

let graphDir: string | undefined;

afterAll(() => {
  if (graphDir) {
    rmSync(graphDir, { recursive: true, force: true });
  }
});

describe.skipIf(!chromiumInstalled())("rendered blueprint (headless chromium)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const generated = generateGraph();
    graphDir = generated.dir;
    const view = await startView(generated.graphPath);
    server = view.server;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(view.url, { waitUntil: "networkidle" });
    await page.waitForSelector(".react-flow__node");
  });

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGINT");
  });

  it("renders the Map (package overview) as the default lens, with no console/page errors", async () => {
    // The default "modules" lens is the Map: the whole-repo package overview (group cards).
    expect(await page.locator(".react-flow__node").count()).toBeGreaterThan(0);
    expect(await page.locator('button:has-text("Map")').count()).toBe(1);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  // Runs before the Service-lens switch below so it starts on the default Map lens.
  it("keeps the Map legend static when selection changes", async () => {
    await page.getByRole("button", { name: /Legend/ }).click();
    const legend = page.getByRole("region", { name: "Map legend" });
    const beforeSelection = await legend.innerText();
    expect(beforeSelection).toContain("WHEN YOU SELECT");

    const packageNode = page.locator('[data-id="ts:src"]');
    await packageNode.click();
    await page.getByRole("button", { name: "Extract selection (1)" }).waitFor();
    expect(await legend.innerText()).toBe(beforeSelection);

    await page.locator(".react-flow__pane").dispatchEvent("click");
    await page.getByRole("button", { name: "Extract selection (1)" }).waitFor({ state: "detached" });
    expect(await legend.innerText()).toBe(beforeSelection);
    await legend.getByTitle("Close").click();
  });

  it("Service lens renders svc: cluster frames wired by couplings, with no console/page errors", async () => {
    // The composition surface merged into the Lens segmented control: the Service segment draws
    // service clusters as `svc:` frames on the SHARED canvas (not scorecards).
    await lensButton(page, "Service").dispatchEvent("click");
    await page.waitForSelector('.react-flow__node-package[data-id^="svc:"]', { timeout: 30_000 });
    expect(await page.locator('.react-flow__node-package[data-id^="svc:"]').count()).toBeGreaterThan(1);
    // …wired by cluster-coupling edges (at least one endpoint a svc: frame).
    await expect.poll(() => page.locator(".react-flow__edge").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  it("paints telemetry only after an explicit environment load", async () => {
    expect(await statusText(page)).toContain("no telemetry");
    await page.selectOption("select", "staging");
    await page.click('button:has-text("Load telemetry")');
    await page.waitForFunction(() => document.body.innerText.includes("loaded: staging"));
    expect(await statusText(page)).toContain("loaded: staging");
  });

  it("hides tests by default on the Map, and the badged Tests pill reveals then re-hides them", async () => {
    // Back to the Map lens, then drill into src — the level where __tests__ would be drawn
    // (testIds close over containment, so the group card itself is hidden with its files).
    await lensButton(page, "Map").dispatchEvent("click");
    await page.waitForSelector('[data-id="ts:src"]', { timeout: 30_000 });
    await page.locator('[data-id="ts:src"]').dispatchEvent("dblclick");
    await page.waitForSelector('[data-id="ts:src/services"]', { timeout: 30_000 });
    // showTests DEFAULTS to false: no test cards at boot.
    expect(await page.locator('[data-id="ts:src/__tests__"]').count()).toBe(0);
    // The Tests pill carries its file-count badge; clicking it SHOWS the test cards…
    const testsPill = page.getByRole("button", { name: /^Tests \d+$/ });
    expect(await testsPill.count()).toBe(1);
    await testsPill.dispatchEvent("click");
    await page.waitForSelector('[data-id="ts:src/__tests__"]', { timeout: 30_000 });
    // …and clicking again hides them in place (filtered, not permanently pruned).
    await testsPill.dispatchEvent("click");
    await expect.poll(() => page.locator('[data-id="ts:src/__tests__"]').count(), { timeout: 20_000 }).toBe(0);
  });

  it("coverage mode opens the panel with verdicts, reasons, and the summary percentage", async () => {
    await page.click('button:has-text("Coverage")');
    await page.waitForSelector("text=Static coverage");
    const panel = await page.locator("text=Static coverage").locator("xpath=ancestor::div[1]").innerText();
    expect(panel).toMatch(/\d+%/);
    await page.waitForSelector("text=untested");
    await page.waitForSelector("text=OrderRoutes");
    await page.waitForSelector("text=/never called in the graph/");
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

describe("never-prod gate", () => {
  it("refuses --overlay without --env (exit code 2)", () => {
    const { graphPath, dir } = generateGraph();
    graphDir = dir;
    const result = runCli(["view", graphPath, "--overlay", "mock", "--no-open"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/never defaults/i);
  });
});

function statusText(page: Page): Promise<string> {
  return page.locator("text=/no telemetry|loaded:/").first().innerText();
}

/** A lens segment button inside the Lens segmented control (ViewModeToggle). */
function lensButton(page: Page, label: string): Locator {
  return page.getByLabel("Lens").getByRole("button", { name: label, exact: true });
}
