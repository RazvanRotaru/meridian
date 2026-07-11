/**
 * Cross-lens PARITY drive (unified-canvas phase E), the e2e layer behind the renderer's
 * surfaceParity suite: serve examples/shopfront (it has a real render tree, so all three lenses
 * have substance) through the built CLI and replay the SAME gestures per lens — select a class,
 * expand via the chevron, assert the selection ring + expansion; prove a ghost click replaces
 * selection without moving the graph and pin one ghost's home file; then prove the lens-carry round trip
 * (Map → Service → UI → Map) lands the same data-id selected on every surface. Gestures dispatch
 * DOM events on the card itself (never coordinate clicks): the
 * canvas recenters with an animated fitView after every dive/relayout, so a position-based click
 * can land mid-pan — the React handlers see the same click/dblclick either way. Skips cleanly
 * when the Playwright browser is missing (`npx playwright install chromium`).
 */

import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { chromiumInstalled, generateGraphFrom, startView, FIXTURE } from "./harness";
import { join } from "node:path";

const SHOPFRONT = join(FIXTURE, "..", "shopfront");
const ROOT = "ts:src";
const SERVICES = "ts:src/services";
const FILE = "ts:src/services/cartService.ts";
const CLASS = "ts:src/services/cartService.ts#CartService";
const METHOD = `${CLASS}.addItem`;
const METHOD_STEP = `step:${METHOD}:0`;
const SERVICE_FRAME = `svc:${CLASS}`;
const SELECTION_RING_RGB = "220, 230, 242"; // frameChrome SELECTION_RING #DCE6F2

let graphDir: string | undefined;

afterAll(() => {
  if (graphDir) {
    rmSync(graphDir, { recursive: true, force: true });
  }
});

describe.skipIf(!chromiumInstalled())("cross-lens parity drive (headless chromium)", () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    const generated = generateGraphFrom(SHOPFRONT);
    graphDir = generated.dir;
    const view = await startView(generated.graphPath, 4398);
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

  it("Map: select the class, expand via its chevron — selection ring + nested member blocks", async () => {
    // Drill the containment: repo overview → src → the services folder (file cards drawn).
    await dive(page, ROOT);
    await page.waitForSelector(`[data-id="${SERVICES}"]`);
    await dive(page, SERVICES);
    await page.waitForSelector(`[data-id="${FILE}"]`);
    // Open the file frame via ITS chevron (never a navigation) so the class card is drawn…
    await chevronOf(page, FILE).dispatchEvent("click");
    await page.waitForSelector(`[data-id="${CLASS}"]`);
    // …select the class (single click; the debounced select lights the extract strip)…
    await page.locator(`[data-id="${CLASS}"]`).dispatchEvent("click");
    await expectSoleSelection(page, CLASS);
    // …and expand the class via ITS chevron: member blocks nest inside, selection survives.
    await chevronOf(page, CLASS).dispatchEvent("click");
    await page.waitForSelector(`[data-id="${METHOD}"]`);
    expect(await page.locator(`[data-id^="${CLASS}."]`).count()).toBeGreaterThan(2);
    expect(await selectedNodeIds(activeCanvasFor(page))).toEqual([CLASS]);
    expect(pageErrors).toEqual([]);
  });

  it("Map: ghost inspection selects only the ghost and preserves every ghost position", async () => {
    await page.waitForSelector(".react-flow__node-ghost");
    const ghosts = page.locator(".react-flow__node-ghost");
    const first = ghosts.first();
    const firstId = await first.getAttribute("data-id");
    expect(firstId).toBeTruthy();
    const before = await ghostGeometry(page);

    await first.dispatchEvent("click");
    // Wait beyond the click/double-click window so the sole ghost selection is stable.
    await page.waitForTimeout(350);

    await expectSoleSelection(page, firstId!);
    expect(await ghostGeometry(page)).toEqual(before);
    expect(pageErrors).toEqual([]);
  });

  it("Map: the semantic ghost '+' pins its home file as a permanent card", async () => {
    const surface = mainCanvasFor(page, CLASS);
    const promotion = surface.locator('button[aria-label="Pin to canvas"][data-ghost-id*="#"]:visible').first();
    await promotion.waitFor();
    const ghostId = await promotion.getAttribute("data-ghost-id");
    expect(ghostId).toBeTruthy();
    const homeId = ghostId!.split("#", 1)[0];
    // Semantic ancestors remain deliberately mounted for outward zoom. Assert the active painted
    // population, not a hidden parent layer which may already contain the same real home card.
    const exactGhost = surface.locator(`.react-flow__node-ghost[data-id="${ghostId}"]:visible`);
    const promotedHome = surface.locator(`.react-flow__node:not(.react-flow__node-ghost)[data-id="${homeId}"]:visible`);
    expect(await exactGhost.count()).toBe(1);
    expect(await promotedHome.count()).toBe(0);

    // The stable id binds this affordance to its exact painted satellite even when React Flow
    // virtualizes off-screen cards. Its owning file joins the level and that satellite retires.
    await promotion.dispatchEvent("click");
    await expect.poll(() => promotedHome.count(), { timeout: 20_000 }).toBe(1);
    await expect.poll(() => exactGhost.count(), { timeout: 20_000 }).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  it("lens-carry round trip: the same class lands selected on Service, UI, and back on the Map", async () => {
    // The preceding ghost test intentionally replaces the primary selection. Start this scenario
    // from its own declared anchor instead of depending on selection state leaked by an earlier
    // test: lens carry must translate CartService itself through every incoming hierarchy.
    await page.locator(`[data-id="${CLASS}"]`).dispatchEvent("click");
    await expectSoleSelection(page, CLASS);

    for (const lens of ["Service", "UI", "Map"]) {
      await lensButton(page, lens).dispatchEvent("click");
      // The carry reveals + selects the SAME data-id on the incoming lens (frames opened /
      // containment focused as that lens requires), so the extract strip stays lit on one card.
      await page.waitForSelector(`[data-id="${CLASS}"]`, { timeout: 30_000 });
      await page.getByRole("button", { name: "Extract selection (1)" }).waitFor({ timeout: 30_000 });
      expect(await selectedNodeIds(activeCanvasFor(page)), `sole selected card on the ${lens} lens`).toEqual([CLASS]);
      const mainCanvas = mainCanvasFor(page, CLASS);
      await expect.poll(() => mainCanvas.count(), { timeout: 20_000 }).toBe(1);
      // Keep a stable surface locator while the direct parent is collapsed and CLASS temporarily
      // leaves the node set; `mainCanvasFor(CLASS)` correctly stops matching during that interval.
      const activeCanvas = page.locator('[data-graph-surface="source"] .react-flow');
      await expect.poll(() => activeCanvas.count(), { timeout: 20_000 }).toBe(1);
      // Carry opens only the containing chain: Service's synthetic frame or Map/UI's file exposes
      // CartService itself, but CartService's methods must remain closed until their own action.
      const directContainer = lens === "Service" ? SERVICE_FRAME : FILE;
      const container = visibleNode(activeCanvas, directContainer);
      const members = activeCanvas.locator(`[data-id^="${CLASS}."]:visible`);
      const methodSteps = activeCanvas.locator(`[data-id^="step:${CLASS}."]:visible`);
      await expect.poll(() => container.count(), { timeout: 20_000 }).toBe(1);
      expect(await container.getByLabel("Collapse", { exact: true }).count(), `${directContainer} open on ${lens}`).toBe(1);
      expect(await members.count(), `CartService members remain closed on ${lens}`).toBe(0);

      // Replaying that parent action is deterministic on every graph lens: collapse removes the
      // class, re-expand restores the direct class only, and a separate class expansion reveals
      // its methods. This is the browser-level guard for the one-level expansion contract.
      await container.getByLabel("Collapse", { exact: true }).dispatchEvent("click");
      await expect.poll(() => visibleNode(activeCanvas, CLASS).count(), { timeout: 20_000 }).toBe(0);
      await visibleNode(activeCanvas, directContainer).getByLabel("Expand", { exact: true }).dispatchEvent("click");
      await expect.poll(() => visibleNode(activeCanvas, CLASS).count(), { timeout: 20_000 }).toBe(1);
      expect(await members.count(), `parent expansion does not cascade on ${lens}`).toBe(0);

      await visibleNode(activeCanvas, CLASS).getByLabel("Expand", { exact: true }).dispatchEvent("click");
      await expect.poll(() => members.count(), { timeout: 20_000 }).toBeGreaterThan(2);
      expect(await methodSteps.count(), `class expansion does not cascade into method flows on ${lens}`).toBe(0);

      // `addItem` has a deterministic extracted flow in the fixture. Opening it proves the next
      // explicit action reveals exactly its direct steps, while the branch nested in that flow stays
      // closed until its own chevron is used.
      await visibleNode(activeCanvas, METHOD).getByLabel("Expand", { exact: true }).dispatchEvent("click");
      await expect.poll(() => visibleNode(activeCanvas, METHOD_STEP).count(), { timeout: 20_000 }).toBe(1);
      expect(
        await activeCanvas.locator(`[data-id^="step:step:${METHOD}:"]:visible`).count(),
        `method expansion does not cascade into nested flow containers on ${lens}`,
      ).toBe(0);

      // Replay the same selection grammar on every mounted source lens: plain click replaces,
      // Ctrl adds, and Command removes. End back on CLASS so the next lens carries one stable anchor.
      await visibleNode(activeCanvas, METHOD).dispatchEvent("click");
      await expectSoleSelection(page, METHOD, activeCanvas);
      await visibleNode(activeCanvas, CLASS).dispatchEvent("click", { ctrlKey: true });
      await expectSelection(page, [CLASS, METHOD], activeCanvas);
      await visibleNode(activeCanvas, METHOD).dispatchEvent("click", { metaKey: true });
      await expectSoleSelection(page, CLASS, activeCanvas);
      await expectMiniMapParity(activeCanvas, lens);
    }

    // The extracted/minimal surface shares the same expansion reducer. Normalize the final Map
    // back to a collapsed file, extract that file, and replay the exact hierarchy once more so a
    // regression cannot hide in the overlay-specific projection/layout path.
    const sourceCanvas = page.locator('[data-graph-surface="source"] .react-flow');
    await visibleNode(sourceCanvas, METHOD).getByLabel("Collapse", { exact: true }).dispatchEvent("click");
    await expect.poll(() => visibleNode(sourceCanvas, METHOD_STEP).count(), { timeout: 20_000 }).toBe(0);
    await visibleNode(sourceCanvas, CLASS).getByLabel("Collapse", { exact: true }).dispatchEvent("click");
    await expect.poll(() => sourceCanvas.locator(`[data-id^="${CLASS}."]:visible`).count(), { timeout: 20_000 }).toBe(0);
    await visibleNode(sourceCanvas, FILE).getByLabel("Collapse", { exact: true }).dispatchEvent("click");
    await expect.poll(() => visibleNode(sourceCanvas, CLASS).count(), { timeout: 20_000 }).toBe(0);
    await visibleNode(sourceCanvas, FILE).dispatchEvent("click");
    await expectSoleSelection(page, FILE);
    await page.getByRole("button", { name: "Extract selection (1)" }).dispatchEvent("click");

    const minimalCanvas = page.locator('[data-graph-surface="minimal"] .react-flow');
    await expect.poll(() => visibleNode(minimalCanvas, FILE).count(), { timeout: 20_000 }).toBe(1);
    expect(await visibleNode(minimalCanvas, CLASS).count()).toBe(0);
    await visibleNode(minimalCanvas, FILE).getByLabel("Expand", { exact: true }).dispatchEvent("click");
    await expect.poll(() => visibleNode(minimalCanvas, CLASS).count(), { timeout: 20_000 }).toBe(1);
    const minimalMembers = minimalCanvas.locator(`[data-id^="${CLASS}."]:visible`);
    expect(await minimalMembers.count(), "file expansion does not cascade in the extracted graph").toBe(0);
    await visibleNode(minimalCanvas, CLASS).getByLabel("Expand", { exact: true }).dispatchEvent("click");
    await expect.poll(() => minimalMembers.count(), { timeout: 20_000 }).toBeGreaterThan(2);
    const minimalMethodSteps = minimalCanvas.locator(`[data-id^="step:${CLASS}."]:visible`);
    expect(await minimalMethodSteps.count(), "class expansion does not cascade in the extracted graph").toBe(0);
    await visibleNode(minimalCanvas, METHOD).getByLabel("Expand", { exact: true }).dispatchEvent("click");
    await expect.poll(() => visibleNode(minimalCanvas, METHOD_STEP).count(), { timeout: 20_000 }).toBe(1);
    expect(
      await minimalCanvas.locator(`[data-id^="step:step:${METHOD}:"]:visible`).count(),
      "method expansion does not cascade into nested flow containers in the extracted graph",
    ).toBe(0);

    await visibleNode(minimalCanvas, METHOD).dispatchEvent("click");
    await expectSoleSelection(page, METHOD, minimalCanvas);
    await visibleNode(minimalCanvas, CLASS).dispatchEvent("click", { ctrlKey: true });
    await expectSelection(page, [CLASS, METHOD], minimalCanvas);
    await visibleNode(minimalCanvas, METHOD).dispatchEvent("click", { metaKey: true });
    await expectSoleSelection(page, CLASS, minimalCanvas);
    await expectMiniMapParity(minimalCanvas, "Minimal");
    expect(pageErrors).toEqual([]);
  });
});

/** The containment dive: double-click dispatched on the card itself (viewport-motion-proof). */
function dive(page: Page, nodeId: string): Promise<void> {
  return page.locator(`[data-id="${nodeId}"]`).dispatchEvent("dblclick");
}

/** The in-card expand chevron of one drawn card (aria-label Expand; stopPropagation — never selects). */
function chevronOf(page: Page, nodeId: string): Locator {
  return page.locator(`[data-id="${nodeId}"]`).getByLabel("Expand", { exact: true });
}

/** A lens segment button inside the Lens segmented control (ViewModeToggle). */
function lensButton(page: Page, label: string): Locator {
  return page.getByLabel("Lens").getByRole("button", { name: label, exact: true });
}

/** Resolve the primary lens canvas by a carried node, never by DOM order. */
function mainCanvasFor(page: Page, anchorId: string): Locator {
  return page.locator(".react-flow").filter({ has: page.locator(`.react-flow__node[data-id="${anchorId}"]`) });
}

/** One visible card on a known surface; semantic parent layers may keep hidden copies mounted. */
function visibleNode(surface: Locator, nodeId: string): Locator {
  return surface.locator(`.react-flow__node[data-id="${nodeId}"]:visible`);
}

/** The one interactive canvas: the source while uncovered, otherwise the extracted overlay. */
function activeCanvasFor(page: Page): Locator {
  return page.locator(
    '[data-graph-surface="source"]:not([inert]) .react-flow, [data-graph-surface="minimal"] .react-flow',
  );
}

/** The active module surface draws every controlled React Flow node once in its own MiniMap. */
async function expectMiniMapParity(surface: Locator, lens: string): Promise<void> {
  const canvasNodes = surface.locator(".react-flow__nodes > .react-flow__node");
  const miniMap = surface.locator('[data-testid="rf__minimap"]');
  await expect.poll(() => miniMap.count(), { timeout: 20_000 }).toBe(1);
  await expect.poll(() => canvasNodes.count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const [canvasCount, miniMapCount] = await Promise.all([
        canvasNodes.count(),
        miniMap.locator(".react-flow__minimap-node").count(),
      ]);
      return canvasCount === miniMapCount ? "match" : `${canvasCount} canvas / ${miniMapCount} minimap`;
    }, { timeout: 20_000 })
    .toBe("match");
  const [canvasCount, miniMapCount] = await Promise.all([
    canvasNodes.count(),
    miniMap.locator(".react-flow__minimap-node").count(),
  ]);
  expect(miniMapCount, `MiniMap nodes on the ${lens} lens`).toBe(canvasCount);
}

/** Every graph node obeys one selection contract: the target is selected and it is the only selection. */
async function expectSoleSelection(page: Page, nodeId: string, surface = activeCanvasFor(page)): Promise<void> {
  await expectSelection(page, [nodeId], surface);
}

/** The exact selected set on one visible surface, plus the source canvas's extraction count. */
async function expectSelection(page: Page, nodeIds: string[], surface = activeCanvasFor(page)): Promise<void> {
  const expected = [...nodeIds].sort();
  if (await page.locator('[data-graph-surface="minimal"]').count() === 0) {
    await page
      .getByRole("group", { name: "Canvas actions" })
      .getByRole("button", { name: `Extract selection (${expected.length})`, exact: true })
      .waitFor();
  }
  // Selection is intentionally delayed to arbitrate a real double-click. Poll the visible chrome:
  // an already-present Extract(1) may still describe the node this click is replacing.
  await expect.poll(() => selectedNodeIds(surface), { timeout: 5_000 }).toEqual(expected);
}

/** Every visible real-card ring or ghost aria-selection, deduped and sorted. */
function selectedNodeIds(surface: Locator): Promise<string[]> {
  return surface.locator(".react-flow__node[data-id]:visible").evaluateAll(
    (elements, rgb) => elements
      .filter((element) => {
        if (element.classList.contains("react-flow__node-ghost")) {
          return element.querySelector('[role="button"][aria-pressed="true"]') !== null;
        }
        return [element, ...element.querySelectorAll("div")]
          .some((box) => getComputedStyle(box as Element).boxShadow.includes(rgb));
      })
      .map((element) => element.getAttribute("data-id"))
      .filter((id): id is string => id !== null)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .sort(),
    SELECTION_RING_RGB,
  );
}

/** Stable-position regression: both the viewport and every ghost wrapper transform must be exact. */
async function ghostGeometry(page: Page): Promise<{ viewport: string | null; ghosts: Array<{ id: string | null; transform: string }> }> {
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  const ghosts = await page.locator(".react-flow__node-ghost").evaluateAll((elements) =>
    elements
      .map((element) => ({ id: element.getAttribute("data-id"), transform: (element as HTMLElement).style.transform }))
      .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? "")),
  );
  return { viewport, ghosts };
}
