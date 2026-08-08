/**
 * One ordered browser journey through the complete GitHub PR-review loop: synchronous base review,
 * opt-in head extraction, progress and comments, URL restore, layered Escape, and resume.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { buildNodeId } from "@meridian/core";
import { createWebService, type WebService } from "../src/server/web-server";
import {
  PYTHON_REVIEW_PATH,
  RENDERER_INDEX,
  buildPrReviewFixture,
  chromiumInstalled,
  ensureBuilt,
  listenServer,
  nodeHeader,
  startSmartGitServer,
  verifySmartHttpRemote,
  type PrReviewFixture,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const DRAFT_TEXT = "Please keep this tier boundary explicit.";
const EDITED_DRAFT_TEXT = "Please keep this tier boundary explicit and documented.";
const SECOND_DRAFT_TEXT = "Please cover the standard-tier fallback with a focused test.";
const WRAPPING_COMMENT_TOKEN = "previous_browser_prefix_allowlist_configuration_that_must_remain_readable_without_resizing_the_comment_overlay";
const EXISTING_COMMENT_TEXT = `Should this threshold stay aligned with the billing tier for every existing customer configuration, including installations that still rely on the previous browser-prefix allowlist behavior? ${WRAPPING_COMMENT_TOKEN}`;
const EDITED_EXISTING_COMMENT_TEXT = "Keep this threshold aligned with the billing tier.";
const THREAD_REPLY_TEXT = "Agreed — I will keep the two thresholds together.";
const SOURCE_COMMENT_TEXT = "// Keep the loyalty threshold explicit before choosing the customer's tier.";
const SOURCE_COMMENT_LINE = 2;
const LOYALTY_RETURN_LINE = 3;
const EXISTING_COMMENT_LINE = LOYALTY_RETURN_LINE;
const SOURCE_SEARCH_SHORTCUT = process.platform === "darwin" ? "Meta+f" : "Control+f";
const MODIFIED_SOURCE_SEARCH_SHORTCUT = process.platform === "darwin" ? "Meta+Shift+f" : "Control+Shift+f";
const ORDER_SERVICE_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/services/orderService.ts" });
const PRICING_PACKAGE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing" });
const PRICING_SERVICE_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing/pricingService.ts" });
const EXECUTION_GALLERY_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/showcase/executionGraphGallery.ts" });
const LOYALTY_TIERS_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing/loyaltyTiers.ts" });
const LOYALTY_TIER_FUNCTION_ID = buildNodeId({
  lang: "ts",
  modulePath: "src/pricing/loyaltyTiers.ts",
  qualname: "loyaltyTierFor",
});
const PYTHON_RISK_FUNCTION_ID = buildNodeId({
  lang: "py",
  modulePath: "backend.features.risk.engines.rules.deep.risk",
  qualname: "risk_label",
});
const PYTHON_RISK_SIGNATURE = "def risk_label(order_count: int) -> str:";
const nativeFetch = globalThis.fetch.bind(globalThis);

interface SubmittedReview {
  event: string;
  body?: string;
  commit_id?: string;
  comments: Array<{ path: string; line: number; side: string; body: string }>;
}

interface ViewedFileMutation {
  path: string;
  viewed: boolean;
}

let fixture: PrReviewFixture | undefined;
let smartGitServer: Server | undefined;
let webService: WebService | undefined;
let browser: Browser | undefined;
let page: Page;
let viewUrl = "";
let restoreGitRedirect: (() => void) | undefined;
const submittedReviews: SubmittedReview[] = [];
const viewedFileMutations: ViewedFileMutation[] = [];

describe.skipIf(!chromiumInstalled())("pull-request review (headless chromium)", () => {
  beforeAll(setup, 180_000);
  afterAll(teardown);

  it("completes the full review journey in order", async () => {
    // 4a — load the GitHub session, enter the PR page, and select PR #7.
    await page.goto(viewUrl, { waitUntil: "networkidle" });
    await page.getByText("1 open", { exact: true }).waitFor();
    await page.getByTitle("Open the full Pull requests page").click();
    await page.getByRole("heading", { name: "Pull requests" }).waitFor();
    const prCard = page.getByText("#7", { exact: true }).locator("xpath=ancestor::button[1]");
    await prCard.waitFor();
    expect(await prCard.innerText()).toContain("pr-head");
    await prCard.click();

    // 4b — the real-patch response has exactly three files across TypeScript and Python, then
    // prepares the mixed-language HEAD graph before opening the review.
    const detail = page.locator("aside.mrd-scroll");
    const detailFiles = detail.locator(
      `[title="src/pricing/loyaltyTiers.ts"], [title="src/services/orderService.ts"], [title="${PYTHON_REVIEW_PATH}"]`,
    );
    await detailFiles.first().waitFor();
    expect(await detailFiles.count()).toBe(3);
    await detail.getByRole("button", { name: "Review in graph" }).click();
    const preparing = page.getByText("Preparing PR review", { exact: true });
    const reviewFiles = page.getByText("Files changed", { exact: true });
    await Promise.race([
      preparing.waitFor({ timeout: 1_000 }).catch(() => undefined),
      reviewFiles.waitFor({ timeout: 120_000 }),
    ]);
    await reviewFiles.waitFor({ timeout: 120_000 });
    const syncProvenance = page.getByText(/^pr-head → main · head graph @[0-9a-f]{7}$/);
    await syncProvenance.waitFor({ timeout: 120_000 });
    const initialReviewGraph = page.getByRole("region", { name: "Extracted graph" });
    await initialReviewGraph.waitFor();
    expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);

    // A review bar always owns the bottom lane instead of floating one full MiniMap-height above
    // it. Wide panes show the complete bar; narrower panes compact secondary controls behind More.
    // Both presentations remain contained by the graph side of the review split and clear chrome.
    await page.setViewportSize({ width: 2000, height: 900 });
    const initialActionBar = initialReviewGraph.getByRole("group", { name: "Canvas actions" });
    await expect.poll(async () => {
      const [surface, bar, legend, minimap, reviewPane] = await Promise.all([
        initialReviewGraph.boundingBox(),
        initialActionBar.boundingBox(),
        initialReviewGraph.getByRole("button", { name: /Legend/ }).boundingBox(),
        initialReviewGraph.locator(".react-flow__minimap").boundingBox(),
        page.locator("#meridian-pr-review-pane").boundingBox(),
      ]);
      if (surface === null || bar === null || legend === null || minimap === null || reviewPane === null) return null;
      return {
        surfaceWideEnoughForLegend: surface.width >= 1400,
        bottomInset: Math.round(surface.y + surface.height - bar.y - bar.height),
        insideGraph: bar.x >= surface.x && bar.x + bar.width <= surface.x + surface.width,
        clearsChrome: bar.x + bar.width <= Math.min(legend.x, minimap.x) - 15,
        clearsReviewPane: bar.x + bar.width <= reviewPane.x,
      };
    }, { timeout: 5_000 }).toEqual({
      surfaceWideEnoughForLegend: true,
      bottomInset: 16,
      insideGraph: true,
      clearsChrome: true,
      clearsReviewPane: true,
    });
    const legendButton = initialReviewGraph.getByRole("button", { name: /Legend/ });
    await legendButton.focus();
    await page.keyboard.press("Enter");
    const openLegend = initialReviewGraph.getByRole("region", { name: "Map legend" });
    await openLegend.waitFor();
    const closeLegend = openLegend.getByTitle("Close");
    await expect.poll(() => closeLegend.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await openLegend.waitFor({ state: "detached" });
    await expect.poll(() => legendButton.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await openLegend.waitFor();
    await expect.poll(() => closeLegend.evaluate((element) => element === document.activeElement)).toBe(true);
    await expect.poll(async () => {
      const [surface, bar, legend, minimap] = await Promise.all([
        initialReviewGraph.boundingBox(),
        initialActionBar.boundingBox(),
        openLegend.boundingBox(),
        initialReviewGraph.locator(".react-flow__minimap").boundingBox(),
      ]);
      if (surface === null || bar === null || legend === null || minimap === null) return null;
      return {
        bottomInset: Math.round(surface.y + surface.height - bar.y - bar.height),
        clearsOpenLegend: bar.x + bar.width <= Math.min(legend.x, minimap.x) - 15,
        noHorizontalOverflow: await initialActionBar.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      };
    }, { timeout: 5_000 }).toEqual({
      bottomInset: 16,
      clearsOpenLegend: true,
      noHorizontalOverflow: true,
    });
    await closeLegend.focus();
    await page.setViewportSize({ width: 1800, height: 900 });
    await openLegend.waitFor({ state: "detached" });
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("Recenter view");
    await page.setViewportSize({ width: 2000, height: 900 });
    await legendButton.waitFor();
    await page.setViewportSize({ width: 900, height: 900 });
    const compactActionBar = initialReviewGraph.getByRole("group", { name: "Canvas actions" });
    const moreCanvasActions = compactActionBar.getByRole("button", { name: "More canvas actions" });
    await moreCanvasActions.waitFor();
    await expect.poll(async () => {
      const [surface, bar, legendCount, minimapHidden, controls, reviewPane] = await Promise.all([
        initialReviewGraph.boundingBox(),
        compactActionBar.boundingBox(),
        initialReviewGraph.getByRole("button", { name: /Legend/ }).count(),
        initialReviewGraph.locator(".react-flow__minimap").isHidden(),
        initialReviewGraph.locator(".react-flow__controls").boundingBox(),
        page.locator("#meridian-pr-review-pane").boundingBox(),
      ]);
      if (surface === null || bar === null || controls === null || reviewPane === null) return null;
      return {
        bottomInset: Math.round(surface.y + surface.height - bar.y - bar.height),
        insideGraph: bar.x >= surface.x && bar.x + bar.width <= surface.x + surface.width,
        retiredPassiveChrome: legendCount === 0 && minimapHidden,
        clearsControls: bar.x + bar.width <= controls.x - 15,
        clearsReviewPane: bar.x + bar.width <= reviewPane.x,
      };
    }, { timeout: 5_000 }).toEqual({
      bottomInset: 16,
      insideGraph: true,
      retiredPassiveChrome: true,
      clearsControls: true,
      clearsReviewPane: true,
    });
    expect(await compactActionBar.getByRole("button", { name: "Code previews", exact: true }).count()).toBe(0);
    for (const directAction of [
      "Recenter view",
      "Remove added nodes in selection",
      "Back to previous graph",
      "Filter edge types",
      "Highlight code in codebase",
      "Close extracted graph",
    ]) {
      await compactActionBar.getByRole("button", { name: directAction, exact: true }).waitFor();
    }
    expect(await moreCanvasActions.getAttribute("aria-haspopup")).toBe("dialog");
    expect(await moreCanvasActions.getAttribute("aria-expanded")).toBe("false");
    const controlledDialogId = await moreCanvasActions.getAttribute("aria-controls");
    expect(controlledDialogId).toBeTruthy();
    await moreCanvasActions.focus();
    await page.keyboard.press("Enter");
    const moreActionsDialog = page.getByRole("dialog", { name: "More canvas actions" });
    expect(await moreActionsDialog.getAttribute("id")).toBe(controlledDialogId);
    await expect.poll(() => moreCanvasActions.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => moreActionsDialog.evaluate((element) => element === document.activeElement)).toBe(true);
    for (const overflowAction of [
      "Expand selection by one level",
      "Expand one level",
      "Collapse all",
      "Collapse all viewed nodes",
      "Show ghost nodes",
      "Filter unrelated ghost nodes",
      "Code previews",
      "Highways",
      "Rearrange extracted graph",
      "Reset extracted graph",
    ]) {
      await moreActionsDialog.getByRole("button", { name: overflowAction, exact: true }).waitFor();
    }
    await page.keyboard.press("Tab");
    await expect.poll(() => moreActionsDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const compactCodePreviewToggle = moreActionsDialog.getByRole("button", { name: "Code previews", exact: true });
    await expect.poll(() => compactCodePreviewToggle.getAttribute("aria-pressed")).toBe("true");
    await compactCodePreviewToggle.click();
    await expect.poll(() => compactCodePreviewToggle.getAttribute("aria-pressed")).toBe("false");
    await compactCodePreviewToggle.click();
    await expect.poll(() => compactCodePreviewToggle.getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("Escape");
    await moreActionsDialog.waitFor({ state: "detached" });
    await expect.poll(() => moreCanvasActions.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => moreCanvasActions.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await moreActionsDialog.waitFor();
    await page.setViewportSize({ width: 2000, height: 900 });
    await moreActionsDialog.waitFor({ state: "detached" });
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("Recenter view");
    const directCodePreview = initialActionBar.getByRole("button", { name: "Code previews", exact: true });
    await directCodePreview.focus();
    await page.setViewportSize({ width: 900, height: 900 });
    await moreCanvasActions.waitFor();
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("More canvas actions");
    await page.setViewportSize({ width: 2000, height: 900 });
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    ).toBe("Recenter view");
    await page.setViewportSize({ width: 1400, height: 900 });

    // The whole-codebase overview is an alternate read-only surface, not a review close/reopen:
    // the prepared HEAD artifact, change colours, and review rail stay live, while its chevrons
    // disclose context locally without changing the hidden extracted graph's expansion state.
    await page.getByRole("button", { name: "Highlight code in codebase" }).click();
    const codebaseContext = page.getByRole("region", { name: "Codebase context graph" });
    await codebaseContext.getByText("READ-ONLY", { exact: true }).waitFor();
    const codebasePreviewToggle = codebaseContext
      .getByRole("group", { name: "Canvas actions" })
      .getByRole("group", { name: "Codebase view actions" })
      .getByRole("button", { name: "Code previews", exact: true });
    expect(await codebasePreviewToggle.getAttribute("aria-pressed")).toBe("true");
    await codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor();
    await codebaseContext.locator(`.react-flow__node[data-id="${ORDER_SERVICE_MODULE_ID}"]`).waitFor();
    const unchangedModule = codebaseContext.locator(`.react-flow__node[data-id="${PRICING_SERVICE_MODULE_ID}"]`);
    await unchangedModule.waitFor();
    const changedFunction = codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await changedFunction.waitFor();
    const contextPythonRisk = codebaseContext.locator(`.react-flow__node[data-id="${PYTHON_RISK_FUNCTION_ID}"]`);
    await contextPythonRisk.waitFor();
    await expect.poll(
      () => changedFunction.evaluate((element) => {
        const root = element.firstElementChild;
        const surface = root?.classList.contains("review-node-viewed-shell") ? root.firstElementChild : root;
        return surface === null ? "none" : getComputedStyle(surface).backgroundImage;
      }),
    ).not.toBe("none");
    await waitForGraphViewportToSettle(codebaseContext);
    await page.mouse.move(0, 0);
    expect(await syncProvenance.count()).toBe(1);
    expect(await page.getByText("Files changed", { exact: true }).count()).toBe(1);

    // A nested preview remains reachable even when the pointer crosses its previewable parent.
    await changedFunction.hover();
    const contextLoyaltyPreview = page.getByRole("dialog", { name: "Code preview for loyaltyTierFor" });
    await contextLoyaltyPreview.waitFor();
    await contextLoyaltyPreview.getByText("src/pricing/loyaltyTiers.ts", { exact: true }).waitFor();
    await contextLoyaltyPreview.hover();
    expect(await contextLoyaltyPreview.isVisible()).toBe(true);
    // Hover source is available throughout an active review, including nodes untouched by its diff.
    await unchangedModule.hover();
    const codePreview = page.getByRole("dialog", { name: /^Code preview for / });
    await codePreview.getByText("src/pricing/pricingService.ts", { exact: true }).waitFor();
    await codePreview.getByText("export class PricingService {", { exact: true }).waitFor();
    await page.getByText("Files changed", { exact: true }).hover();
    await codePreview.waitFor({ state: "detached" });

    const expansionParam = new URL(page.url()).searchParams.get("mexp");
    const pricingContext = codebaseContext.locator(`.react-flow__node[data-id="${PRICING_PACKAGE_ID}"]`);
    await pricingContext.getByRole("button", { name: "Collapse" }).click();
    await codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor({ state: "detached" });
    await codebaseContext.locator(`.react-flow__node[data-id="${ORDER_SERVICE_MODULE_ID}"]`).waitFor();
    await pricingContext.getByRole("button", { name: "Expand" }).click();
    await codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor();
    await changedFunction.waitFor();
    expect(new URL(page.url()).searchParams.get("mexp")).toBe(expansionParam);
    await page.getByRole("button", { name: "Back to extracted graph" }).click();
    await page.getByRole("region", { name: "Extracted graph" }).waitFor();
    await syncProvenance.waitFor();

    // 4c — changed files are immediately reviewable, while an unchanged module outside the
    // prepared slice must hydrate its depth-one neighbourhood before it can be added. The deeply
    // nested Python callable opens the actual head source.
    const extractedReviewSurface = page.getByRole("region", { name: "Extracted graph" });
    const paletteAddition = extractedReviewSurface.locator(
      `.react-flow__node:not(.react-flow__node-ghost)[data-id="${EXECUTION_GALLERY_MODULE_ID}"]`,
    );
    expect(await paletteAddition.count()).toBe(0);
    await page.keyboard.press("Control+P");
    const palette = page.getByRole("dialog", { name: "Reveal or add a node in the current view" });
    await palette.waitFor();
    await palette.locator("input").fill("executionGraphGallery.ts");
    const paletteRow = palette.locator(`[data-symbol-id="${EXECUTION_GALLERY_MODULE_ID}"]`);
    await paletteRow.getByRole("button", { name: "Load nearby graph for executionGraphGallery.ts" }).click();
    await palette.locator(
      `[data-symbol-id="${EXECUTION_GALLERY_MODULE_ID}"][data-symbol-readiness="ready"]`,
    ).waitFor({ timeout: 30_000 });
    const addPaletteNode = paletteRow.getByRole("button", {
      name: "Add executionGraphGallery.ts to the current view",
    });
    expect(await addPaletteNode.isEnabled()).toBe(true);
    await addPaletteNode.click();
    await paletteAddition.waitFor({ timeout: 30_000 });
    expect(await palette.isVisible()).toBe(true);
    await page.keyboard.press("Control+P");
    await palette.waitFor({ state: "detached" });

    const pythonRiskNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${PYTHON_RISK_FUNCTION_ID}"]`);
    await pythonRiskNode.waitFor();
    const addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    const addedBlock = addedFile.locator("xpath=../..");
    const addedViewedControl = addedBlock.getByTitle("Mark file as viewed");
    await addedViewedControl.waitFor();
    expect(await addedViewedControl.count()).toBe(1);
    expect(await addedFile.getByText("added — extract head to view", { exact: true }).count()).toBe(0);

    const pythonFile = reviewFileButton(page, PYTHON_REVIEW_PATH);
    const pythonViewedControl = pythonFile.locator("xpath=../..").getByTitle("Mark file as viewed");
    await pythonViewedControl.waitFor();
    expect(await pythonViewedControl.count()).toBe(1);
    await pythonRiskNode.getByRole("button", { name: "View source" }).click();
    const pythonSourceDialog = page.getByRole("dialog", { name: "Source code" });
    await pythonSourceDialog.waitFor();
    await pythonSourceDialog.getByText(PYTHON_RISK_SIGNATURE, { exact: true }).waitFor();
    await pythonSourceDialog.getByRole("button", { name: "Open source search" }).focus();
    await page.keyboard.press("Escape");
    await pythonSourceDialog.waitFor({ state: "detached" });

    // 4d — existing GitHub comments live on their HEAD source line in both canvas code hosts;
    // the review-panel control hides and restores that layer without disabling either host.
    const loyaltyTierNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await loyaltyTierNode.waitFor();

    // A graph-node selection offers a local affected-flow filter. It keeps the block's own flow and
    // direct callers, removes unrelated review stories, and disappears again with the selection.
    const affectedFlows = page.getByRole("region", { name: "Affected logic flows list" });
    const affectedFlowsDisclosure = page.getByTitle("Affected logic flows: changed or reaches changed code");
    const affectedFlowRows = affectedFlows.getByRole("button", { name: /^View sequence for / });
    const allAffectedFlowNames = await affectedFlowRows.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")));
    const allAffectedHeaderText = await affectedFlowsDisclosure.textContent();
    expect(allAffectedFlowNames).toContain("View sequence for loyaltyTierFor");
    expect(allAffectedFlowNames).toContain("View sequence for reviewFixtureMarker");
    await nodeHeader(loyaltyTierNode).click();
    const relatedOnly = page.getByRole("button", { name: "Show only flows related to loyaltyTierFor" });
    await relatedOnly.waitFor();
    expect(await relatedOnly.getAttribute("aria-pressed")).toBe("false");
    await relatedOnly.click();
    expect(await relatedOnly.getAttribute("aria-pressed")).toBe("true");
    expect(await affectedFlowsDisclosure.textContent()).toBe(allAffectedHeaderText);
    await expect.poll(() => affectedFlowRows.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(["View sequence for loyaltyTierFor"]);
    await relatedOnly.click();
    await expect.poll(() => affectedFlowRows.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(allAffectedFlowNames);
    await clickBareCanvas(page, extractedReviewSurface);
    await relatedOnly.waitFor({ state: "detached" });

    const loyaltyCommentToolbar = extractedReviewSurface.locator(`[data-review-comment-node-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    const loyaltyCommentIndicator = loyaltyCommentToolbar.getByRole("button", { name: "1 review comment" });
    await loyaltyCommentIndicator.waitFor();
    expect(await extractedReviewSurface.locator(`[data-review-comment-node-id="${ORDER_SERVICE_MODULE_ID}"]`).count()).toBe(0);

    // Comment chrome is screen-space UI, not graph content: the hit target and open card keep exact
    // dimensions as the viewport zoom changes. The container remains horizontally scrollable, while
    // long comment text wraps onto the next line without widening or escaping its bordered card.
    const commentTooltip = loyaltyCommentToolbar.getByRole("tooltip");
    const commentScroller = commentTooltip;
    await loyaltyCommentIndicator.hover();
    await commentTooltip.waitFor();
    const commentOverlayAtReadingZoom = await reviewCommentOverlayMetrics(loyaltyCommentIndicator, commentTooltip, commentScroller);
    expect(commentOverlayAtReadingZoom.tooltip.width).toBeCloseTo(310, 0);
    expect(commentOverlayAtReadingZoom.tooltip.height).toBeCloseTo(300, 0);
    expect(commentOverlayAtReadingZoom.overflowX).toBe("auto");
    expect(commentOverlayAtReadingZoom.scrollerScrollWidth).toBeLessThanOrEqual(commentOverlayAtReadingZoom.scrollerClientWidth + 1);
    expect(commentOverlayAtReadingZoom.cardScrollWidth).toBeLessThanOrEqual(commentOverlayAtReadingZoom.cardClientWidth + 1);
    expect(commentOverlayAtReadingZoom.bodyScrollWidth).toBeLessThanOrEqual(commentOverlayAtReadingZoom.bodyClientWidth + 1);
    expect(commentOverlayAtReadingZoom.bodyOverflowWrap).toBe("anywhere");
    expect(commentOverlayAtReadingZoom.wrappedTokenLineCount).toBeGreaterThan(1);
    await page.mouse.move(0, 0);
    await commentTooltip.waitFor({ state: "detached" });

    const zoomOutForCommentCheck = extractedReviewSurface.locator(".react-flow__controls-zoomout");
    await zoomOutForCommentCheck.click();
    await waitForGraphViewportToSettle(extractedReviewSurface);
    await loyaltyCommentIndicator.hover();
    await commentTooltip.waitFor();
    const commentOverlayAfterZoom = await reviewCommentOverlayMetrics(loyaltyCommentIndicator, commentTooltip, commentScroller);
    expect(Math.abs(commentOverlayAfterZoom.indicator.width - commentOverlayAtReadingZoom.indicator.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(commentOverlayAfterZoom.indicator.height - commentOverlayAtReadingZoom.indicator.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(commentOverlayAfterZoom.tooltip.width - commentOverlayAtReadingZoom.tooltip.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(commentOverlayAfterZoom.tooltip.height - commentOverlayAtReadingZoom.tooltip.height)).toBeLessThanOrEqual(1);
    await page.mouse.move(0, 0);
    await commentTooltip.waitFor({ state: "detached" });
    await extractedReviewSurface.locator(".react-flow__controls-zoomin").click();
    await waitForGraphViewportToSettle(extractedReviewSurface);

    await loyaltyTierNode.hover();
    const loyaltyPreview = page.getByRole("dialog", { name: "Code preview for loyaltyTierFor" });
    await loyaltyPreview.waitFor();
    await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

    // Ordinary preview actions remain transient: toggling viewed must not introduce a second
    // pinned mode, extra close affordance, or a card that survives the hover-close grace.
    const previewViewedButton = loyaltyPreview.locator(".review-node-viewed-button");
    expect(await previewViewedButton.count()).toBe(1);
    await previewViewedButton.click();
    expect(await loyaltyPreview.getByText("Pinned", { exact: true }).count()).toBe(0);
    expect(await loyaltyPreview.getByRole("button", { name: "Close code preview" }).count()).toBe(0);
    await previewViewedButton.click();
    await expect.poll(() => [...viewedFileMutations]).toEqual([
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
    ]);
    await page.getByText("Files changed", { exact: true }).hover();
    await page.waitForTimeout(500);
    await loyaltyPreview.waitFor({ state: "detached" });
    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();

    const sourceCommentRow = loyaltyPreview.locator(`tr[data-source-line="${SOURCE_COMMENT_LINE}"]`);
    const loyaltyReturnRow = loyaltyPreview.locator(`tr[data-source-line="${LOYALTY_RETURN_LINE}"]`);
    await sourceCommentRow.getByText(SOURCE_COMMENT_TEXT, { exact: true }).waitFor();
    expect(await sourceCommentRow.getAttribute("data-diff-origin")).toBe("add");
    expect(await loyaltyReturnRow.getAttribute("data-diff-origin")).toBe("add");

    const hideComments = page.getByRole("button", { name: "Hide comments on canvas", exact: true });
    await hideComments.waitFor();
    expect(await hideComments.getAttribute("aria-pressed")).toBe("true");
    await hideComments.click();
    await loyaltyPreview.waitFor({ state: "detached" });
    await loyaltyCommentIndicator.waitFor({ state: "detached" });
    const viewComments = page.getByRole("button", { name: "Show comments on canvas", exact: true });
    await viewComments.waitFor();
    expect(await viewComments.getAttribute("aria-pressed")).toBe("false");

    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();
    expect(await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).count()).toBe(0);
    await viewComments.click();
    await loyaltyPreview.waitFor({ state: "detached" });
    await loyaltyCommentIndicator.waitFor();
    await hideComments.waitFor();
    expect(await hideComments.getAttribute("aria-pressed")).toBe("true");

    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();
    await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

    // Starting a line comment keeps the default hover preview stable while the draft is active.
    // Pointer movement past the full hover-close grace preserves the exact draft, and adding it
    // keeps the card open with Pending confirmation until the reader dismisses it from the canvas.
    const inlineRange = fixture!.files[0].headerHunks[0];
    const firstInlineLine = inlineRange.start;
    const secondInlineLine = inlineRange.end;
    expect(secondInlineLine).toBeGreaterThan(firstInlineLine);
    const previewSourceRow = loyaltyPreview.locator(`tr[data-source-line="${firstInlineLine}"]`);
    const previewLineAction = previewSourceRow.getByRole("button", {
      name: `Comment on line ${firstInlineLine}`,
      exact: true,
    });
    expect(await lineActionStyle(previewLineAction)).toEqual({ opacity: "0", pointerEvents: "none" });
    await previewSourceRow.hover();
    await expect.poll(() => lineActionStyle(previewLineAction)).toEqual({ opacity: "1", pointerEvents: "auto" });
    // Click the code itself: this is the compact-card path people naturally use, and guards
    // against regressing to a hidden, tiny gutter-only target.
    await previewSourceRow.locator(`[data-source-code-cell="${firstInlineLine}"]`).click();
    const previewDraft = loyaltyPreview.getByPlaceholder(`Comment on line ${firstInlineLine}…`);
    await previewDraft.waitFor();
    expect(await previewDraft.evaluate((element) => element === document.activeElement)).toBe(true);
    await previewDraft.fill(DRAFT_TEXT);
    await page.getByText("Files changed", { exact: true }).hover();
    await page.waitForTimeout(500);
    expect(await loyaltyPreview.isVisible()).toBe(true);
    expect(await previewDraft.inputValue()).toBe(DRAFT_TEXT);
    await loyaltyPreview.getByRole("button", { name: "Add comment", exact: true }).click();
    const previewPendingDraft = loyaltyPreview.locator(`[data-pending-review-comments-line="${firstInlineLine}"]`);
    await previewPendingDraft.getByText(DRAFT_TEXT, { exact: true }).waitFor();
    await previewPendingDraft.getByText("Pending", { exact: true }).waitFor();
    expect(await loyaltyPreview.isVisible()).toBe(true);
    await clickBareCanvas(page, extractedReviewSurface);
    await loyaltyPreview.waitFor({ state: "detached" });

    // Agent-authored source explanations can be removed from the review surface. The preference
    // omits a full-line source comment while the changed code that follows stays marked as added.
    const preferencesButton = page.getByRole("button", { name: "Review preferences" });
    await preferencesButton.click();
    const preferencesPane = page.getByRole("region", { name: "Review preferences" });
    const hideSourceCommentDiff = preferencesPane.getByRole("checkbox", { name: /^Hide source comments in diffs/ });
    expect(await hideSourceCommentDiff.isChecked()).toBe(false);
    await hideSourceCommentDiff.check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();
    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();
    await sourceCommentRow.waitFor({ state: "detached" });
    expect(await loyaltyPreview.getByText(SOURCE_COMMENT_TEXT, { exact: true }).count()).toBe(0);
    expect(await loyaltyReturnRow.getAttribute("data-diff-origin")).toBe("add");

    // The saved hover/click preference remains independently configurable. Restore the source-comment
    // diff before exercising click-to-open, then return to hover for the visibility control below.
    await preferencesButton.click();
    await hideSourceCommentDiff.uncheck();
    await preferencesPane.getByRole("radio", { name: /^On click/ }).check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();
    await loyaltyTierNode.hover();
    await page.waitForTimeout(350);
    expect(await loyaltyPreview.count()).toBe(0);
    await nodeHeader(loyaltyTierNode).click();
    await loyaltyPreview.waitFor();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    expect(await loyaltyPreview.isVisible()).toBe(true);
    await clickBareCanvas(page, extractedReviewSurface);
    await loyaltyPreview.waitFor({ state: "detached" });
    await preferencesButton.click();
    await preferencesPane.getByRole("radio", { name: /^On hover/ }).check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();

    // The right-side action fully disables automatic previews without disabling the node header's
    // explicit source action. Both hover and click stay inert while the control is unpressed.
    const codePreviewToggle = extractedReviewSurface
      .getByRole("group", { name: "Canvas actions" })
      .getByRole("group", { name: "Extracted graph actions" })
      .getByRole("button", { name: "Code previews", exact: true });
    expect(await codePreviewToggle.getAttribute("aria-pressed")).toBe("true");
    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();
    await codePreviewToggle.click();
    await loyaltyPreview.waitFor({ state: "detached" });
    expect(await codePreviewToggle.getAttribute("aria-pressed")).toBe("false");
    await loyaltyTierNode.hover();
    await page.waitForTimeout(350);
    expect(await loyaltyPreview.count()).toBe(0);
    await preferencesButton.click();
    await preferencesPane.getByRole("radio", { name: /^On click/ }).check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();
    expect(await codePreviewToggle.getAttribute("aria-pressed")).toBe("false");
    await nodeHeader(loyaltyTierNode).click();
    await page.waitForTimeout(250);
    expect(await loyaltyPreview.count()).toBe(0);

    const loyaltyCodeButton = loyaltyTierNode.getByRole("button", { name: "View source" });
    await loyaltyCodeButton.click();
    const loyaltySourceDialog = page.getByRole("dialog", { name: "Source code" });
    await loyaltySourceDialog.waitFor();
    await loyaltySourceDialog.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();
    const sourceSearchTrigger = loyaltySourceDialog.getByRole("button", { name: "Open source search" });
    const sourceSearch = loyaltySourceDialog.getByRole("search", { name: "Find in current source" });
    await expect.poll(() => loyaltyCodeButton.evaluate((element) => element === document.activeElement)).toBe(true);

    // A code-only text selection seeds the existing repository symbol palette. Lookup includes all
    // scopes, preserves ambiguity instead of auto-picking, and returns focus to its dock action.
    const sourceLookupTrigger = loyaltySourceDialog.getByRole("button", { name: "Search repository symbols" });
    const loyaltyDefinitionCell = loyaltySourceDialog.locator('tr[data-source-line="1"] [data-source-code-text="true"]');
    await selectSourceText(loyaltyDefinitionCell, "loyaltyTierFor");
    const selectedLookupTrigger = loyaltySourceDialog.getByRole("button", {
      name: "Look up “loyaltyTierFor” in repository symbols",
    });
    await selectedLookupTrigger.waitFor();
    expect(await loyaltySourceDialog.locator('[data-line-comment-composer-open="true"]').count()).toBe(0);
    await selectedLookupTrigger.click();
    const lookupPalette = page.getByRole("dialog", { name: "Lookup repository symbol" });
    await lookupPalette.waitFor();
    expect(await lookupPalette.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    const lookupInput = lookupPalette.getByRole("combobox", { name: "Lookup repository symbols" });
    expect(await lookupInput.inputValue()).toBe("loyaltyTierFor");
    await lookupInput.press("Shift+Tab");
    expect(await lookupPalette.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await lookupInput.click();
    const lookupResult = lookupPalette.locator(`[data-symbol-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await lookupResult.waitFor();
    expect(await lookupResult.getAttribute("data-symbol-readiness")).toBe("ready");
    await lookupResult.getByRole("button", { name: "Open loyaltyTierFor", exact: true }).waitFor();
    await lookupInput.press("Escape");
    await lookupPalette.waitFor({ state: "detached" });
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    await sourceLookupTrigger.waitFor();
    await expect.poll(() => sourceLookupTrigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await selectSourceText(loyaltyDefinitionCell, "loyaltyTierFor");
    await selectedLookupTrigger.waitFor();
    await loyaltyDefinitionCell.evaluate((element) => element.ownerDocument.getSelection()?.removeAllRanges());
    await sourceLookupTrigger.waitFor();
    expect(await selectedLookupTrigger.count()).toBe(0);

    // The source reader is one modeless floating tool window. Its default stays inside the review
    // graph, aligned to the top-right product margin, so the PR sidebar remains fully available.
    const sourceWindowLayer = page.locator('[data-floating-source-window-layer="true"]');
    const sourceWindowHost = page.locator('[data-floating-source-window-host="true"]');
    const workspaceUnderlay = page.locator('[data-source-workspace-underlay="true"]');
    const reviewGraphPane = page.locator("#meridian-review-graph-pane");
    const reviewPane = page.locator("#meridian-pr-review-pane");
    const [initialWindowRect, graphBox, reviewPaneBox] = await Promise.all([
      floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost),
      reviewGraphPane.boundingBox(),
      reviewPane.boundingBox(),
    ]);
    if (graphBox === null || reviewPaneBox === null) {
      throw new Error("floating source default region is not measurable");
    }
    expect(initialWindowRect.width).toBeCloseTo(Math.min(1_200, graphBox.width - 24), 0);
    expect(initialWindowRect.height).toBeCloseTo(Math.min(700, graphBox.height - 24), 0);
    expect(Math.abs(initialWindowRect.top - (graphBox.y + 12))).toBeLessThanOrEqual(1);
    expect(Math.abs(initialWindowRect.right - (graphBox.x + graphBox.width - 12))).toBeLessThanOrEqual(1);
    expect(initialWindowRect.right).toBeLessThanOrEqual(reviewPaneBox.x + 1);
    expect(await loyaltySourceDialog.getAttribute("aria-modal")).toBeNull();
    expect(await sourceWindowHost.getAttribute("data-source-window-rail-mode")).toBe("side");

    // The shell itself never catches input. Only the window and its resize hit zones do, leaving
    // uncovered graph pixels reachable by the real pointer stack.
    expect(await sourceWindowLayer.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
    expect(await sourceWindowHost.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
    expect(await sourceWindowHost.evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
    expect(await workspaceUnderlay.getAttribute("inert")).toBeNull();
    expect(await workspaceUnderlay.getAttribute("aria-hidden")).toBeNull();
    expect(await sourceWindowLayer.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    expect(await sourceWindowHost.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
    const pointerThroughPoint = {
      x: graphBox.x + 3,
      y: graphBox.y + graphBox.height / 2,
    };
    expect(await page.evaluate(({ x, y }) => (
      document.elementFromPoint(x, y)?.closest('[data-floating-source-window-host="true"]') === null
    ), pointerThroughPoint)).toBe(true);

    // A real pane click reaches the graph through the shell, clears its selected-node state, and
    // deliberately does not dismiss the floating window. Keyboard activation of graph chrome then
    // changes the camera while focus and Escape remain owned by the graph rather than the window.
    await relatedOnly.waitFor();
    await clickBareCanvas(page, extractedReviewSurface);
    await relatedOnly.waitFor({ state: "detached" });
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    const sourceOpenGraphViewport = extractedReviewSurface.locator(".react-flow__viewport");
    const sourceOpenTransform = await sourceOpenGraphViewport.getAttribute("style");
    const sourceOpenZoomOut = extractedReviewSurface.getByRole("button", { name: "Zoom Out" });
    await sourceOpenZoomOut.focus();
    expect(await sourceOpenZoomOut.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await loyaltySourceDialog.evaluate((element) => !element.contains(document.activeElement))).toBe(true);
    await sourceOpenZoomOut.press("Enter");
    await expect.poll(() => sourceOpenGraphViewport.getAttribute("style")).not.toBe(sourceOpenTransform);
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    await sourceOpenZoomOut.press("Escape");
    expect(await loyaltySourceDialog.isVisible()).toBe(true);

    // Modeless source shortcuts are focus-scoped: graph-owned focus keeps Ctrl/Cmd+F available to
    // the workspace/browser, while focus returned to the window lets its search own the same chord.
    await page.keyboard.press(SOURCE_SEARCH_SHORTCUT);
    expect(await sourceSearch.count()).toBe(0);
    expect(await sourceOpenZoomOut.evaluate((element) => element === document.activeElement)).toBe(true);
    await sourceSearchTrigger.focus();
    await page.keyboard.press(SOURCE_SEARCH_SHORTCUT);
    await sourceSearch.waitFor();
    await sourceSearch.getByRole("button", { name: "Close source search" }).click();
    await sourceSearch.waitFor({ state: "detached" });

    // The code listing is the only main-pane scroll owner. The related rail has its own independent
    // vertical scroller; neither the frame, main adapter, nor rail frame adds a duplicate track.
    const sourceDockBody = loyaltySourceDialog.locator('[data-source-code-body="dock"]');
    const sourceScrollOwner = loyaltySourceDialog.locator('[data-source-scroll-owner="true"]');
    const relatedRailFrame = loyaltySourceDialog.getByRole("complementary", { name: "Related code blocks" });
    const relatedRailScroller = relatedRailFrame.locator('[data-related-code-rail="true"]');
    expect(await sourceScrollOwner.count()).toBe(1);
    expect(await relatedRailScroller.count()).toBe(1);
    const scrollLayout = await sourceDockBody.evaluate((body) => {
      const owner = body.querySelector<HTMLElement>('[data-source-scroll-owner="true"]');
      const main = body.closest<HTMLElement>('[data-source-window-main="true"]');
      const host = body.closest<HTMLElement>('[data-floating-source-window-host="true"]');
      if (owner === null || main === null || host === null) {
        throw new Error("floating source scroll ownership is not measurable");
      }
      return {
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        bodyOverflowY: getComputedStyle(body).overflowY,
        ownerOverflowY: getComputedStyle(owner).overflowY,
        mainOverflowY: getComputedStyle(main).overflowY,
        hostOverflowY: getComputedStyle(host).overflowY,
      };
    });
    expect(scrollLayout.bodyScrollHeight).toBeLessThanOrEqual(scrollLayout.bodyClientHeight + 1);
    expect(scrollLayout.bodyOverflowY).toBe("hidden");
    expect(scrollLayout.ownerOverflowY).toBe("auto");
    expect(scrollLayout.mainOverflowY).toBe("hidden");
    expect(scrollLayout.hostOverflowY).toBe("hidden");
    expect(await relatedRailFrame.evaluate((element) => getComputedStyle(element).overflowY)).toBe("hidden");
    expect(await relatedRailScroller.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");

    // The window is a complete review surface: its path-based action changes the whole file (not
    // merely the declaration node), while its editor-style find stays above the one scroll owner.
    const dockViewedControl = loyaltySourceDialog.getByRole("button", {
      name: "Mark src/pricing/loyaltyTiers.ts as viewed",
    });
    await dockViewedControl.click();
    await loyaltySourceDialog.getByRole("button", {
      name: "Viewed src/pricing/loyaltyTiers.ts — click to unmark",
    }).waitFor();
    await loyaltySourceDialog.getByRole("button", {
      name: "Viewed src/pricing/loyaltyTiers.ts — click to unmark",
    }).click();
    await dockViewedControl.waitFor();
    await expect.poll(() => [...viewedFileMutations]).toEqual([
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
    ]);

    await page.keyboard.press(MODIFIED_SOURCE_SEARCH_SHORTCUT);
    expect(await sourceSearch.count()).toBe(0);
    await page.keyboard.press(SOURCE_SEARCH_SHORTCUT);
    const sourceSearchInput = sourceSearch.getByRole("searchbox", { name: "Search source" });
    const sourceSearchStatus = sourceSearch.locator('[data-source-search-status="true"]');
    await sourceSearchInput.fill("orderCount");
    await sourceSearchStatus.getByText(/^1 of 2 · L\d+:\d+$/).waitFor();
    expect(await loyaltySourceDialog.locator('[data-source-search-active="true"]').count()).toBe(1);
    expect(await loyaltySourceDialog.locator('[data-source-search-match-index]').count()).toBe(2);
    expect(await loyaltySourceDialog.locator('[data-source-search-match-index="0"][data-source-search-match-active="true"]').count()).toBe(1);
    await sourceSearchInput.press("Enter");
    await sourceSearchStatus.getByText(/^2 of 2 · L3:\d+$/).waitFor();
    expect(await loyaltySourceDialog.locator('tr[data-source-line="3"][data-source-search-active="true"]').count()).toBe(1);
    expect(await loyaltySourceDialog.locator('[data-source-search-match-index="1"][data-source-search-match-active="true"]').count()).toBe(1);
    await sourceSearchInput.press("Shift+Enter");
    await sourceSearchStatus.getByText(/^1 of 2 · L1:\d+$/).waitFor();
    await sourceSearchInput.press("Escape");
    await sourceSearch.waitFor({ state: "detached" });
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    expect(await loyaltySourceDialog.locator('[data-source-search-match-count]').count()).toBe(0);
    expect(await sourceScrollOwner.count()).toBe(1);

    // The global command palette remains the top modal layer. Escape from one of its ordinary
    // buttons closes only the palette; it must not fall through to the source search or window.
    await sourceSearchTrigger.click();
    const layeredSourceSearch = loyaltySourceDialog.getByRole("search", { name: "Find in current source" });
    await page.keyboard.press("Control+P");
    await palette.waitFor();
    const paletteNonEditableControl = palette.locator("button").first();
    await paletteNonEditableControl.waitFor();
    await paletteNonEditableControl.focus();
    await page.keyboard.press("Escape");
    await palette.waitFor({ state: "detached" });
    expect(await layeredSourceSearch.isVisible()).toBe(true);
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    await layeredSourceSearch.getByRole("button", { name: "Close source search" }).click();

    // Moving and resizing update the same mounted source reader. Dragging its header commits both
    // axes; the dedicated move control offers the same operation to keyboard users.
    const liveSourceHost = await sourceWindowHost.elementHandle();
    const stableSourceScrollOwner = sourceWindowHost.locator('[data-source-scroll-owner="true"]');
    const liveSourceScrollOwner = await stableSourceScrollOwner.elementHandle();
    if (liveSourceHost === null || liveSourceScrollOwner === null) {
      throw new Error("floating source identity is not measurable");
    }
    const expectLiveSourceIdentity = async (): Promise<void> => {
      expect(await sourceWindowHost.evaluate(
        (element, original) => element === original,
        liveSourceHost,
      )).toBe(true);
      expect(await stableSourceScrollOwner.evaluate(
        (element, original) => element === original,
        liveSourceScrollOwner,
      )).toBe(true);
      expect(await stableSourceScrollOwner.count()).toBe(1);
    };
    const sourceWindowHeader = loyaltySourceDialog.locator('[data-source-window-drag-handle="true"]');
    const sourceWindowMoveControl = loyaltySourceDialog.getByRole("button", { name: "Move source window" });
    const beforeHeaderDrag = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    const headerBox = await sourceWindowHeader.boundingBox();
    if (headerBox === null) throw new Error("floating source drag header is not measurable");
    const headerDragStart = {
      x: headerBox.x + Math.min(80, headerBox.width / 3),
      y: headerBox.y + headerBox.height / 2,
    };
    await page.mouse.move(headerDragStart.x, headerDragStart.y);
    await page.mouse.down();
    await page.mouse.move(headerDragStart.x + 96, headerDragStart.y + 64, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (
      await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost)
    ).x).toBeGreaterThan(beforeHeaderDrag.x + 70);
    const afterHeaderDrag = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(afterHeaderDrag.y).toBeGreaterThan(beforeHeaderDrag.y + 45);
    expect(Math.abs(afterHeaderDrag.width - beforeHeaderDrag.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterHeaderDrag.height - beforeHeaderDrag.height)).toBeLessThanOrEqual(1);
    await expectLiveSourceIdentity();

    await sourceWindowMoveControl.focus();
    await sourceWindowMoveControl.press("Shift+ArrowLeft");
    await expect.poll(async () => (
      await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost)
    ).x).toBeLessThan(afterHeaderDrag.x - 50);
    const afterHorizontalKeyMove = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(Math.abs((afterHeaderDrag.x - afterHorizontalKeyMove.x) - 64)).toBeLessThanOrEqual(1);
    await sourceWindowMoveControl.press("ArrowDown");
    const afterKeyboardMove = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(Math.abs((afterKeyboardMove.y - afterHorizontalKeyMove.y) - 16)).toBeLessThanOrEqual(1);
    await expectLiveSourceIdentity();

    const storedAfterMove = await readStoredSourceWindowPreference(page);
    expect(storedAfterMove.version).toBe(2);
    if (storedAfterMove.rect === null) throw new Error("floating source move was not persisted");
    expectSourceWindowRectsToAgree(storedAfterMove.rect, afterKeyboardMove);

    // All eight pointer zones surround the unclipped host; the four edges are keyboard-accessible.
    // A south-east drag proves two-dimensional resize, then the right edge changes only width.
    expect(await sourceWindowLayer.locator('[data-source-window-resize-zone]').count()).toBe(8);
    expect(await page.getByRole("separator", { name: /^Resize source window from .+ edge$/ }).count()).toBe(4);
    const southeastResizeZone = sourceWindowLayer.locator('[data-source-window-resize-zone="se"]');
    const beforeCornerResize = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    const southeastBox = await southeastResizeZone.boundingBox();
    if (southeastBox === null) throw new Error("floating source corner resize zone is not measurable");
    const southeastStart = {
      x: southeastBox.x + southeastBox.width / 2,
      y: southeastBox.y + southeastBox.height / 2,
    };
    await page.mouse.move(southeastStart.x, southeastStart.y);
    await page.mouse.down();
    await page.mouse.move(southeastStart.x - 144, southeastStart.y - 96, { steps: 6 });
    await page.mouse.up();
    const afterCornerResize = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(beforeCornerResize.width - afterCornerResize.width).toBeGreaterThan(120);
    expect(beforeCornerResize.height - afterCornerResize.height).toBeGreaterThan(70);
    expect(Math.abs(beforeCornerResize.x - afterCornerResize.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(beforeCornerResize.y - afterCornerResize.y)).toBeLessThanOrEqual(1);
    const rightResizeEdge = page.getByRole("separator", { name: "Resize source window from right edge" });
    await rightResizeEdge.focus();
    await rightResizeEdge.press("ArrowRight");
    const afterEdgeResize = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(Math.abs((afterEdgeResize.width - afterCornerResize.width) - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterEdgeResize.height - afterCornerResize.height)).toBeLessThanOrEqual(1);
    await expectLiveSourceIdentity();

    // Geometry is durable across close/reopen, and focus returns to the control that opened source.
    const persistedWindowRect = afterEdgeResize;
    await loyaltySourceDialog.getByRole("button", { name: "Close source" }).click();
    await loyaltySourceDialog.waitFor({ state: "detached" });
    expect(await workspaceUnderlay.getAttribute("inert")).toBeNull();
    expect(await workspaceUnderlay.getAttribute("aria-hidden")).toBeNull();
    await expect.poll(() => loyaltyCodeButton.evaluate((element) => element === document.activeElement)).toBe(true);
    await loyaltyCodeButton.click();
    await loyaltySourceDialog.waitFor();
    const reopenedWindowRect = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expectSourceWindowRectsToAgree(reopenedWindowRect, persistedWindowRect);

    // Reset forgets the stored rectangle and recomputes the responsive top-right graph default.
    await loyaltySourceDialog.getByRole("button", {
      name: "Reset source window position and size",
    }).click();
    await expect.poll(async () => (await readStoredSourceWindowPreference(page)).rect).toBeNull();
    const [resetWindowRect, resetGraphBox] = await Promise.all([
      floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost),
      reviewGraphPane.boundingBox(),
    ]);
    if (resetGraphBox === null) throw new Error("source reset region is not measurable");
    expect(resetWindowRect.width).toBeCloseTo(Math.min(1_200, resetGraphBox.width - 24), 0);
    expect(resetWindowRect.height).toBeCloseTo(Math.min(700, resetGraphBox.height - 24), 0);
    expect(Math.abs(resetWindowRect.top - (resetGraphBox.y + 12))).toBeLessThanOrEqual(1);
    expect(Math.abs(resetWindowRect.right - (resetGraphBox.x + resetGraphBox.width - 12))).toBeLessThanOrEqual(1);

    // Below 620px the related rail becomes an explicit overlay toggle. Escape closes that overlay
    // first and leaves the modeless source window open; reset returns to the deterministic default.
    await rightResizeEdge.focus();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
      if (current.width < 620) break;
      await rightResizeEdge.press("Shift+ArrowLeft");
    }
    const compactWindowRect = await floatingSourceWindowRect(sourceWindowLayer, sourceWindowHost);
    expect(compactWindowRect.width).toBeLessThan(620);
    expect(compactWindowRect.width).toBeGreaterThanOrEqual(320);
    expect(await sourceWindowHost.getAttribute("data-source-window-rail-mode")).toBe("hidden");
    // Keep a DOM-stable handle while the overlay makes the underlying main pane inert. A role
    // locator correctly disappears from the accessibility tree for that interval.
    const relatedRailToggle = loyaltySourceDialog.locator('[data-source-window-related-toggle="true"]');
    await relatedRailToggle.waitFor();
    expect(await relatedRailToggle.getAttribute("aria-label")).toMatch(/^Related code blocks \(\d+\)$/);
    expect(await relatedRailToggle.getAttribute("aria-expanded")).toBe("false");
    await relatedRailToggle.click();
    expect(await sourceWindowHost.getAttribute("data-source-window-rail-mode")).toBe("overlay");
    await relatedRailFrame.waitFor();
    const compactRailClose = relatedRailFrame.getByRole("button", { name: "Hide Related code blocks" });
    expect(await relatedRailScroller.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
    expect(await relatedRailToggle.getAttribute("aria-expanded")).toBe("true");
    expect(await sourceWindowHost.locator('[data-source-window-main="true"]').getAttribute("inert")).not.toBeNull();
    await expect.poll(() => compactRailClose.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press(SOURCE_SEARCH_SHORTCUT);
    expect(await sourceSearch.count()).toBe(0);
    await compactRailClose.press("Escape");
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    expect(await sourceWindowHost.getAttribute("data-source-window-rail-mode")).toBe("hidden");
    await expect.poll(() => relatedRailToggle.evaluate((element) => element === document.activeElement)).toBe(true);
    await loyaltySourceDialog.getByRole("button", {
      name: "Reset source window position and size",
    }).click();
    await expect.poll(() => sourceWindowHost.getAttribute("data-source-window-rail-mode")).toBe("side");
    await expect.poll(async () => (await readStoredSourceWindowPreference(page)).rect).toBeNull();

    // A wide colspan comment must wrap inside the source viewport without becoming a table sizing
    // constraint. Otherwise auto table layout assigns part of its max-content width to the sticky
    // gutter and creates a large blank strip to the left of every line number.
    const existingCommentCard = loyaltySourceDialog.locator('[data-existing-review-comment-id="7001"]');
    const sourceLine = loyaltySourceDialog.locator(`tr[data-source-line="${EXISTING_COMMENT_LINE}"]`);
    const listing = sourceLine.locator("xpath=ancestor::table[1]/..");
    const gutter = sourceLine.locator("td").first();
    const lineNumber = gutter.locator("span").last();
    await listing.evaluate((element) => { element.scrollLeft = 0; });
    const commentBox = await existingCommentCard.boundingBox();
    const listingBox = await listing.boundingBox();
    const gutterWithComment = await gutter.boundingBox();
    const numberWithComment = await lineNumber.boundingBox();
    if (commentBox === null || listingBox === null || gutterWithComment === null || numberWithComment === null) {
      throw new Error("inline review comment layout is not measurable");
    }
    expect(commentBox.x + commentBox.width).toBeLessThanOrEqual(listingBox.x + listingBox.width + 1);

    // The floating window can overlap graph chrome, so dispatch the preference toggle without
    // pointer actionability; this keeps the same mounted source table available for comparison.
    await page.locator('button[aria-label="Hide comments on canvas"]').dispatchEvent("click");
    await existingCommentCard.waitFor({ state: "detached" });
    const gutterWithoutComment = await gutter.boundingBox();
    const numberWithoutComment = await lineNumber.boundingBox();
    if (gutterWithoutComment === null || numberWithoutComment === null) {
      throw new Error("source gutter layout is not measurable");
    }
    expect(Math.abs(gutterWithComment.width - gutterWithoutComment.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(numberWithComment.x - numberWithoutComment.x)).toBeLessThanOrEqual(1);
    await page.locator('button[aria-label="Show comments on canvas"]').dispatchEvent("click");
    await existingCommentCard.waitFor();

    // Submitted comments use GitHub's real edit/reply endpoints and refresh the thread in place.
    const existingComment = loyaltySourceDialog.locator('[data-existing-review-comment-id="7001"]');
    await existingComment.getByRole("button", { name: "Edit", exact: true }).click();
    await existingComment.getByPlaceholder("Edit comment…").fill(EDITED_EXISTING_COMMENT_TEXT);
    await existingComment.getByRole("button", { name: "Save changes", exact: true }).click();
    await existingComment.getByText(EDITED_EXISTING_COMMENT_TEXT, { exact: true }).waitFor();
    await existingComment.getByRole("button", { name: "Reply", exact: true }).click();
    await existingComment.getByPlaceholder("Reply to e2e-reviewer…").fill(THREAD_REPLY_TEXT);
    await existingComment.getByRole("button", { name: "Add reply", exact: true }).click();
    await loyaltySourceDialog.getByText(THREAD_REPLY_TEXT, { exact: true }).waitFor();
    await loyaltySourceDialog.locator('[data-review-comment-reply="true"]').waitFor();
    expect(await loyaltySourceDialog.locator('[data-review-comment-reply="true"]').count()).toBe(1);

    // Add the second distinct line draft through the full-source gutter. An attempted window close
    // first exposes the shared Keep/Discard choice; keeping resumes the exact text before Add.
    const secondSourceRow = loyaltySourceDialog.locator(`tr[data-source-line="${secondInlineLine}"]`);
    await secondSourceRow.scrollIntoViewIfNeeded();
    await secondSourceRow.hover();
    await secondSourceRow.getByRole("button", { name: `Comment on line ${secondInlineLine}`, exact: true }).click();
    const secondDraft = loyaltySourceDialog.getByPlaceholder(`Comment on line ${secondInlineLine}…`);
    await secondDraft.fill(SECOND_DRAFT_TEXT);
    await loyaltySourceDialog.getByRole("button", { name: "Close source" }).click();
    await loyaltySourceDialog.getByRole("alert").waitFor();
    expect(await loyaltySourceDialog.isVisible()).toBe(true);
    await loyaltySourceDialog.getByRole("button", { name: "Keep editing" }).click();
    expect(await secondDraft.inputValue()).toBe(SECOND_DRAFT_TEXT);
    await loyaltySourceDialog.getByRole("button", { name: "Add comment", exact: true }).click();
    await loyaltySourceDialog
      .locator(`[data-pending-review-comments-line="${secondInlineLine}"]`)
      .getByText(SECOND_DRAFT_TEXT, { exact: true })
      .waitFor();
    const lineDrafts = loyaltySourceDialog.locator("[data-pending-review-comment-id]");
    expect(await lineDrafts.count()).toBe(2);

    // A pending line draft remains independently editable before the review is submitted.
    const firstPendingDraft = loyaltySourceDialog.locator(`[data-pending-review-comments-line="${firstInlineLine}"]`);
    await firstPendingDraft.getByRole("button", { name: "Edit", exact: true }).click();
    await firstPendingDraft.getByPlaceholder("Edit comment…").fill(EDITED_DRAFT_TEXT);
    await firstPendingDraft.getByRole("button", { name: "Save changes", exact: true }).click();
    await firstPendingDraft.getByText(EDITED_DRAFT_TEXT, { exact: true }).waitFor();
    await sourceSearchTrigger.focus();
    await page.keyboard.press("Escape");
    await loyaltySourceDialog.waitFor({ state: "detached" });
    await expect.poll(() => loyaltyCodeButton.evaluate((element) => element === document.activeElement)).toBe(true);

    // 4e — a file gesture marks the file Viewed through GitHub and advances the header.
    await page.getByText("0/3 files viewed", { exact: true }).waitFor();
    await addedViewedControl.click();
    await page.getByText("1/3 files viewed", { exact: true }).waitFor();
    await expect.poll(() => [...viewedFileMutations]).toEqual([
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
    ]);

    // The review-wide presentation action closes only viewed scopes. It must leave the unviewed
    // sibling open, retain progress, and avoid another GitHub viewed-state mutation.
    const loyaltyFileNode = extractedReviewSurface.locator(
      `.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`,
    );
    const orderServiceNode = extractedReviewSurface.locator(
      `.react-flow__node[data-id="${ORDER_SERVICE_MODULE_ID}"]`,
    );
    await loyaltyFileNode.getByRole("button", { name: "Collapse" }).waitFor();
    await orderServiceNode.getByRole("button", { name: "Collapse" }).waitFor();
    const viewedMutationCount = viewedFileMutations.length;
    await extractedReviewSurface.getByRole("button", { name: "Collapse all viewed nodes" }).click();
    await loyaltyFileNode.getByRole("button", { name: "Expand" }).waitFor();
    await loyaltyTierNode.waitFor({ state: "detached" });
    await orderServiceNode.getByRole("button", { name: "Collapse" }).waitFor();
    await page.getByText("1/3 files viewed", { exact: true }).waitFor();
    expect(viewedFileMutations).toHaveLength(viewedMutationCount);

    // Restore the fixture's disclosure for the remaining review journey.
    await loyaltyFileNode.getByRole("button", { name: "Expand" }).click();
    await loyaltyTierNode.waitFor();

    // 4f — submit one GitHub review whose two drafts stay as two ordered inline comments.
    await page.getByRole("button", { name: "Submit comments" }).click();
    await page.getByText("Comments submitted", { exact: true }).waitFor();
    expect(submittedReviews).toEqual([
      {
        event: "COMMENT",
        commit_id: fixture!.headSha,
        comments: [
          {
            path: "src/pricing/loyaltyTiers.ts",
            line: firstInlineLine,
            side: "RIGHT",
            body: EDITED_DRAFT_TEXT,
          },
          {
            path: "src/pricing/loyaltyTiers.ts",
            line: secondInlineLine,
            side: "RIGHT",
            body: SECOND_DRAFT_TEXT,
          },
        ],
      },
    ]);
    expect(submittedReviews[0]).not.toHaveProperty("body");

    // 4g — erase Meridian's local progress before reload; GitHub's file state restores 1/3.
    const clearedProgressKeys = await clearStoredReviewProgress(page);
    expect(clearedProgressKeys).toHaveLength(1);
    expect(clearedProgressKeys[0]).toContain("github-pr:v1");
    expect(clearedProgressKeys[0]).not.toContain("id=");
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("rev") === "1");
    expect(new URL(page.url()).searchParams.get("rev")).toBe("1");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 60_000 });
    await syncProvenance.waitFor();
    await page.getByText("1/3 files viewed", { exact: true }).waitFor();
    expect(viewedFileMutations).toEqual([
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
      { path: "src/pricing/loyaltyTiers.ts", viewed: false },
      { path: "src/pricing/loyaltyTiers.ts", viewed: true },
    ]);

    // 4h — Escape from the graph leaves its floating source window open; Escape closes the window only
    // after focus enters it. Repeated graph Escape and outward zoom leave the review overlay in place,
    // while explicit Close parks it for the text-only Resume chip. The source graph stays mounted
    // beneath Minimal Graph, but an active PR review is its own navigation root.
    // Scope this raw CSS locator to the extracted surface rather than matching the intentionally
    // retained source copy of the same file card.
    const extractedSurface = page.getByRole("region", { name: "Extracted graph" });
    const codeButton = extractedSurface.locator(
      `.react-flow__node[data-id="${ORDER_SERVICE_MODULE_ID}"] button[aria-label="View source"]`,
    );
    await codeButton.waitFor({ timeout: 60_000 });
    await codeButton.click();
    const sourceDialog = page.getByRole("dialog", { name: "Source code" });
    await sourceDialog.waitFor();
    await codeButton.focus();
    await page.keyboard.press("Escape");
    expect(await sourceDialog.isVisible()).toBe(true);
    await sourceDialog.getByRole("button", { name: "Open source search" }).focus();
    await page.keyboard.press("Escape");
    await sourceDialog.waitFor({ state: "detached" });
    await expect.poll(() => codeButton.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.getByRole("region", { name: "Extracted graph" }).count()).toBe(1);
    expect(await syncProvenance.count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("region", { name: "Extracted graph" }).count()).toBe(1);
    expect(await syncProvenance.count()).toBe(1);

    // Cross the old semantic-parent threshold through the real user-facing zoom control. Review
    // owns this canvas boundary: neither its graph nor its HEAD provenance may yield to the covered
    // source surface, and Resume remains unavailable until the explicit Close below.
    const zoomOut = extractedSurface.locator(".react-flow__controls-zoomout");
    await zoomOut.waitFor();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await zoomOut.click();
    }
    await waitForGraphViewportToSettle(extractedSurface);
    expect(await page.getByRole("region", { name: "Extracted graph" }).count()).toBe(1);
    expect(await page.getByText("Files changed", { exact: true }).count()).toBe(1);
    expect(await syncProvenance.count()).toBe(1);
    expect(await page.getByText("Resume review #7", { exact: true }).count()).toBe(0);

    await page.getByRole("button", { name: "Close extracted graph" }).click();
    await page.getByRole("region", { name: "Extracted graph" }).waitFor({ state: "detached" });
    const resumeText = page.getByText("Resume review #7", { exact: true });
    await resumeText.waitFor();
    expect(await resumeText.count()).toBe(1);
    await resumeText.click();
    await syncProvenance.waitFor();
  }, 240_000);
});

async function setup(): Promise<void> {
  ensureBuilt();
  viewedFileMutations.length = 0;
  fixture = buildPrReviewFixture();
  const smartGit = await startSmartGitServer(fixture);
  smartGitServer = smartGit.server;
  await verifySmartHttpRemote(smartGit.repoUrl);
  restoreGitRedirect = installGitRedirect(smartGit.repoUrl);

  vi.stubGlobal("fetch", fakeGitHub(fixture, submittedReviews));
  webService = createWebService({
    rendererRoot: dirname(RENDERER_INDEX),
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    githubClientId: "Iv1.meridian-e2e",
    fallbackToken: "meridian-e2e-token",
    fallbackUser: { login: "e2e-reviewer", avatarUrl: null },
  });
  const baseUrl = await listenServer(webService.server);
  const generated = await generateSession(baseUrl);
  viewUrl = `${baseUrl}/view?id=${encodeURIComponent(generated.id)}`;

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
}

async function teardown(): Promise<void> {
  await browser?.close();
  await webService?.close();
  await closeServer(smartGitServer);
  restoreGitRedirect?.();
  vi.unstubAllGlobals();
  if (fixture) {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

function reviewFileButton(page: Page, path: string): Locator {
  return page.locator(`button[title^="${path}"]`);
}

async function selectSourceText(cell: Locator, text: string): Promise<void> {
  await cell.evaluate((element, selectedText) => {
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    for (let candidate = walker.nextNode(); candidate !== null; candidate = walker.nextNode()) {
      if ((candidate.textContent ?? "").includes(selectedText)) {
        textNode = candidate as Text;
        break;
      }
    }
    if (textNode === null) throw new Error(`source text not found: ${selectedText}`);
    const start = textNode.data.indexOf(selectedText);
    const range = element.ownerDocument.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + selectedText.length);
    const selection = element.ownerDocument.getSelection();
    if (selection === null) throw new Error("source selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
  await cell.dispatchEvent("pointerup", { pointerType: "mouse", button: 0 });
}

interface FloatingSourceWindowRectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface StoredSourceWindowPreference {
  version: number;
  rect: Pick<FloatingSourceWindowRectSnapshot, "x" | "y" | "width" | "height"> | null;
}

async function floatingSourceWindowRect(
  layer: Locator,
  host: Locator,
): Promise<FloatingSourceWindowRectSnapshot> {
  const [layerBox, hostBox] = await Promise.all([
    layer.boundingBox(),
    host.boundingBox(),
  ]);
  if (layerBox === null || hostBox === null) {
    throw new Error("floating source geometry is not measurable");
  }
  return {
    x: hostBox.x - layerBox.x,
    y: hostBox.y - layerBox.y,
    width: hostBox.width,
    height: hostBox.height,
    left: hostBox.x,
    top: hostBox.y,
    right: hostBox.x + hostBox.width,
    bottom: hostBox.y + hostBox.height,
  };
}

async function readStoredSourceWindowPreference(page: Page): Promise<StoredSourceWindowPreference> {
  const preference = await page.evaluate(() => {
    const raw = localStorage.getItem("meridian.sourceDockPreference");
    return raw === null ? null : JSON.parse(raw) as StoredSourceWindowPreference;
  });
  if (preference === null) throw new Error("floating source preference is not stored");
  return preference;
}

function expectSourceWindowRectsToAgree(
  actual: Pick<FloatingSourceWindowRectSnapshot, "x" | "y" | "width" | "height">,
  expected: Pick<FloatingSourceWindowRectSnapshot, "x" | "y" | "width" | "height">,
): void {
  expect(Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height),
  )).toBeLessThanOrEqual(2);
}

async function waitForGraphViewportToSettle(surface: Locator): Promise<void> {
  const viewport = surface.locator(".react-flow__viewport");
  await viewport.waitFor();
  let previous = await viewport.getAttribute("style");
  let stableSamples = 0;
  // Layout-ready precedes React Flow's scheduled camera fit. Wait through that animation so the
  // node cannot move away while the hover preview's dwell timer is running on a slower runner.
  await expect.poll(async () => {
    const current = await viewport.getAttribute("style");
    stableSamples = current === previous ? stableSamples + 1 : 0;
    previous = current;
    return stableSamples;
  }, { interval: 100, timeout: 5_000 }).toBeGreaterThanOrEqual(3);
}

async function lineActionStyle(action: Locator): Promise<{ opacity: string; pointerEvents: string }> {
  return action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
}

async function reviewCommentOverlayMetrics(indicator: Locator, tooltip: Locator, scroller: Locator): Promise<{
  indicator: { width: number; height: number };
  tooltip: { width: number; height: number };
  overflowX: string;
  scrollerClientWidth: number;
  scrollerScrollWidth: number;
  cardClientWidth: number;
  cardScrollWidth: number;
  bodyClientWidth: number;
  bodyScrollWidth: number;
  bodyOverflowWrap: string;
  wrappedTokenLineCount: number;
}> {
  const [indicatorBox, tooltipBox, scroll] = await Promise.all([
    indicator.boundingBox(),
    tooltip.boundingBox(),
    scroller.evaluate((element, wrappingToken) => {
      const card = element.querySelector<HTMLElement>('[data-review-comment-card="true"]');
      const body = element.querySelector<HTMLElement>('[data-review-comment-body="true"]');
      if (card === null || body === null) throw new Error("review comment content is not measurable");
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const tokenLineTops = new Set<number>();
      for (let textNode = walker.nextNode(); textNode !== null; textNode = walker.nextNode()) {
        const text = textNode.textContent ?? "";
        const tokenStart = text.indexOf(wrappingToken);
        if (tokenStart < 0) continue;
        const range = document.createRange();
        range.setStart(textNode, tokenStart);
        range.setEnd(textNode, tokenStart + wrappingToken.length);
        for (const rect of Array.from(range.getClientRects())) tokenLineTops.add(Math.round(rect.top));
        break;
      }
      if (tokenLineTops.size === 0) throw new Error("wrapping review comment token is not measurable");
      return {
        overflowX: getComputedStyle(element).overflowX,
        scrollerClientWidth: element.clientWidth,
        scrollerScrollWidth: element.scrollWidth,
        cardClientWidth: card.clientWidth,
        cardScrollWidth: card.scrollWidth,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyOverflowWrap: getComputedStyle(body).overflowWrap,
        wrappedTokenLineCount: tokenLineTops.size,
      };
    }, WRAPPING_COMMENT_TOKEN),
  ]);
  if (indicatorBox === null || tooltipBox === null) {
    throw new Error("review comment overlay is not measurable");
  }
  return {
    indicator: { width: indicatorBox.width, height: indicatorBox.height },
    tooltip: { width: tooltipBox.width, height: tooltipBox.height },
    ...scroll,
  };
}

/** Pick an actual empty point on React Flow's pane before issuing the real pointer click. A fixed
 * corner stops being bare as the mixed-language review adds cards and changes the fitted viewport. */
async function clickBareCanvas(target: Page, surface: Locator): Promise<void> {
  const pane = surface.locator(".react-flow__pane");
  const bounds = await pane.boundingBox();
  if (bounds === null) throw new Error("review graph pane has no clickable bounds");
  const candidates: Array<{ x: number; y: number }> = [];
  for (let row = 1; row <= 7; row += 1) {
    for (let column = 1; column <= 7; column += 1) {
      candidates.push({
        x: bounds.x + (bounds.width * column) / 8,
        y: bounds.y + (bounds.height * row) / 8,
      });
    }
  }
  // A floating source window can cover every coarse grid point while intentionally preserving a
  // narrow graph margin. Include those margin pixels so the helper still issues a genuine pane click.
  candidates.push(
    { x: bounds.x + 3, y: bounds.y + bounds.height / 2 },
    { x: bounds.x + bounds.width - 3, y: bounds.y + bounds.height / 2 },
    { x: bounds.x + bounds.width / 2, y: bounds.y + 3 },
    { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 3 },
  );
  for (const point of candidates) {
    const isBare = await pane.evaluate(
      (element, candidate) => document.elementFromPoint(candidate.x, candidate.y) === element,
      point,
    );
    if (isBare) {
      await target.mouse.click(point.x, point.y);
      return;
    }
  }
  throw new Error("review graph has no bare canvas point for the dismissal gesture");
}

async function generateSession(baseUrl: string): Promise<{ id: string }> {
  const response = await nativeFetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "github", value: "e2e/shop", subdir: "", ref: "" }),
  });
  if (!response.ok) {
    throw new Error(`fixture session generation failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

function fakeGitHub(source: PrReviewFixture, captured: SubmittedReview[]): typeof fetch {
  let existingCommentBody = EXISTING_COMMENT_TEXT;
  const threadReplies: Array<Record<string, unknown>> = [];
  const viewedFileStates = new Map<string, "VIEWED" | "UNVIEWED" | "DISMISSED">(
    source.files.map((file) => [file.api.filename, "UNVIEWED" as const]),
  );
  const summary = {
    number: 7,
    title: "Add loyalty tiers",
    user: { login: "e2e-reviewer" },
    head: { ref: "pr-head", sha: source.headSha },
    base: { ref: "main" },
    updated_at: "2026-07-11T10:00:00Z",
    draft: false,
    state: "open",
    html_url: "https://github.com/e2e/shop/pull/7",
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.github.com") {
      return nativeFetch(input, init);
    }
    const path = url.pathname;
    if (request.method === "POST" && path === "/graphql") {
      const payload = (await request.json()) as {
        query?: unknown;
        variables?: Record<string, unknown>;
      };
      const query = typeof payload.query === "string" ? payload.query : "";
      const variables = payload.variables ?? {};
      if (query.includes("query MeridianPullRequestViewedFiles")) {
        return json({
          data: {
            viewer: { id: "U_e2e_reviewer", login: "e2e-reviewer" },
            repository: {
              pullRequest: {
                id: "PR_e2e_7",
                headRefOid: source.headSha,
                files: {
                  nodes: source.files.map((file) => ({
                    path: file.api.filename,
                    viewerViewedState: viewedFileStates.get(file.api.filename) ?? "UNVIEWED",
                  })),
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }
      if (query.includes("query MeridianPullRequestViewedCoordinates")) {
        return json({
          data: {
            viewer: { id: "U_e2e_reviewer", login: "e2e-reviewer" },
            repository: {
              pullRequest: {
                id: "PR_e2e_7",
                headRefOid: source.headSha,
              },
            },
          },
        });
      }
      if (query.includes("mutation MeridianSetPullRequestFilesViewed")) {
        const updates: Record<string, { pullRequest: { headRefOid: string } }> = {};
        const paths = Object.entries(variables)
          .flatMap(([name, value]) => {
            const match = /^path(\d+)$/.exec(name);
            return match && typeof value === "string"
              ? [{ index: Number(match[1]), path: value }]
              : [];
          })
          .sort((left, right) => left.index - right.index);
        for (const { index, path: filePath } of paths) {
          if (!viewedFileStates.has(filePath)) {
            return json({ errors: [{ message: "unknown fixture file" }] });
          }
          const viewed = query.includes(`update${index}: markFileAsViewed`);
          viewedFileStates.set(filePath, viewed ? "VIEWED" : "UNVIEWED");
          viewedFileMutations.push({ path: filePath, viewed });
          updates[`update${index}`] = {
            pullRequest: { headRefOid: source.headSha },
          };
        }
        return json({ data: updates });
      }
      if (query.includes("mutation MeridianSetPullRequestFileViewed")) {
        const filePath = variables.path;
        if (typeof filePath !== "string" || !viewedFileStates.has(filePath)) {
          return json({ errors: [{ message: "unknown fixture file" }] });
        }
        const viewed = query.includes("update: markFileAsViewed");
        viewedFileStates.set(filePath, viewed ? "VIEWED" : "UNVIEWED");
        viewedFileMutations.push({ path: filePath, viewed });
        return json({
          data: {
            update: {
              pullRequest: { headRefOid: source.headSha },
            },
          },
        });
      }
    }
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls") return json([summary]);
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls/7") return json(summary);
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls/7/files") {
      return json(source.files.map((file) => file.api));
    }
    if (request.method === "GET" && path.endsWith("/pulls/7/comments")) {
      return json([
        {
          id: 7001,
          pull_request_review_id: 77,
          path: "src/pricing/loyaltyTiers.ts",
          commit_id: source.headSha,
          original_commit_id: source.headSha,
          line: EXISTING_COMMENT_LINE,
          original_line: EXISTING_COMMENT_LINE,
          side: "RIGHT",
          body: existingCommentBody,
          user: { login: "e2e-reviewer" },
          created_at: "2026-07-11T09:30:00Z",
          updated_at: "2026-07-11T09:30:00Z",
          html_url: "https://github.com/e2e/shop/pull/7#discussion_r7001",
        },
        ...threadReplies,
      ]);
    }
    if (request.method === "GET" && path.endsWith("/pulls/7/reviews")) return json([]);
    if (request.method === "PATCH" && path === "/repos/e2e/shop/pulls/comments/7001") {
      const payload = (await request.json()) as { body: string };
      existingCommentBody = payload.body;
      return json({ id: 7001 });
    }
    if (request.method === "POST" && path === "/repos/e2e/shop/pulls/7/comments/7001/replies") {
      const payload = (await request.json()) as { body: string };
      threadReplies.push({
        id: 7002,
        in_reply_to_id: 7001,
        pull_request_review_id: 77,
        path: "src/pricing/loyaltyTiers.ts",
        commit_id: source.headSha,
        original_commit_id: source.headSha,
        line: EXISTING_COMMENT_LINE,
        original_line: EXISTING_COMMENT_LINE,
        side: "RIGHT",
        body: payload.body,
        user: { login: "e2e-reviewer" },
        created_at: "2026-07-11T09:35:00Z",
        updated_at: "2026-07-11T09:35:00Z",
        html_url: "https://github.com/e2e/shop/pull/7#discussion_r7002",
      });
      return json({ id: 7002 });
    }
    if (request.method === "POST" && path === "/repos/e2e/shop/pulls/7/reviews") {
      captured.push((await request.json()) as SubmittedReview);
      return json({ html_url: "http://stub/review" });
    }
    const contents = "/repos/e2e/shop/contents/";
    if (request.method === "GET" && path.startsWith(contents) && url.searchParams.get("ref") === "pr-head") {
      const filePath = decodeURIComponent(path.slice(contents.length));
      const file = source.files.find((candidate) => candidate.api.filename === filePath);
      return file ? json({ encoding: "base64", content: Buffer.from(file.headCode).toString("base64") }) : json({}, 404);
    }
    return json({ message: "unexpected GitHub fixture request" }, 404);
  }) as typeof fetch;
}

// git-exec omits `env`, so Node passes this test-process configuration through to every Git child.
function installGitRedirect(repoUrl: string): () => void {
  const oldCount = process.env.GIT_CONFIG_COUNT;
  const oldKey = process.env.GIT_CONFIG_KEY_0;
  const oldValue = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${repoUrl}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/e2e/shop.git";
  return () => {
    restoreEnv("GIT_CONFIG_COUNT", oldCount);
    restoreEnv("GIT_CONFIG_KEY_0", oldKey);
    restoreEnv("GIT_CONFIG_VALUE_0", oldValue);
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function clearStoredReviewProgress(target: Page): Promise<string[]> {
  return target.evaluate(() => {
    const keys = Object.keys(localStorage).filter((candidate) => candidate.startsWith("meridian.review."));
    for (const key of keys) localStorage.removeItem(key);
    return keys;
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
