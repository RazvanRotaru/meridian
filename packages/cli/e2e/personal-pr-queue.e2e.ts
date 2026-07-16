/** The landing PR picker keeps the signed-in user's work and review state visible at a glance. */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const REPOSITORY = "acme/service";
const STORAGE_KEY = "meridian.selectedRepository";

let server: Server | undefined;
let browser: Browser | undefined;
let page: Page;
let baseUrl = "";

describe.skipIf(!chromiumInstalled())("personal pull request queue (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("https://**", (route) => route.abort());
    page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ key, repository }) => localStorage.setItem(key, repository), { key: STORAGE_KEY, repository: REPOSITORY });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#me-login").getByText("astrid", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Review pull request" }).click();
    await page.locator("#pr-query:not([disabled])").waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await closeServer(server);
  });

  it("groups the personal queue and labels the viewer's relationship to each PR", async () => {
    await page.locator("#pr-query").focus();
    const results = page.locator("#pr-results");
    await results.waitFor();

    expect(await results.locator(".group-label").allTextContents()).toEqual([
      "My pull requests",
      "Needs your review",
      "Reviewed by you",
      "Other pull requests",
    ]);
    expect(await results.locator(".personal-pr-badge").allTextContents()).toEqual([
      "Yours",
      "Review requested",
      "You approved",
    ]);
    expect(await results.locator('[role="option"]').allTextContents()).toEqual([
      "#14Ship my featureYoursastrid · mine → main · updated recently",
      "#13Review the APIReview requestedmina · api → main · updated recently",
      "#12Polish docsYou approvedlee · docs → main · updated recently",
      "#11Routine cleanupsam · cleanup → main · updated recently",
    ]);
  });

  it("places the signed-in author first and filters to their PRs", async () => {
    await page.locator("#pr-query").press("Escape");
    await page.locator("#pr-author-trigger").click();
    const authorOptions = page.locator("#pr-author-options button");
    expect(await authorOptions.allTextContents()).toEqual([
      "My pull requests · astrid",
      "All authors",
      "lee",
      "mina",
      "sam",
    ]);

    await authorOptions.first().click();
    await page.locator("#pr-query").focus();
    expect(await page.locator('#pr-results [role="option"]').allTextContents()).toEqual([
      "#14Ship my featureYoursastrid · mine → main · updated recently",
    ]);
    await expect.poll(() => page.locator("#pr-status").textContent()).toContain("1 shown");
  });
});

function createLandingServer(): Server {
  const landingHtml = readFileSync(WEB_UI, "utf8");
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") return html(response, landingHtml);
    if (url.pathname === "/api/auth/session") {
      return json(response, { signedIn: true, user: { login: "astrid", avatarUrl: null } });
    }
    if (url.pathname === "/api/repos/mine") return json(response, { repos: [] });
    if (url.pathname === "/api/repos/branches") return json(response, { branches: ["main"] });
    if (url.pathname === "/api/repos/pulls") {
      return json(response, { viewerLogin: "astrid", prs: pullRequests(), hasMore: false });
    }
    return json(response, { error: `Unexpected fixture route: ${request.method} ${url.pathname}` }, 404);
  });
}

function pullRequests(): unknown[] {
  return [
    summary(11, "Routine cleanup", "sam", "cleanup"),
    { ...summary(12, "Polish docs", "lee", "docs"), viewerStatus: { reviewRequested: false, review: "approved" } },
    { ...summary(13, "Review the API", "mina", "api"), viewerStatus: { reviewRequested: true, review: null } },
    summary(14, "Ship my feature", "astrid", "mine"),
  ];
}

function summary(number: number, title: string, author: string, headRef: string): Record<string, unknown> {
  return {
    number,
    title,
    author,
    headRef,
    baseRef: "main",
    updatedAt: "",
    draft: false,
    state: "open",
  };
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function closeServer(target: Server | undefined): Promise<void> {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
}
