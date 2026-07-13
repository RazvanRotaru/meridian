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
const EXISTING_COMMENT_TEXT = "Should this threshold stay aligned with the billing tier?";
const EDITED_EXISTING_COMMENT_TEXT = "Keep this threshold aligned with the billing tier.";
const THREAD_REPLY_TEXT = "Agreed — I will keep the two thresholds together.";
const EXISTING_COMMENT_LINE = 2;
const ORDER_SERVICE_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/services/orderService.ts" });
const PRICING_PACKAGE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing" });
const PRICING_SERVICE_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing/pricingService.ts" });
const LOYALTY_TIERS_MODULE_ID = buildNodeId({ lang: "ts", modulePath: "src/pricing/loyaltyTiers.ts" });
const LOYALTY_TIER_FUNCTION_ID = buildNodeId({
  lang: "ts",
  modulePath: "src/pricing/loyaltyTiers.ts",
  qualname: "loyaltyTierFor",
});
const nativeFetch = globalThis.fetch.bind(globalThis);

interface SubmittedReview {
  event: string;
  body?: string;
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

    // 4b — the real-patch response has exactly two files and prepares the HEAD graph before opening the review.
    const detail = page.locator("aside.mrd-scroll");
    const detailFiles = detail.locator(
      '[title="src/pricing/loyaltyTiers.ts"], [title="src/services/orderService.ts"]',
    );
    await detailFiles.first().waitFor();
    expect(await detailFiles.count()).toBe(2);
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
    await page.mouse.move(0, 0);
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

    // 4c — the added file is immediately in the prepared HEAD graph with reviewable units.
    let addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    let addedBlock = addedFile.locator("xpath=../..");
    const addedUnits = addedBlock.getByTitle("Mark as reviewed");
    await addedUnits.first().waitFor();
    expect(await addedUnits.count()).toBeGreaterThan(0);
    expect(await addedFile.getByText("added — extract head to view", { exact: true }).count()).toBe(0);

    // 4d — existing GitHub comments live on their HEAD source line in both canvas code hosts;
    // the review-panel control hides and restores that layer without disabling either host.
    const extractedReviewSurface = page.getByRole("region", { name: "Extracted graph" });
    const loyaltyTierNode = extractedReviewSurface.locator(`.react-flow__node[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await loyaltyTierNode.waitFor();
    const loyaltyCommentIndicator = extractedReviewSurface
      .locator(`[data-review-comment-node-id="${LOYALTY_TIER_FUNCTION_ID}"]`)
      .getByRole("img", { name: "1 review comment" });
    await loyaltyCommentIndicator.waitFor();
    expect(await extractedReviewSurface.locator(`[data-review-comment-node-id="${ORDER_SERVICE_MODULE_ID}"]`).count()).toBe(0);
    await loyaltyTierNode.hover();
    const loyaltyPreview = page.getByRole("dialog", { name: "Code preview for loyaltyTierFor" });
    await loyaltyPreview.waitFor();
    await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

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
    const loyaltyCodeButton = loyaltyTierNode.getByRole("button", { name: "View source" });
    await loyaltyCodeButton.click();
    const loyaltySourceDialog = page.getByRole("dialog", { name: "Source code" });
    await loyaltySourceDialog.waitFor();
    await loyaltySourceDialog.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

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

    // Add two distinct line drafts through the source gutter. Deriving both anchors from the
    // patch-header span proves the UI only offers GitHub-valid RIGHT-side rows, and exercising two
    // rows guards against collapsing all local drafts into one top-level review summary.
    const inlineRange = fixture!.files[0].headerHunks[0];
    const firstInlineLine = inlineRange.start;
    const secondInlineLine = inlineRange.end;
    expect(secondInlineLine).toBeGreaterThan(firstInlineLine);
    await addInlineDraft(loyaltySourceDialog, firstInlineLine, DRAFT_TEXT);
    await addInlineDraft(loyaltySourceDialog, secondInlineLine, SECOND_DRAFT_TEXT);
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
    await page.getByText("0/2 files viewed", { exact: true }).waitFor();
    await addedBlock.getByTitle("Mark as reviewed").first().click();
    await page.getByText("1/2 files viewed", { exact: true }).waitFor();

    // 4f — submit one GitHub review whose two drafts stay as two ordered inline comments.
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText("Review submitted", { exact: true }).waitFor();
    expect(submittedReviews).toEqual([
      {
        event: "COMMENT",
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

async function addInlineDraft(sourceDialog: Locator, line: number, body: string): Promise<void> {
  const sourceRow = sourceDialog.locator(`tr[data-source-line="${line}"]`);
  await sourceRow.scrollIntoViewIfNeeded();
  await sourceRow.hover();
  await sourceRow.getByRole("button", { name: `Comment on line ${line}`, exact: true }).click();
  await sourceDialog.getByPlaceholder(`Comment on line ${line}…`).fill(body);
  await sourceDialog.getByRole("button", { name: "Add comment", exact: true }).click();
  await sourceDialog
    .locator(`[data-pending-review-comments-line="${line}"]`)
    .getByText(body, { exact: true })
    .waitFor();
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
