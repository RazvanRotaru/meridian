/**
 * One ordered browser journey through the complete GitHub PR-review loop: strict two-sided
 * preparation, streamed progress, comments, URL restore, layered Escape, and bounded resume.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { buildNodeId } from "@meridian/core";
import { createWebServer, type WebServerHandle } from "../src/server/web-server";
import {
  PYTHON_REVIEW_PATH,
  RENDERER_INDEX,
  buildPrReviewFixture,
  chromiumInstalled,
  ensureBuilt,
  listenServer,
  startSmartGitServer,
  verifySmartHttpMirrorTransport,
  type PrReviewFixture,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const DRAFT_TEXT = "Please keep this tier boundary explicit.";
const EDITED_DRAFT_TEXT = "Please keep this tier boundary explicit and documented.";
const SECOND_DRAFT_TEXT = "Please cover the standard-tier fallback with a focused test.";
const EXISTING_COMMENT_TEXT = "Should this threshold stay aligned with the billing tier for every existing customer configuration, including installations that still rely on the previous browser-prefix allowlist behavior?";
const EDITED_EXISTING_COMMENT_TEXT = "Keep this threshold aligned with the billing tier.";
const THREAD_REPLY_TEXT = "Agreed — I will keep the two thresholds together.";
const SOURCE_COMMENT_TEXT = "// Keep the loyalty threshold explicit before choosing the customer's tier.";
const SOURCE_COMMENT_LINE = 2;
const LOYALTY_RETURN_LINE = 3;
const EXISTING_COMMENT_LINE = LOYALTY_RETURN_LINE;
const ORDER_SERVICE_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/services/orderService.ts" });
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
let webServer: WebServerHandle | undefined;
let browser: Browser | undefined;
let page: Page;
let viewUrl = "";
let restoreGitRedirect: (() => void) | undefined;
const submittedReviews: SubmittedReview[] = [];
const rendererDiagnostics: string[] = [];

describe.skipIf(!chromiumInstalled())("pull-request review (headless chromium)", () => {
  beforeAll(setup, 180_000);
  afterAll(teardown);

  it("completes the full review journey in order", async () => {
    // 4a — load the GitHub session, enter the PR page, and select PR #7.
    await page.goto(viewUrl, { waitUntil: "domcontentloaded" });
    await waitForLandingPrCount(page, "1 open");
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
    const syncProvenance = page.getByText(
      `pr-head → main · HEAD @${fixture!.headSha.slice(0, 7)}`,
      { exact: true },
    );
    await syncProvenance.waitFor({ timeout: 120_000 });
    const extractedReviewSurface = page.getByRole("region", { name: "Extracted graph" });
    await extractedReviewSurface.waitFor();
    expect(await page.getByRole("region", { name: "Extracted selection" }).count()).toBe(0);

    // Preparation lands on an honest manifest overview. No changed-file graph is resident until
    // the reader selects one, and graph-only actions stay unavailable on that zero-node surface.
    expect(await extractedReviewSurface.locator(".react-flow__node").count()).toBe(0);
    const codebaseButton = page.getByRole("button", { name: "Highlight code in codebase" });
    expect(await codebaseButton.getAttribute("aria-disabled")).toBe("true");
    let addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    await addedFile.getByText("load graph", { exact: true }).waitFor();
    await addedFile.click();
    const loyaltyTierNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await loyaltyTierNode.waitFor({ timeout: 30_000 });
    expect(await codebaseButton.getAttribute("aria-disabled")).toBeNull();

    // The bounded codebase context is an alternate read-only surface, not a review close/reopen:
    // only the currently selected file projection is widened. Other changed files remain absent
    // rather than being retained together behind the current view.
    await codebaseButton.click();
    const codebaseContext = page.getByRole("region", { name: "Codebase context graph" });
    try {
      await codebaseContext.getByText("READ-ONLY", { exact: true }).waitFor();
    } catch (error) {
      const body = (await page.locator("body").innerText()).slice(0, 6_000);
      throw new Error(
        `Codebase context did not open. Visible UI:\n${body}\nRenderer diagnostics:\n${rendererDiagnostics.join("\n")}`,
        { cause: error },
      );
    }
    await codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor();
    const unchangedModule = codebaseContext.locator(`.react-flow__node[data-id="${PRICING_SERVICE_MODULE_ID}"]`);
    await unchangedModule.waitFor();
    const changedFunction = codebaseContext.locator(`.react-flow__node[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await changedFunction.waitFor();
    expect(await codebaseContext.locator(`.react-flow__node[data-id="${PYTHON_RISK_FUNCTION_ID}"]`).count()).toBe(0);
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
    // The sibling arrived through the view-scoped projection and still resolves immutable HEAD source.
    await unchangedModule.hover();
    const codePreview = page.getByRole("dialog", { name: /^Code preview for / });
    await codePreview.getByText("src/pricing/pricingService.ts", { exact: true }).waitFor();
    await codePreview.getByText("export class PricingService {", { exact: true }).waitFor();
    await page.getByText("Files changed", { exact: true }).hover();
    await codePreview.waitFor({ state: "detached" });

    const expansionParam = new URL(page.url()).searchParams.get("mexp");
    // Disclosure in the bounded context belongs to a container guaranteed by the current file
    // coordinate. Ancestor packages may be compacted out of a narrow projection and are not a
    // stable interaction target.
    const loyaltyModuleContext = codebaseContext.locator(
      `.react-flow__node[data-id="${LOYALTY_TIERS_MODULE_ID}"]`,
    );
    await loyaltyModuleContext.getByRole("button", { name: "Collapse" }).click();
    await changedFunction.waitFor({ state: "detached" });
    await loyaltyModuleContext.getByRole("button", { name: "Expand" }).click();
    await changedFunction.waitFor();
    expect(new URL(page.url()).searchParams.get("mexp")).toBe(expansionParam);
    await page.getByRole("button", { name: "Back to extracted graph" }).click();
    await page.getByRole("region", { name: "Extracted graph" }).waitFor();
    await syncProvenance.waitFor();

    // 4c — additions to the current graph remain bounded to that file coordinate. Navigating to a
    // later changed file replaces the resident graph; navigating back reactivates it from cache.
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

    const pythonFile = reviewFileButton(page, PYTHON_REVIEW_PATH);
    await pythonFile.getByText("load graph", { exact: true }).waitFor();
    await pythonFile.click();
    const pythonRiskNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${PYTHON_RISK_FUNCTION_ID}"]`);
    await pythonRiskNode.waitFor();
    await loyaltyTierNode.waitFor({ state: "detached" });
    const pythonUnits = pythonFile.locator("xpath=../..").getByTitle("Mark as reviewed");
    await pythonUnits.first().waitFor();
    expect(await pythonUnits.count()).toBeGreaterThan(0);
    await pythonRiskNode.getByRole("button", { name: "View source" }).click();
    const pythonSourceDialog = page.getByRole("dialog", { name: "Source code" });
    await pythonSourceDialog.waitFor();
    await pythonSourceDialog.getByText(PYTHON_RISK_SIGNATURE, { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await pythonSourceDialog.waitFor({ state: "detached" });

    await addedFile.click();
    await loyaltyTierNode.waitFor();
    await pythonRiskNode.waitFor({ state: "detached" });
    await pythonFile.getByText("load graph", { exact: true }).waitFor();
    addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    const addedBlock = addedFile.locator("xpath=../..");
    const addedUnits = addedBlock.getByTitle("Mark as reviewed");
    await addedUnits.first().waitFor();
    expect(await addedUnits.count()).toBeGreaterThan(0);
    expect(await addedFile.getByText("added — extract head to view", { exact: true }).count()).toBe(0);

    // 4d — existing GitHub comments live on their HEAD source line in both canvas code hosts;
    // the review-panel control hides and restores that layer without disabling either host.
    const loyaltyCommentIndicator = extractedReviewSurface
      .locator(`[data-review-comment-node-id="${LOYALTY_TIER_FUNCTION_ID}"]`)
      .getByRole("button", { name: "1 review comment" });
    await loyaltyCommentIndicator.waitFor();
    expect(await extractedReviewSurface.locator(`[data-review-comment-node-id="${ORDER_SERVICE_MODULE_ID}"]`).count()).toBe(0);
    await loyaltyTierNode.hover();
    const loyaltyPreview = page.getByRole("dialog", { name: "Code preview for loyaltyTierFor" });
    await loyaltyPreview.waitFor();
    await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();
    const sourceCommentRow = loyaltyPreview.locator(`tr[data-source-line="${SOURCE_COMMENT_LINE}"]`);
    const loyaltyReturnRow = loyaltyPreview.locator(`tr[data-source-line="${LOYALTY_RETURN_LINE}"]`);
    await sourceCommentRow.getByText(SOURCE_COMMENT_TEXT, { exact: true }).waitFor();
    expect(await sourceCommentRow.getAttribute("data-diff-origin")).toBe("add");
    expect(await loyaltyReturnRow.getAttribute("data-diff-origin")).toBe("add");

    const hideComments = page.getByRole("button", { name: "Hide comments", exact: true });
    await hideComments.waitFor();
    expect(await hideComments.getAttribute("aria-pressed")).toBe("true");
    await hideComments.click();
    await loyaltyPreview.waitFor({ state: "detached" });
    await loyaltyCommentIndicator.waitFor({ state: "detached" });
    const viewComments = page.getByRole("button", { name: "View comments", exact: true });
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

    // Starting a line comment turns the default hover preview into a sticky work surface. Pointer
    // movement past the full hover-close grace preserves the exact draft, adding it keeps the card
    // open with Pending confirmation, and only its explicit close control dismisses it.
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
    await loyaltyPreview.getByRole("button", { name: "Close code preview" }).click();
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

    // Readers can independently switch previews from hover dwell to click-to-pin. Restore the
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 60_000 });
    await syncProvenance.waitFor();
    expect(await storedUnitTicks(page)).toEqual(storedTick);
    const restoredExtractedSurface = page.getByRole("region", { name: "Extracted graph" });
    expect(await restoredExtractedSurface.locator(".react-flow__node").count()).toBe(0);
    const orderFile = reviewFileButton(page, "src/services/orderService.ts");
    await orderFile.getByText("load graph", { exact: true }).waitFor();
    await orderFile.click();
    await restoredExtractedSurface.locator(
      `.react-flow__node[data-id="${ORDER_SERVICE_MODULE_ID}"]`,
    ).waitFor({ timeout: 60_000 });

    // 4h — Escape closes the source modal only; repeated Escape and outward zoom leave the review
    // projection in place, while explicit Close parks its semantic return coordinate for the
    // text-only Resume chip. No decoded source graph is mounted behind the active review surface.
    // Scope this raw CSS locator to the extracted surface that owns the current file projection.
    const extractedSurface = restoredExtractedSurface;
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
  await verifySmartHttpMirrorTransport(smartGit.repoUrl);
  restoreGitRedirect = installGitRedirect(smartGit.repoUrl);

  vi.stubGlobal("fetch", fakeGitHub(fixture, submittedReviews));
  webServer = createWebServer({
    rendererRoot: dirname(RENDERER_INDEX),
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    cacheRoot: join(fixture.dir, "cache"),
    githubClientId: "Iv1.meridian-e2e",
    fallbackToken: "meridian-e2e-token",
    fallbackUser: { login: "e2e-reviewer", avatarUrl: null },
  });
  const baseUrl = await listenServer(webServer.server);
  const generated = await generateSession(baseUrl);
  viewUrl = `${baseUrl}/view?id=${encodeURIComponent(generated.id)}`;

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      rendererDiagnostics.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    rendererDiagnostics.push(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/") || (response.ok() && !url.includes("projection"))) return;
    void response.text().then(
      (body) => rendererDiagnostics.push(
        `response ${response.status()} ${url}: ${body.slice(0, 2_000)}`,
      ),
      (error) => rendererDiagnostics.push(
        `response ${response.status()} ${url}: <body unavailable: ${String(error)}>`,
      ),
    );
  });
}

async function teardown(): Promise<void> {
  await browser?.close();
  await webServer?.close();
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

async function waitForLandingPrCount(target: Page, label: string): Promise<void> {
  try {
    await target.getByText(label, { exact: true }).waitFor();
  } catch (error) {
    const body = (await target.locator("body").innerText()).slice(0, 4_000);
    throw new Error(`PR landing count '${label}' did not render at ${target.url()}. Body:\n${body}`, { cause: error });
  }
}

async function lineActionStyle(action: Locator): Promise<{ opacity: string; pointerEvents: string }> {
  return action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, pointerEvents: style.pointerEvents };
  });
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
    body: JSON.stringify({ kind: "github", value: "e2e/shop" }),
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
