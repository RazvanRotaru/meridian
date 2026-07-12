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
const EXISTING_COMMENT_TEXT = "Should this threshold stay aligned with the billing tier?";
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
    await codebaseContext.locator(`[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor();
    await codebaseContext.locator(`[data-id="${ORDER_SERVICE_MODULE_ID}"]`).waitFor();
    const unchangedModule = codebaseContext.locator(`[data-id="${PRICING_SERVICE_MODULE_ID}"]`);
    await unchangedModule.waitFor();
    const changedFunction = codebaseContext.locator(`[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await changedFunction.waitFor();
    await expect.poll(
      () => changedFunction.evaluate((element) => getComputedStyle(element.firstElementChild as Element).backgroundImage),
    ).not.toBe("none");
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
    const pricingContext = codebaseContext.locator(`[data-id="${PRICING_PACKAGE_ID}"]`);
    await pricingContext.getByRole("button", { name: "Collapse" }).click();
    await codebaseContext.locator(`[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor({ state: "detached" });
    await codebaseContext.locator(`[data-id="${ORDER_SERVICE_MODULE_ID}"]`).waitFor();
    await pricingContext.getByRole("button", { name: "Expand" }).click();
    await codebaseContext.locator(`[data-id="${LOYALTY_TIERS_MODULE_ID}"]`).waitFor();
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
    const loyaltyTierNode = extractedReviewSurface.locator(`[data-id="${LOYALTY_TIER_FUNCTION_ID}"]`);
    await loyaltyTierNode.waitFor();
    await loyaltyTierNode.hover();
    const loyaltyPreview = page.getByRole("dialog", { name: "Code preview for loyaltyTierFor" });
    await loyaltyPreview.waitFor();
    await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).waitFor();

    const hideComments = page.getByRole("button", { name: "Hide comments", exact: true });
    await hideComments.waitFor();
    expect(await hideComments.getAttribute("aria-pressed")).toBe("true");
    await hideComments.click();
    await loyaltyPreview.waitFor({ state: "detached" });
    const viewComments = page.getByRole("button", { name: "View comments", exact: true });
    await viewComments.waitFor();
    expect(await viewComments.getAttribute("aria-pressed")).toBe("false");

    await loyaltyTierNode.hover();
    await loyaltyPreview.waitFor();
    expect(await loyaltyPreview.getByText(EXISTING_COMMENT_TEXT, { exact: true }).count()).toBe(0);
    await viewComments.click();
    await loyaltyPreview.waitFor({ state: "detached" });
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
    await page.keyboard.press("Escape");
    await loyaltySourceDialog.waitFor({ state: "detached" });

    // 4e — one unit tick completes the added file and advances the header fraction.
    await page.getByText("0/2 files viewed", { exact: true }).waitFor();
    await addedBlock.getByTitle("Mark as reviewed").first().click();
    await page.getByText("1/2 files viewed", { exact: true }).waitFor();

    // 4f — comment on that unit and submit exactly one GitHub review payload.
    addedFile = reviewFileButton(page, "src/pricing/loyaltyTiers.ts");
    addedBlock = addedFile.locator("xpath=../..");
    await addedBlock.getByTitle("Expand").click();
    const unitTick = addedBlock.getByTitle("Mark as reviewed").first();
    await unitTick.waitFor();
    const unitRow = unitTick.locator("xpath=..");
    await unitRow.hover();
    await unitRow.getByTitle("Add a comment").click();
    await addedBlock.locator("textarea").fill(DRAFT_TEXT);
    await addedBlock.getByRole("button", { name: "Add comment" }).click();
    await page.getByText("1 comment", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Submit review" }).click();
    await page.getByText("Review submitted", { exact: true }).waitFor();
    expect(submittedReviews).toEqual([
      {
        event: "COMMENT",
        comments: [
          {
            path: "src/pricing/loyaltyTiers.ts",
            line: fixture!.files[0].detail.hunks[0].start,
            side: "RIGHT",
            body: DRAFT_TEXT,
          },
        ],
      },
    ]);

    // 4g — URL-backed reload restores the review; the checked unit remains in localStorage.
    const storedTick = await storedUnitTicks(page);
    expect(Object.keys(storedTick.unitTicks)).toHaveLength(1);
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("rev") === "1");
    expect(new URL(page.url()).searchParams.get("rev")).toBe("1");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 60_000 });
    await syncProvenance.waitFor();
    expect(await storedUnitTicks(page)).toEqual(storedTick);

    // 4h — Escape closes the source modal only; repeated Escape leaves the overlay in place, and
    // explicit Close parks the review for the text-only Resume chip.
    // The source graph stays mounted beneath Minimal Graph so outward semantic zoom can reveal its
    // exact viewport. Scope this raw CSS locator to the extracted surface rather than matching the
    // intentionally retained source copy of the same file card.
    const extractedSurface = page.getByRole("region", { name: "Extracted graph" });
    const codeButton = extractedSurface.locator(
      `[data-id="${ORDER_SERVICE_MODULE_ID}"] button[aria-label="View source"]`,
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
          body: EXISTING_COMMENT_TEXT,
          user: { login: "existing-reviewer" },
          created_at: "2026-07-11T09:30:00Z",
          updated_at: "2026-07-11T09:30:00Z",
          html_url: "https://github.com/e2e/shop/pull/7#discussion_r7001",
        },
      ]);
    }
    if (request.method === "GET" && path.endsWith("/pulls/7/reviews")) return json([]);
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
