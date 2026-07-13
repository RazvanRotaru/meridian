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

    const extractedGraph = page.getByRole("region", { name: "Extracted graph" });
    const extractedActions = actionBar.getByRole("group", { name: "Extracted graph actions" });
    const remove = actionBar.getByRole("button", { name: "Remove added nodes in selection" });
    const rearrange = extractedActions.getByRole("button", { name: "Rearrange extracted graph" });
    const reset = extractedActions.getByRole("button", { name: "Reset extracted graph" });
    const close = extractedActions.getByRole("button", { name: "Close extracted graph" });
    const highlightInCodebase = extractedActions.getByRole("button", { name: "Highlight code in codebase" });
    await extractedGraph.waitFor();
    await extractedActions.waitFor();
    expect(await extract.count()).toBe(0);
    expect(await remove.isVisible()).toBe(true);
    expect(await remove.isDisabled()).toBe(true);
    expect(await rearrange.isEnabled()).toBe(true);
    expect(await reset.isDisabled()).toBe(true);
    expect(await close.isVisible()).toBe(true);
    expect(await highlightInCodebase.isVisible()).toBe(true);
    expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);

    // The context action swaps only the graph pane: all curated members are placed in their
    // canonical Map ancestry. Curation/navigation stay frozen, while card chevrons disclose code
    // locally without mutating the extracted graph underneath.
    await highlightInCodebase.click();
    const contextGraph = page.getByRole("region", { name: "Codebase context graph" });
    await contextGraph.getByText("READ-ONLY", { exact: true }).waitFor();
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("Back to extracted graph");
    await contextGraph.getByText(`${MEMBER_FILES.length} graph nodes highlighted`, { exact: true }).waitFor();
    const contextBounds = await contextGraph.boundingBox();
    expect(contextBounds).not.toBeNull();
    for (const member of MEMBER_FILES) {
      const contextMember = contextGraph.locator(`[data-id="${member}"]`);
      await contextMember.waitFor();
      const memberBounds = await contextMember.boundingBox();
      expect(memberBounds).not.toBeNull();
      expect(memberBounds!.x).toBeGreaterThanOrEqual(contextBounds!.x);
      expect(memberBounds!.y).toBeGreaterThanOrEqual(contextBounds!.y);
      expect(memberBounds!.x + memberBounds!.width).toBeLessThanOrEqual(contextBounds!.x + contextBounds!.width);
      expect(memberBounds!.y + memberBounds!.height).toBeLessThanOrEqual(contextBounds!.y + contextBounds!.height);
    }
    expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);
    const contextMember = contextGraph.locator(`[data-id="${MEMBER_FILES[0]}"]`);
    const contextNodeCount = await contextGraph.locator(".react-flow__node").count();
    const expansionParam = new URL(page.url()).searchParams.get("mexp");
    await contextMember.getByRole("button", { name: "Expand" }).click();
    await contextMember.getByRole("button", { name: "Collapse" }).waitFor();
    await expect.poll(() => contextGraph.locator(".react-flow__node").count()).toBeGreaterThan(contextNodeCount);
    await contextMember.getByRole("button", { name: "Collapse" }).click();
    await contextMember.getByRole("button", { name: "Expand" }).waitFor();
    expect(new URL(page.url()).searchParams.get("mexp")).toBe(expansionParam);
    expect(await actionBar.getByRole("button", { name: "Expand one level" }).count()).toBe(0);
    expect(await actionBar.getByRole("button", { name: "Rearrange extracted graph" }).count()).toBe(0);

    await page.setViewportSize({ width: 520, height: 500 });
    await expect.poll(async () => {
      const [graph, summary] = await Promise.all([
        contextGraph.boundingBox(),
        contextGraph.getByRole("region", { name: "Codebase context summary" }).boundingBox(),
      ]);
      return graph !== null && summary !== null
        && summary.x >= graph.x
        && summary.x + summary.width <= graph.x + graph.width;
    }, { timeout: 5_000 }).toBe(true);
    expect(await centerIsHit(actionBar.getByRole("button", { name: "Back to extracted graph" }))).toBe(true);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await actionBar.getByRole("button", { name: "Back to extracted graph" }).click();
    await extractedGraph.waitFor();
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("Highlight code in codebase");
    await extractedActions.waitFor();
    expect(await reset.isDisabled()).toBe(true);

    try {
      await page.setViewportSize({ width: 520, height: 500 });
      await expect.poll(
        () => actionBar.getByRole("separator").first().getAttribute("aria-orientation"),
        { timeout: 5_000 },
      ).toBe("horizontal");
      await expectNarrowGeometry(page, actionBar, extractedActions);
      expect(await centerIsHit(remove)).toBe(true);
      expect(await centerIsHit(close)).toBe(true);

      // A flow drawer can shorten the graph independently of the viewport width. Every contextual
      // action must remain within the shortened graph pane and stay hittable.
      await page.setViewportSize({ width: 520, height: 350 });
      await expect.poll(async () => {
        const bar = await actionBar.boundingBox();
        return bar !== null && bar.y >= 0 && bar.y + bar.height <= 350;
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
    const [bar, surface, minimap, viewGroup, extractedGroup] = await Promise.all([
      actionBar.boundingBox(),
      page.locator('[data-graph-surface="minimal"]').boundingBox(),
      page.locator('[data-graph-surface="minimal"] .react-flow__minimap').boundingBox(),
      actionBar.getByRole("group", { name: "View actions" }).boundingBox(),
      extractedActions.boundingBox(),
    ]);
    return bar !== null && surface !== null && minimap !== null && viewGroup !== null && extractedGroup !== null
      && bar.x >= surface.x
      && bar.x + bar.width <= surface.x + surface.width
      && bar.y + bar.height <= minimap.y
      && viewGroup.y + viewGroup.height <= extractedGroup.y;
  }, { timeout: 5_000 }).toBe(true);
  expect(await actionBar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);
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
