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

const COLLAPSED_CHEVRON = "▸"; // ▸

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

  it("starts collapsed at the single system root (progressive disclosure)", async () => {
    expect(await page.locator(".react-flow__node").count()).toBe(1);
  });

  it("expands in place to the full graph with no console or page errors", async () => {
    for (let round = 0; round < 5; round += 1) {
      const clicked = await expandCollapsed(page);
      await page.waitForTimeout(600);
      if (clicked === 0) {
        break;
      }
    }
    expect(await page.locator(".react-flow__node").count()).toBeGreaterThan(20);
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

function expandCollapsed(page: Page): Promise<number> {
  return page.evaluate((chevron) => {
    const buttons = Array.from(document.querySelectorAll(".react-flow__node button"));
    const collapsed = buttons.filter((button) => button.textContent?.includes(chevron));
    collapsed.forEach((button) => (button as HTMLButtonElement).click());
    return collapsed.length;
  }, COLLAPSED_CHEVRON);
}

function statusText(page: Page): Promise<string> {
  return page.locator("text=/no telemetry|loaded:/").first().innerText();
}
