/**
 * Cross-lens PARITY drive (unified-canvas phase E), the e2e layer behind the renderer's
 * surfaceParity suite: serve examples/shopfront (it has a real render tree, so all three lenses
 * have substance) through the built CLI and replay the SAME gestures per lens — select a class,
 * expand via the chevron, assert the selection ring + expansion; pin a ghost "+" on the Map; and
 * prove the lens-carry round trip (Map → Service → UI → Map) lands the same data-id selected on
 * every surface. Gestures dispatch DOM events on the card itself (never coordinate clicks): the
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
    await page.waitForSelector('button:has-text("Extract selection (1)")');
    expect(await hasSelectionRing(page, CLASS)).toBe(true);
    // …and expand the class via ITS chevron: member blocks nest inside, selection survives.
    await chevronOf(page, CLASS).dispatchEvent("click");
    await page.waitForSelector(`[data-id="${CLASS}.addItem"]`);
    expect(await page.locator(`[data-id^="${CLASS}."]`).count()).toBeGreaterThan(2);
    expect(await hasSelectionRing(page, CLASS)).toBe(true);
    expect(pageErrors).toEqual([]);
  });

  it("Map: the ghost '+' pins the ghost's home files as permanent cards", async () => {
    // The selection lights CartService's off-canvas deps as folder group-ghosts (utils/, repository/…).
    const GHOST = "ts:src/utils";
    await page.waitForSelector(`.react-flow__node-ghost[data-id="${GHOST}"]`);
    const ghosts = await page.locator(".react-flow__node-ghost").all();
    const ghostIds = await Promise.all(ghosts.map((ghost) => ghost.getAttribute("data-id")));
    // Pin the utils group-ghost via its "+" (ring buttons follow ghost order): its CONTRIBUTING
    // home files join the level as REAL cards (mapExtra), wired where the ghost charted…
    await page.getByLabel("Pin to canvas").nth(ghostIds.indexOf(GHOST)).dispatchEvent("click");
    await page.waitForSelector(`.react-flow__node[data-id^="${GHOST}/"]:not(.react-flow__node-ghost)`);
    // …and with every charted fact now drawn, the group-ghost itself retires.
    await expect.poll(() => page.locator(`.react-flow__node-ghost[data-id="${GHOST}"]`).count(), { timeout: 20_000 }).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  it("lens-carry round trip: the same class lands selected on Service, UI, and back on the Map", async () => {
    for (const lens of ["Service", "UI", "Map"]) {
      await lensButton(page, lens).dispatchEvent("click");
      // The carry reveals + selects the SAME data-id on the incoming lens (frames opened /
      // containment focused as that lens requires), so the extract strip stays lit on one card.
      await page.waitForSelector(`[data-id="${CLASS}"]`, { timeout: 30_000 });
      await page.waitForSelector('button:has-text("Extract selection (1)")', { timeout: 30_000 });
      expect(await hasSelectionRing(page, CLASS), `selection ring on the ${lens} lens`).toBe(true);
      const mainCanvas = mainCanvasFor(page, CLASS);
      await expect.poll(() => mainCanvas.count(), { timeout: 20_000 }).toBe(1);
      // The chevron gesture keeps working on every lens: expanding any collapsed container
      // (a cluster frame on Service, a file card on Map/UI) grows the drawn node set.
      const mainNodes = mainCanvas.locator(".react-flow__nodes > .react-flow__node");
      const before = await mainNodes.count();
      const chevron = mainCanvas.getByLabel("Expand", { exact: true }).first();
      expect(await chevron.count(), `a collapsed container to expand on the ${lens} lens`).toBe(1);
      await chevron.dispatchEvent("click");
      await expect.poll(() => mainNodes.count(), { timeout: 20_000 }).toBeGreaterThan(before);
      await expectMiniMapParity(mainCanvas, lens);
    }
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
      return canvasCount === miniMapCount;
    }, { timeout: 20_000 })
    .toBe(true);
  const [canvasCount, miniMapCount] = await Promise.all([
    canvasNodes.count(),
    miniMap.locator(".react-flow__minimap-node").count(),
  ]);
  expect(miniMapCount, `MiniMap nodes on the ${lens} lens`).toBe(canvasCount);
}

/** Whether the card wears the shared neutral selection ring (frameChrome SELECTION_RING). */
function hasSelectionRing(page: Page, nodeId: string): Promise<boolean> {
  return page
    .locator(`[data-id="${nodeId}"]`)
    .evaluate(
      (el, rgb) => [el, ...el.querySelectorAll("div")].some((box) => getComputedStyle(box as Element).boxShadow.includes(rgb)),
      SELECTION_RING_RGB,
    );
}
