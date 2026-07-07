/**
 * End-to-end: `blueprint generate` the fixture, `blueprint view` it, and drive a real
 * headless Chromium to prove the blueprint renders, drills down, gates telemetry behind an
 * explicit environment, and refuses to default to prod. Skips cleanly when the Playwright
 * browser is not installed (`npx playwright install chromium`).
 */

import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
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

  it("renders the Service-composition scorecards wired by couplings, with no console/page errors", async () => {
    // The composition lens is withheld from the default build (featureFlags.ts); when the segment
    // is absent this build has nothing to assert here.
    if ((await page.locator('button:has-text("Service composition")').count()) === 0) {
      return;
    }
    await page.click('button:has-text("Service composition")');
    // Wait on a composition-only marker (a scorecard's members band), not a raw node count the
    // outgoing Map lens could also satisfy.
    await page.waitForSelector('.react-flow__node:has-text("members")');
    expect(await page.locator(".react-flow__node").count()).toBeGreaterThan(5);
    expect(await page.locator(".react-flow__edge").count()).toBeGreaterThan(0);
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

  it("hides test file cards on the Map when the Tests toggle is clicked", async () => {
    // Drill to where the test FILES are drawn (group cards are never test-hidden by design).
    await page.dblclick('[data-id="ts:src"]');
    await page.waitForSelector('[data-id="ts:src/__tests__"]');
    await page.dblclick('[data-id="ts:src/__tests__"]');
    await page.waitForSelector('[data-id="ts:src/__tests__/orderService.test.ts"]');
    const before = await page.locator(".react-flow__node").count();
    await page.click('button:has-text("Tests (")');
    await page.waitForTimeout(700);
    const hidden = await page.locator(".react-flow__node").count();
    expect(hidden).toBeLessThan(before); // the test file cards (and their wires) are gone
    // Toggling back restores them — the level is filtered in place, not permanently pruned.
    await page.click('button:has-text("Tests (")');
    await page.waitForTimeout(700);
    expect(await page.locator(".react-flow__node").count()).toBe(before);
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
