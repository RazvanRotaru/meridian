/** The landing PR picker becomes usable after page one while later GitHub pages load. */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PR_PREPARE_CLIENT, chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const REPOSITORY = "acme/progressive-service";
const PULL_REQUEST_ROUTE = /\/api\/repos\/pulls\?/;

let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext;
let page: Page;
let baseUrl = "";
let releaseSecondPage: (() => void) | undefined;

describe.skipIf(!chromiumInstalled())("progressive landing PR picker (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("https://**", (route) => route.abort());
    const secondPageGate = deferred();
    releaseSecondPage = secondPageGate.resolve;
    await context.route(PULL_REQUEST_ROUTE, async (route) => {
      const requestUrl = new URL(route.request().url());
      const requestedPage = Number(requestUrl.searchParams.get("page"));
      if (requestedPage === 2) await secondPageGate.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(requestedPage === 1
          ? firstPullRequestPage()
          : { prs: [pullRequest(31)], hasMore: false }),
      });
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    releaseSecondPage?.();
    await browser?.close();
    await closeServer(server);
  });

  it("keeps keyboard selection active while the remaining PR queue arrives", async () => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openReviewPicker(page);

    await page.getByText("30 open pull requests loaded · loading more…", { exact: true }).waitFor();
    const query = page.locator("#pr-query");
    expect(await query.isEnabled()).toBe(true);
    await query.click();
    await query.press("ArrowDown");
    expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
    await query.press("Enter");
    await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
    expect(await query.inputValue()).toContain("#1");
    await query.click();
    await query.press("ArrowDown");
    expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");

    releaseSecondPage?.();
    await page.getByText("31 open pull requests loaded", { exact: true }).waitFor();
    expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
    expect(await query.inputValue()).toContain("#1");
    await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
    expect(pageErrors).toEqual([]);
  });

  it("keeps keyboard selection active when a later page fails", async () => {
    const failureGate = deferred();
    await page.route(PULL_REQUEST_ROUTE, async (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get("page"));
      if (requestedPage === 2) await failureGate.promise;
      await route.fulfill(requestedPage === 1
        ? { contentType: "application/json", body: JSON.stringify(firstPullRequestPage()) }
        : { status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate limited" }) });
    });
    try {
      await openReviewPicker(page);
      await page.getByText("30 open pull requests loaded · loading more…", { exact: true }).waitFor();
      const query = page.locator("#pr-query");
      await query.click();
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
      await query.press("Enter");
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      expect(await query.inputValue()).toContain("#1");
      await query.click();
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");

      failureGate.resolve();
      await page.getByText(
        "30 open pull requests loaded · Could not load more pull requests: rate limited",
        { exact: true },
      ).waitFor();
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      expect(await query.inputValue()).toContain("#1");
    } finally {
      failureGate.resolve();
      await page.unroute(PULL_REQUEST_ROUTE);
    }
  });

  it("inserts later personalized groups in canonical order without retargeting a page-one selection", async () => {
    const pageGate = deferred();
    let preparationRequest: Record<string, unknown> | undefined;
    await page.route("**/api/pr/prepare", async (route) => {
      preparationRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture preparation stop" }),
      });
    });
    await page.route(PULL_REQUEST_ROUTE, async (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get("page"));
      if (requestedPage === 2) await pageGate.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(requestedPage === 1
          ? {
              prs: [
                pullRequest(1, { author: "other-author" }),
                pullRequest(2, { author: "reviewed-author", viewerStatus: { review: "approved" } }),
              ],
              hasMore: true,
              viewerLogin: "fixture-user",
            }
          : {
              prs: [
                pullRequest(3, { author: "fixture-user" }),
                pullRequest(4, { author: "requested-author", viewerStatus: { reviewRequested: true } }),
              ],
              hasMore: false,
              viewerLogin: "fixture-user",
            }),
      });
    });
    try {
      await openReviewPicker(page);
      await page.getByText("2 open pull requests loaded · loading more…", { exact: true }).waitFor();
      const query = page.locator("#pr-query");
      await query.click();
      await page.locator("#pr-result-1").click();
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      expect(await query.inputValue()).toContain("#1");

      await query.click();
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-2");
      pageGate.resolve();
      await page.getByText("4 open pull requests loaded", { exact: true }).waitFor();

      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-2");
      expect(await query.inputValue()).toContain("#1");
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      expect(await page.locator("#pr-results").evaluate((list) => [...list.children].flatMap((group) => {
        const label = group.querySelector(".group-label")?.textContent;
        return [
          ...(label ? [label] : []),
          ...[...group.querySelectorAll('[role="option"]')].map((option) => option.id),
        ];
      }))).toEqual([
        "My pull requests",
        "pr-result-3",
        "Needs your review",
        "pr-result-4",
        "Reviewed by you",
        "pr-result-2",
        "Other pull requests",
        "pr-result-1",
      ]);

      await page.locator("#submit").click();
      await page.getByText("fixture preparation stop", { exact: true }).waitFor();
      expect(preparationRequest).toEqual({
        owner: "acme",
        repo: "progressive-service",
        prNumber: 1,
        baseRef: "main",
        headRef: "feature-1",
      });
    } finally {
      pageGate.resolve();
      await page.unroute("**/api/pr/prepare");
      await page.unroute(PULL_REQUEST_ROUTE);
    }
  });

  it("defers author-menu reconciliation until an open menu releases focus", async () => {
    const pageGate = deferred();
    await page.route(PULL_REQUEST_ROUTE, async (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get("page"));
      if (requestedPage === 2) await pageGate.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(requestedPage === 1
          ? { prs: [pullRequest(1, { author: "zeta" }), pullRequest(2, { author: "alpha" })], hasMore: true }
          : { prs: [pullRequest(3, { author: "beta" })], hasMore: false }),
      });
    });
    try {
      await openReviewPicker(page);
      await page.getByText("2 open pull requests loaded · loading more…", { exact: true }).waitFor();
      const trigger = page.locator("#pr-author-trigger");
      await trigger.press("ArrowDown");
      await page.locator("#pr-author-options").waitFor({ state: "visible" });
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("pr-author-option-0");
      expect(await page.locator("#pr-author-options [role=option]").allTextContents()).toEqual([
        "All authors", "alpha", "zeta",
      ]);

      pageGate.resolve();
      await page.getByText("3 open pull requests loaded", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pr-author-option-0");
      expect(await page.locator("#pr-author-options [role=option]").allTextContents()).toEqual([
        "All authors", "alpha", "zeta",
      ]);

      await page.locator("#pr-author-option-0").press("Escape");
      await trigger.click();
      expect(await page.locator("#pr-author-options [role=option]").allTextContents()).toEqual([
        "All authors", "alpha", "beta", "zeta",
      ]);
    } finally {
      pageGate.resolve();
      await page.unroute(PULL_REQUEST_ROUTE);
    }
  });
});

async function openReviewPicker(target: Page): Promise<void> {
  await target.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await target.evaluate((repository) => {
    localStorage.setItem("meridian.selectedRepository", repository);
  }, REPOSITORY);
  await target.reload({ waitUntil: "domcontentloaded" });
  await target.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();
  await target.locator("#intent-review").click();
}

function createLandingServer(): Server {
  const landingHtml = readFileSync(WEB_UI, "utf8");
  const prPrepareClient = readFileSync(PR_PREPARE_CLIENT, "utf8");
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(landingHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/pr-prepare-client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(prPrepareClient);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      sendJson(response, 200, { signedIn: true, user: { login: "fixture-user", avatarUrl: null } });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/api/repos/mine" || url.pathname === "/api/repos/search")) {
      sendJson(response, 200, { repos: [repositorySummary()] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/repos/branches") {
      sendJson(response, 200, { branches: ["main"] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/cache/status") {
      sendJson(response, 200, { status: "miss" });
      return;
    }
    sendJson(response, 404, { error: `Unexpected fixture route: ${request.method} ${url.pathname}` });
  });
}

function repositorySummary(): Record<string, unknown> {
  return {
    fullName: REPOSITORY,
    isPrivate: false,
    defaultBranch: "main",
    description: null,
    ownerAvatarUrl: null,
  };
}

function pullRequest(
  number: number,
  overrides: { author?: string; viewerStatus?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    number,
    title: `Progressive review ${number}`,
    author: overrides.author ?? "octocat",
    headRef: `feature-${number}`,
    baseRef: "main",
    updatedAt: "2026-07-15T12:00:00Z",
    draft: false,
    state: "open",
    ...(overrides.viewerStatus ? { viewerStatus: overrides.viewerStatus } : {}),
  };
}

function firstPullRequestPage(): Record<string, unknown> {
  return { prs: Array.from({ length: 30 }, (_, index) => pullRequest(index + 1)), hasMore: true };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function closeServer(target: Server | undefined): Promise<void> {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
