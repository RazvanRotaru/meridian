/** The landing PR picker becomes usable after page one while later GitHub pages load. */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const REPOSITORY = "acme/progressive-service";
const PULL_REQUEST_ROUTE = /\/api\/repos\/pulls\?/;

let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext;
let page: Page;
let baseUrl = "";
let releaseSecondPage: (() => void) | undefined;
const priorityPullRequestQueries: string[] = [];

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
      const searchParams = new URL(route.request().url()).searchParams;
      const query = searchParams.get("q");
      if (query) {
        priorityPullRequestQueries.push(query);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ prs: [pullRequest(31)], hasMore: false }),
        });
        return;
      }
      const requestedPage = Number(searchParams.get("page"));
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

  it("accepts a pasted PR number while the remaining queue loads", async () => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await openReviewPicker(page);

      await page.getByText("30 open pull requests loaded · loading more…", { exact: true }).waitFor();
      const query = page.locator("#pr-query");
      expect(await query.isEnabled()).toBe(true);
      await query.fill("#31");
      expect(await query.inputValue()).toBe("#31");
      expect(await query.getAttribute("aria-expanded")).toBe("true");
      await page.getByText("1 match for “#31”", { exact: true }).waitFor();
      expect(priorityPullRequestQueries).toContain("#31");
      expect(await query.getAttribute("aria-busy")).toBe("true");

      releaseSecondPage?.();
      await expect.poll(() => query.getAttribute("aria-busy")).toBe("false");
      await page.getByText("1 match for “#31”", { exact: true }).waitFor();
      expect(await query.inputValue()).toBe("#31");
      expect(await query.getAttribute("aria-expanded")).toBe("true");
      expect(await page.locator("#pr-results").isVisible()).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pr-query");
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-31");
      await query.press("Enter");
      await page.locator("#pr-preview-number").getByText("#31", { exact: true }).waitFor();
      expect(await query.inputValue()).toContain("#31");
      expect(pageErrors).toEqual([]);
    } finally {
      releaseSecondPage?.();
    }
  });

  it("keeps page-one selection active when a later page fails", async () => {
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
      await query.press("Enter");
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
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

  it("inserts later personalized groups in canonical order without retargeting a selection", async () => {
    const pageGate = deferred();
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
                pullRequest(1, {
                  author: "other-author",
                  title: "Retargeted duplicate",
                  headRef: "retargeted",
                  baseRef: "release",
                }),
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
      await query.click();
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-2");

      pageGate.resolve();
      await page.getByText("4 open pull requests loaded", { exact: true }).waitFor();

      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-2");
      expect(await query.inputValue()).toBe("#1 Progressive review 1");
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      await page.locator("#pr-preview-title").getByText("Progressive review 1", { exact: true }).waitFor();
      expect(await page.locator("#pr-preview-meta").textContent()).toContain("feature-1 → main");
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
    } finally {
      pageGate.resolve();
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

  it("regroups loaded rows if viewer identity arrives on a later page", async () => {
    const pageGate = deferred();
    await page.route("**/api/auth/session", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ signedIn: false }),
    }));
    await page.route(PULL_REQUEST_ROUTE, async (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get("page"));
      if (requestedPage === 2) await pageGate.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(requestedPage === 1
          ? {
              prs: [pullRequest(1, { author: "other-author" }), pullRequest(2, { author: "another-author" })],
              hasMore: true,
            }
          : {
              prs: [pullRequest(3, { author: "fixture-user" })],
              hasMore: false,
              viewerLogin: "fixture-user",
            }),
      });
    });
    try {
      await openReviewPicker(page, false);
      await page.getByText("2 open pull requests loaded · loading more…", { exact: true }).waitFor();
      const query = page.locator("#pr-query");
      await query.click();
      await query.press("ArrowDown");
      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
      expect(await page.locator("#pr-results > .pr-result-group").evaluateAll((groups) =>
        groups.map((group) => (group as HTMLElement).dataset.prGroup),
      )).toEqual(["all"]);

      pageGate.resolve();
      await page.getByText("3 open pull requests loaded", { exact: true }).waitFor();

      expect(await query.getAttribute("aria-activedescendant")).toBe("pr-result-1");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pr-query");
      expect(await page.locator("#pr-results").evaluate((list) => [...list.children].flatMap((group) => {
        const label = group.querySelector(".group-label")?.textContent;
        return [
          ...(label ? [label] : []),
          ...[...group.querySelectorAll('[role="option"]')].map((option) => option.id),
        ];
      }))).toEqual([
        "My pull requests",
        "pr-result-3",
        "Other pull requests",
        "pr-result-1",
        "pr-result-2",
      ]);
    } finally {
      pageGate.resolve();
      await page.unroute(PULL_REQUEST_ROUTE);
      await page.unroute("**/api/auth/session");
    }
  });

  it("uses the same cached-first priority search for repository, branch, and PR text", async () => {
    const repoQueries: string[] = [];
    const branchQueries: string[] = [];
    const prQueries: string[] = [];
    const branchPage = deferred();
    const prPage = deferred();
    const repoPattern = "**/api/repos/search?*";
    const branchPattern = "**/api/repos/branches?*";

    await page.route(repoPattern, async (route) => {
      const query = new URL(route.request().url()).searchParams.get("q") ?? "";
      repoQueries.push(query);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          repos: [{ ...repositorySummary(), description: "Distributed tracing and review tools" }],
        }),
      });
    });
    await page.route(branchPattern, async (route) => {
      const query = new URL(route.request().url()).searchParams.get("q");
      if (query) {
        branchQueries.push(query);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ branches: ["release/search-unification"] }),
        });
        return;
      }
      await branchPage.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ branches: ["main", "develop"] }),
      });
    });
    await page.route(PULL_REQUEST_ROUTE, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const query = params.get("q");
      if (query) {
        prQueries.push(query);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            prs: [pullRequest(77, {
              title: "Unify cached-first search",
              headRef: "release/search-unification",
              author: "search-author",
            })],
            hasMore: false,
          }),
        });
        return;
      }
      await prPage.promise;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ prs: [pullRequest(1)], hasMore: false }),
      });
    });

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.removeItem("meridian.selectedRepository"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();

      const repo = page.locator("#repo");
      await repo.fill("distributed tracing");
      await page.getByText("1 repository matches", { exact: true }).waitFor();
      await repo.fill("");
      await repo.fill("distributed tracing");
      await page.getByText("1 repository matches", { exact: true }).waitFor();
      expect(repoQueries).toEqual(["distributed tracing"]);
      await repo.press("ArrowDown");
      await repo.press("Enter");
      await page.locator("#selected-repository-name").getByText(REPOSITORY, { exact: true }).waitFor();

      const branch = page.locator("#ref-query");
      expect(await branch.isEnabled()).toBe(true);
      await branch.fill("release/search-unification");
      await page.locator("#ref-result-release_2Fsearch-unification").waitFor();
      await expect.poll(() => branchQueries).toEqual(["release/search-unification"]);
      await branch.fill("");
      await branch.fill("release/search-unification");
      await page.locator("#ref-result-release_2Fsearch-unification").waitFor();
      expect(branchQueries).toEqual(["release/search-unification"]);
      await branch.press("ArrowDown");
      await branch.press("Enter");
      expect(await page.locator("#ref").inputValue()).toBe("release/search-unification");

      await page.locator("#intent-review").click();
      const pr = page.locator("#pr-query");
      expect(await pr.isEnabled()).toBe(true);
      await pr.fill("release/search-unification");
      await page.locator("#pr-result-77").waitFor();
      await pr.fill("");
      await pr.fill("release/search-unification");
      await page.locator("#pr-result-77").waitFor();
      expect(prQueries).toEqual(["release/search-unification"]);
      await pr.press("ArrowDown");
      await pr.press("Enter");
      await page.locator("#pr-preview-number").getByText("#77", { exact: true }).waitFor();
      expect(await page.locator("#pr-preview-meta").textContent()).toContain(
        "search-author · release/search-unification → main",
      );
      await page.locator("#pr-state-open").click();
      await pr.click();
      await page.locator("#pr-preview-number").getByText("#77", { exact: true }).waitFor();
      expect(await page.locator("#pr-result-77").getAttribute("aria-selected")).toBe("true");
    } finally {
      branchPage.resolve();
      prPage.resolve();
      await page.unroute(repoPattern);
      await page.unroute(branchPattern);
      await page.unroute(PULL_REQUEST_ROUTE);
    }
  });

  it("does not let a stale repository-search failure overwrite the current query", async () => {
    const staleResponse = deferred();
    const repoPattern = "**/api/repos/search?*";
    const seen: string[] = [];
    let staleDelivered = false;
    await page.route(repoPattern, async (route) => {
      const query = new URL(route.request().url()).searchParams.get("q") ?? "";
      seen.push(query);
      if (query === "stale request") {
        await staleResponse.promise;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "stale failure" }),
        });
        staleDelivered = true;
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ repos: [repositorySummary()] }),
      });
    });

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.removeItem("meridian.selectedRepository"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();

      const repo = page.locator("#repo");
      await repo.fill("stale request");
      await expect.poll(() => seen).toContain("stale request");
      await repo.fill("current remote query");
      await page.getByText("1 repository matches", { exact: true }).waitFor();
      staleResponse.resolve();
      await expect.poll(() => staleDelivered).toBe(true);
      await expect.poll(() => page.locator("#repo-status").textContent()).toBe("1 repository matches");
      await page.locator("#repo-result-acme_2Fprogressive-service").waitFor();
    } finally {
      staleResponse.resolve();
      await page.unroute(repoPattern);
    }
  });
});

async function openReviewPicker(target: Page, expectSignedIn = true): Promise<void> {
  await target.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await target.evaluate((repository) => {
    localStorage.setItem("meridian.selectedRepository", repository);
  }, REPOSITORY);
  await target.reload({ waitUntil: "domcontentloaded" });
  if (expectSignedIn) {
    await target.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();
  } else {
    await target.locator("#signin").waitFor();
  }
  await target.locator("#intent-review").click();
}

function createLandingServer(): Server {
  const landingHtml = readFileSync(WEB_UI, "utf8");
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(landingHtml);
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
  overrides: {
    author?: string;
    viewerStatus?: Record<string, unknown>;
    title?: string;
    headRef?: string;
    baseRef?: string;
  } = {},
): Record<string, unknown> {
  return {
    number,
    title: overrides.title ?? `Progressive review ${number}`,
    author: overrides.author ?? "octocat",
    headRef: overrides.headRef ?? `feature-${number}`,
    baseRef: overrides.baseRef ?? "main",
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
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = () => done(); });
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
