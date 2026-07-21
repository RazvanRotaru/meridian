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
import { createWebServer } from "../src/server/web-server";
import {
  PYTHON_REVIEW_PATH,
  RENDERER_INDEX,
  buildPrReviewFixture,
  chromiumInstalled,
  ensureBuilt,
  listenServer,
  startSmartGitServer,
  verifySmartHttpClone,
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

let fixture: PrReviewFixture | undefined;
let smartGitServer: Server | undefined;
let webServer: Server | undefined;
let browser: Browser | undefined;
let page: Page;
let viewUrl = "";
let restoreGitRedirect: (() => void) | undefined;
const submittedReviews: SubmittedReview[] = [];

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
    await page.getByRole("region", { name: "Extracted graph" }).waitFor();
    expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);

    // The whole-codebase overview is an alternate read-only surface, not a review close/reopen:
    // the prepared HEAD artifact, change colours, and review rail stay live, while its chevrons
    // disclose context locally without changing the hidden extracted graph's expansion state.
    await page.getByRole("button", { name: "Highlight code in codebase" }).click();
    const codebaseContext = page.getByRole("region", { name: "Codebase context graph" });
    await codebaseContext.getByText("READ-ONLY", { exact: true }).waitFor();
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
    await contextLoyaltyPreview.getByTitle("src/pricing/loyaltyTiers.ts").waitFor();
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

    // 4c — both added languages' files are immediately in the prepared HEAD graph with reviewable
    // units. The deeply nested Python callable opens the actual head source.
    const extractedReviewSurface = page.getByRole("region", { name: "Extracted graph" });
    const paletteAddition = extractedReviewSurface.locator(
      `.react-flow__node:not(.react-flow__node-ghost)[data-id="${EXECUTION_GALLERY_MODULE_ID}"]`,
    );
    expect(await paletteAddition.count()).toBe(0);
    await page.keyboard.press("Control+P");
    const palette = page.getByRole("dialog", { name: "Reveal or add a node in the current view" });
    await palette.waitFor();
    await palette.locator("input").fill("executionGraphGallery.ts");
    await palette.getByRole("button", { name: "Add executionGraphGallery.ts to the current view" }).click();
    await paletteAddition.waitFor({ timeout: 30_000 });
    expect(await palette.isVisible()).toBe(true);
    await page.keyboard.press("Control+P");
    await palette.waitFor({ state: "detached" });

    const pythonRiskNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${PYTHON_RISK_FUNCTION_ID}"]`);
    await pythonRiskNode.waitFor();
    let addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    let addedBlock = addedFile.locator("xpath=../..");
    const addedUnits = addedBlock.getByTitle("Mark as reviewed");
    await addedUnits.first().waitFor();
    expect(await addedUnits.count()).toBeGreaterThan(0);
    expect(await addedFile.getByText("added — extract head to view", { exact: true }).count()).toBe(0);

    const pythonFile = reviewFileButton(page, PYTHON_REVIEW_PATH);
    const pythonUnits = pythonFile.locator("xpath=../..").getByTitle("Mark as reviewed");
    await pythonUnits.first().waitFor();
    expect(await pythonUnits.count()).toBeGreaterThan(0);
    await pythonRiskNode.getByRole("button", { name: "View source" }).click();
    const pythonSourceDialog = page.getByRole("dialog", { name: "Source code" });
    await pythonSourceDialog.waitFor();
    await pythonSourceDialog.getByText(PYTHON_RISK_SIGNATURE, { exact: true }).waitFor();
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
    await loyaltyTierNode.click();
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

    // Readers can independently switch previews from hover dwell to click-to-open. Restore the
    // source-comment diff before exercising that contract, then restore hover for the journey.
    await preferencesButton.click();
    await hideSourceCommentDiff.uncheck();
    await preferencesPane.getByRole("radio", { name: /^On click/ }).check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();
    await loyaltyTierNode.hover();
    await page.waitForTimeout(350);
    expect(await loyaltyPreview.count()).toBe(0);
    await loyaltyTierNode.click();
    await loyaltyPreview.waitFor();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    expect(await loyaltyPreview.isVisible()).toBe(true);
    await clickBareCanvas(page, extractedReviewSurface);
    await loyaltyPreview.waitFor({ state: "detached" });
    await preferencesButton.click();
    await preferencesPane.getByRole("radio", { name: /^On hover/ }).check();
    await preferencesPane.getByRole("button", { name: "Close review preferences" }).click();

    const loyaltyCodeButton = loyaltyTierNode.getByRole("button", { name: "View source" });
    await loyaltyCodeButton.click();
    const loyaltySourceDialog = page.getByRole("dialog", { name: "Source code" });
    await loyaltySourceDialog.waitFor();
    await loyaltySourceDialog.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

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

    // The modal intentionally covers the control panel, so dispatch the preference toggle without
    // pointer actionability; this keeps the same mounted source table available for comparison.
    await hideComments.dispatchEvent("click");
    await existingCommentCard.waitFor({ state: "detached" });
    const gutterWithoutComment = await gutter.boundingBox();
    const numberWithoutComment = await lineNumber.boundingBox();
    if (gutterWithoutComment === null || numberWithoutComment === null) {
      throw new Error("source gutter layout is not measurable");
    }
    expect(Math.abs(gutterWithComment.width - gutterWithoutComment.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(numberWithComment.x - numberWithoutComment.x)).toBeLessThanOrEqual(1);
    await viewComments.dispatchEvent("click");
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

    // Add the second distinct line draft through the full-source gutter. An attempted modal close
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
    await page.keyboard.press("Escape");
    await loyaltySourceDialog.waitFor({ state: "detached" });

    // 4e — one unit tick completes the added file and advances the header fraction.
    await page.getByText("0/3 files viewed", { exact: true }).waitFor();
    await addedBlock.getByTitle("Mark as reviewed").first().click();
    await page.getByText("1/3 files viewed", { exact: true }).waitFor();

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

    // 4g — URL-backed reload restores the review; the checked unit remains in localStorage.
    const storedTick = await storedUnitTicks(page);
    expect(Object.keys(storedTick.unitTicks)).toHaveLength(1);
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("rev") === "1");
    expect(new URL(page.url()).searchParams.get("rev")).toBe("1");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 60_000 });
    await syncProvenance.waitFor();
    expect(await storedUnitTicks(page)).toEqual(storedTick);

    // 4h — Escape closes the source modal only; repeated Escape and outward zoom leave the review
    // overlay in place, while explicit Close parks it for the text-only Resume chip. The source
    // graph stays mounted beneath Minimal Graph, but an active PR review is its own navigation root.
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
    await page.keyboard.press("Escape");
    await sourceDialog.waitFor({ state: "detached" });
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
  fixture = buildPrReviewFixture();
  const smartGit = await startSmartGitServer(fixture);
  smartGitServer = smartGit.server;
  await verifySmartHttpClone(smartGit.repoUrl);
  restoreGitRedirect = installGitRedirect(smartGit.repoUrl);

  vi.stubGlobal("fetch", fakeGitHub(fixture, submittedReviews));
  webServer = createWebServer({
    rendererRoot: dirname(RENDERER_INDEX),
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    githubClientId: "Iv1.meridian-e2e",
    fallbackToken: "meridian-e2e-token",
    fallbackUser: { login: "e2e-reviewer", avatarUrl: null },
  });
  const baseUrl = await listenServer(webServer);
  const generated = await generateSession(baseUrl);
  viewUrl = `${baseUrl}/view?id=${encodeURIComponent(generated.id)}`;

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
}

async function teardown(): Promise<void> {
  await browser?.close();
  await closeServer(webServer);
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
  for (let row = 1; row <= 7; row += 1) {
    for (let column = 1; column <= 7; column += 1) {
      const point = {
        x: bounds.x + (bounds.width * column) / 8,
        y: bounds.y + (bounds.height * row) / 8,
      };
      const isBare = await pane.evaluate(
        (element, candidate) => document.elementFromPoint(candidate.x, candidate.y) === element,
        point,
      );
      if (isBare) {
        await target.mouse.click(point.x, point.y);
        return;
      }
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
  const summary = {
    number: 7,
    title: "Add loyalty tiers",
    user: { login: "e2e-reviewer" },
    head: { ref: "pr-head" },
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

async function storedUnitTicks(target: Page): Promise<{ key: string; unitTicks: Record<string, unknown> }> {
  return target.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("meridian.review."));
    if (!key) throw new Error("review progress was not written to localStorage");
    const record = JSON.parse(localStorage.getItem(key) ?? "null") as { unitTicks?: Record<string, unknown> } | null;
    return { key, unitTicks: record?.unitTicks ?? {} };
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
