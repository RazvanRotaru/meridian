/** Real-pointer coverage for the graph/logic-flow editor split, including both edge snap zones. */

import { type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumInstalled, generateGraph, startView } from "./harness";

const FLOW_ROOT = "ts:src/index.ts#buildOrdersApp";

let graphDir: string | undefined;

afterAll(() => {
  if (graphDir) {
    rmSync(graphDir, { recursive: true, force: true });
  }
});

describe.skipIf(!chromiumInstalled())("graph and logic-flow split (headless chromium)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const generated = generateGraph();
    graphDir = generated.dir;
    const view = await startView(generated.graphPath, 4396);
    server = view.server;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const splitUrl = new URL(view.url);
    splitUrl.searchParams.set("fexp", "1");
    splitUrl.searchParams.set("fsel", `${encodeURIComponent(FLOW_ROOT)}@`);
    await page.goto(splitUrl.href, { waitUntil: "networkidle" });
    await page.getByRole("complementary", { name: "Code flow" }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGINT");
  });

  it("drags freely, minimizes near either edge, and stays reachable for restoration", async () => {
    const separator = page.getByRole("separator", { name: "Resize graph and logic flow" });
    await separator.waitFor();
    expect(await separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(await separator.getAttribute("aria-valuenow")).toBe("60");
    const initialBodyStyle = await bodyDragStyle(page);

    await dragSeparator(page, separator, 0.44);
    await expect.poll(() => separator.getAttribute("aria-valuenow")).toBe("44");
    await expect.poll(() => graphPaneRatio(page)).toBeCloseTo(0.44, 2);
    await expect.poll(() => bodyDragStyle(page)).toEqual(initialBodyStyle);
    expect(await separator.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.mouse.move(0, 0);
    await expect.poll(() => separator.evaluate((element) => element.style.boxShadow)).not.toBe("none");
    expect(await toolbarFitsGraph(page)).toBe(true);

    await dragSeparator(page, separator, "top");
    await expect.poll(() => separator.getAttribute("data-split-state")).toBe("graph-minimized");
    const graphPane = page.locator("#meridian-graph-pane");
    expect(await paneHeight(page, "#meridian-graph-pane")).toBeLessThanOrEqual(1);
    expect(await graphPane.getAttribute("aria-hidden")).toBe("true");
    expect(await graphPane.getAttribute("inert")).toBe("");

    // A minimized pane leaves the 10px separator at the edge, so the same pointer gesture restores it.
    await dragSeparator(page, separator, 0.5);
    await expect.poll(() => separator.getAttribute("aria-valuenow")).toBe("50");
    await expect.poll(() => graphPaneRatio(page)).toBeCloseTo(0.5, 2);
    expect(await graphPane.getAttribute("aria-hidden")).toBeNull();

    await dragSeparator(page, separator, "bottom");
    await expect.poll(() => separator.getAttribute("data-split-state")).toBe("flow-minimized");
    const flowPane = page.locator("#meridian-logic-flow-pane");
    expect(await paneHeight(page, "#meridian-logic-flow-pane")).toBeLessThanOrEqual(1);
    expect(await flowPane.getAttribute("aria-hidden")).toBe("true");
    expect(await flowPane.getAttribute("inert")).toBe("");

    await dragSeparator(page, separator, 0.6);
    await expect.poll(() => separator.getAttribute("aria-valuenow")).toBe("60");
    await expect.poll(() => graphPaneRatio(page)).toBeCloseTo(0.6, 2);
    expect(await separator.getAttribute("data-split-state")).toBe("split");
    expect(await flowPane.getAttribute("aria-hidden")).toBeNull();

    // The focusable separator mirrors editor keyboard conventions and changes the real layout.
    await separator.press("ArrowUp");
    await expect.poll(() => separator.getAttribute("aria-valuenow")).toBe("55");
    await expect.poll(() => graphPaneRatio(page)).toBeCloseTo(0.55, 2);
    await separator.press("Home");
    expect(await separator.getAttribute("data-split-state")).toBe("graph-minimized");
    await separator.press("End");
    expect(await separator.getAttribute("data-split-state")).toBe("flow-minimized");
    await separator.press("Enter");
    expect(await separator.getAttribute("aria-valuenow")).toBe("60");
    expect(await bodyDragStyle(page)).toEqual(initialBodyStyle);
    expect(pageErrors).toEqual([]);
  });
});

async function dragSeparator(page: Page, separator: Locator, target: number | "top" | "bottom"): Promise<void> {
  const [box, rootBox] = await Promise.all([
    separator.boundingBox(),
    page.locator("#meridian-graph-pane").locator("xpath=..").boundingBox(),
  ]);
  if (!box || !rootBox) {
    throw new Error("split separator has no visible bounds");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const targetY = typeof target === "number"
    ? rootBox.y + (rootBox.height - box.height) * target + box.height / 2
    : target === "top" ? rootBox.y + 20 : rootBox.y + rootBox.height - 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, targetY, { steps: 8 });
  await page.mouse.up();
}

function paneHeight(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => element.getBoundingClientRect().height);
}

async function graphPaneRatio(page: Page): Promise<number> {
  const [graph, flow] = await Promise.all([
    paneHeight(page, "#meridian-graph-pane"),
    paneHeight(page, "#meridian-logic-flow-pane"),
  ]);
  return graph / (graph + flow);
}

function bodyDragStyle(page: Page): Promise<{ cursor: string; userSelect: string }> {
  return page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }));
}

function toolbarFitsGraph(page: Page): Promise<boolean> {
  return page.locator("#meridian-control-panel").evaluate((toolbar) => {
    const host = toolbar.parentElement;
    const graph = document.querySelector("#meridian-graph-pane");
    if (!host || !graph) {
      return false;
    }
    const hostBox = host.getBoundingClientRect();
    const graphBox = graph.getBoundingClientRect();
    return hostBox.top >= graphBox.top && hostBox.bottom <= graphBox.bottom + 1;
  });
}
