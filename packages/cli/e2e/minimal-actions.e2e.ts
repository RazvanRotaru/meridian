/** The extracted graph has its own contextual action group. This drive pins the group wiring,
 * state transitions, and the narrow PR-review-sized geometry that originally scattered controls. */

import { type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumInstalled, FIXTURE, generateGraphFrom, startView } from "./harness";

const SHOPFRONT = join(FIXTURE, "..", "shopfront");
const ROOT = "ts:src";
const SERVICES = "ts:src/services";
const MEMBER_FILES = [
  "auditService.ts",
  "inventoryService.ts",
  "recommendationService.ts",
  "checkoutService.ts",
  "userService.ts",
  "paymentService.ts",
  "catalogService.ts",
  "cartService.ts",
].map((file) => `ts:src/services/${file}`);

let graphDir: string | undefined;

afterAll(() => {
  if (graphDir) {
    rmSync(graphDir, { recursive: true, force: true });
  }
});

describe.skipIf(!chromiumInstalled())("extracted graph actions (headless chromium)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const generated = generateGraphFrom(SHOPFRONT);
    graphDir = generated.dir;
    const view = await startView(generated.graphPath, 4397);
    server = view.server;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(view.url, { waitUntil: "networkidle" });
    await page.waitForSelector(".react-flow__node");
  });

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGINT");
  });

  it("keeps contextual controls together, responsive, and wired to their state", async () => {
    await dive(page, ROOT);
    await page.waitForSelector(`[data-id="${SERVICES}"]`);
    await dive(page, SERVICES);
    await page.waitForSelector(`[data-id="${MEMBER_FILES[0]}"]`);
    for (const [index, member] of MEMBER_FILES.entries()) {
      await page.locator(`[data-id="${member}"]`).dispatchEvent("click", index === 0 ? {} : { ctrlKey: true });
    }

    const actionBar = page.getByRole("group", { name: "Canvas actions" });
    const extract = actionBar.getByRole("button", { name: `Extract selection (${MEMBER_FILES.length})` });
    await extract.click();

    const extractedActions = actionBar.getByRole("group", { name: "Extracted graph actions" });
    const rearrange = extractedActions.getByRole("button", { name: "Rearrange extracted graph" });
    const reset = extractedActions.getByRole("button", { name: "Reset extracted graph" });
    const close = extractedActions.getByRole("button", { name: "Close extracted graph" });
    await extractedActions.waitFor();
    expect(await extract.count()).toBe(0);
    expect(await rearrange.isEnabled()).toBe(true);
    expect(await reset.isDisabled()).toBe(true);
    expect(await close.isVisible()).toBe(true);

    try {
      await page.setViewportSize({ width: 520, height: 500 });
      await expect.poll(
        () => actionBar.getByRole("separator").first().getAttribute("aria-orientation"),
        { timeout: 5_000 },
      ).toBe("horizontal");
      await expectNarrowGeometry(page, actionBar, extractedActions);
      expect(await centerIsHit(close)).toBe(true);

      // A flow drawer can shorten the graph independently of the viewport width. The bar drops into
      // the bottom lane there, above the member list and with every contextual action still hittable.
      await page.setViewportSize({ width: 520, height: 350 });
      await expect.poll(async () => {
        const [bar, members] = await Promise.all([
          actionBar.boundingBox(),
          page.getByRole("region", { name: "Extracted selection" }).boundingBox(),
        ]);
        return bar !== null && members !== null && bar.y >= 0 && bar.y + bar.height <= 350 && members.y + members.height <= bar.y;
      }, { timeout: 5_000 }).toBe(true);
      await expect.poll(
        () => page.locator('[data-graph-surface="minimal"] .react-flow__minimap').isHidden(),
        { timeout: 5_000 },
      ).toBe(true);
      expect(await centerIsHit(close)).toBe(true);
    } finally {
      await page.setViewportSize({ width: 1600, height: 1000 });
    }

    await rearrange.click();
    expect(await rearrange.isEnabled()).toBe(true);
    expect(await reset.isEnabled()).toBe(true);
    await rearrange.click();
    expect(await rearrange.isEnabled()).toBe(true);
    await reset.click();
    expect(await rearrange.isEnabled()).toBe(true);
    expect(await reset.isDisabled()).toBe(true);
    await close.click();
    await extract.waitFor();
    expect(await extractedActions.count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});

async function expectNarrowGeometry(page: Page, actionBar: Locator, extractedActions: Locator): Promise<void> {
  await expect.poll(async () => {
    const [bar, controls, minimap, members, viewGroup, extractedGroup] = await Promise.all([
      actionBar.boundingBox(),
      page.locator("#meridian-control-panel").boundingBox(),
      page.locator('[data-graph-surface="minimal"] .react-flow__minimap').boundingBox(),
      page.getByRole("region", { name: "Extracted selection" }).boundingBox(),
      actionBar.getByRole("group", { name: "View actions" }).boundingBox(),
      extractedActions.boundingBox(),
    ]);
    return bar !== null && controls !== null && minimap !== null && members !== null && viewGroup !== null && extractedGroup !== null
      && bar.x >= controls.x + controls.width
      && bar.y + bar.height <= minimap.y
      && members.x >= controls.x + controls.width
      && members.y + members.height <= bar.y
      && viewGroup.y + viewGroup.height <= extractedGroup.y;
  }, { timeout: 5_000 }).toBe(true);
  expect(await actionBar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.getByRole("region", { name: "Extracted selection" }).locator("ul").evaluate(
    (list) => list.scrollHeight > list.clientHeight,
  )).toBe(true);
}

function dive(page: Page, nodeId: string): Promise<void> {
  return page.locator(`[data-id="${nodeId}"]`).dispatchEvent("dblclick");
}

function centerIsHit(button: Locator): Promise<boolean> {
  return button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit === element || (hit !== null && element.contains(hit));
  });
}
