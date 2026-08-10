/**
 * The graph-first landing page keeps its primary review workflow usable without page scrolling.
 * This fixture exercises the source HTML directly so viewport regressions fail before packaging.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const BACKGROUND = fileURLToPath(
  new URL("../../renderer/public/landing-renderer-background.png", import.meta.url),
);
const STORAGE_KEY = "meridian.selectedRepository";
const REPOSITORY = "acme/landing-service";

let server: Server | undefined;
let browser: Browser | undefined;
let baseUrl = "";

describe.skipIf(!chromiumInstalled())("graph-first landing layout (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await closeServer(server);
  });

  it("keeps the review dock, picker, and CTA fully usable at 1280x720", async () => {
    const { context, page } = await openLandingPage({ width: 1280, height: 720 });
    try {
      expect(await page.locator(".intent-toggle > button").evaluateAll((buttons) =>
        buttons.map((button) => button.id),
      )).toEqual(["intent-review", "intent-explore"]);
      expect(await page.locator("#intent-review").getAttribute("aria-pressed")).toBe("true");
      expect(await page.locator("#intent-explore").getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator("#review-fields").isVisible()).toBe(true);

      const layout = await page.evaluate(() => {
        const nav = document.querySelector("nav")!.getBoundingClientRect();
        const dock = document.querySelector(".card-wrap")!.getBoundingClientRect();
        const action = document.querySelector("#submit")!.getBoundingClientRect();
        const root = document.documentElement;
        return {
          viewport: { width: innerWidth, height: innerHeight },
          document: {
            width: root.clientWidth,
            height: root.clientHeight,
            scrollWidth: root.scrollWidth,
            scrollHeight: root.scrollHeight,
          },
          nav: { top: nav.top, bottom: nav.bottom, height: nav.height },
          dock: { left: dock.left, right: dock.right, top: dock.top, bottom: dock.bottom },
          action: {
            left: action.left,
            right: action.right,
            top: action.top,
            bottom: action.bottom,
            width: action.width,
            height: action.height,
          },
        };
      });

      expect(layout.document.scrollHeight).toBeLessThanOrEqual(layout.document.height + 1);
      expect(layout.document.scrollWidth).toBeLessThanOrEqual(layout.document.width + 1);
      expect(layout.nav.top).toBeGreaterThanOrEqual(0);
      expect(layout.nav.bottom).toBeLessThanOrEqual(layout.viewport.height);
      expect(layout.nav.height).toBeGreaterThan(0);
      expect(layout.dock.left).toBeGreaterThan(layout.viewport.width / 2);
      expect(layout.dock.right).toBeLessThanOrEqual(layout.viewport.width);
      expect(layout.action.left).toBeGreaterThanOrEqual(layout.dock.left);
      expect(layout.action.right).toBeLessThanOrEqual(layout.dock.right);
      expect(layout.action.bottom).toBeLessThanOrEqual(layout.viewport.height);
      expect(layout.action.width).toBeGreaterThan(0);
      expect(layout.action.height).toBeGreaterThanOrEqual(50);

      await expect.poll(() => page.locator("#bg").evaluate((node) => {
        const image = node as HTMLImageElement;
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      })).toBe(true);

      const query = page.locator("#pr-query");
      await query.click();
      const results = page.locator("#pr-results");
      await results.waitFor({ state: "visible" });
      await page.locator("#pr-result-1").waitFor();

      const pickerBounds = await page.evaluate(() => {
        const body = document.querySelector(".dock-body")!.getBoundingClientRect();
        const dock = document.querySelector(".card-wrap")!.getBoundingClientRect();
        const list = document.querySelector("#pr-results")!.getBoundingClientRect();
        return {
          body: { left: body.left, right: body.right, top: body.top, bottom: body.bottom },
          dock: { left: dock.left, right: dock.right },
          list: { left: list.left, right: list.right, top: list.top, bottom: list.bottom, height: list.height },
          viewportHeight: innerHeight,
        };
      });
      expect(pickerBounds.list.height).toBeGreaterThan(0);
      expect(pickerBounds.list.left).toBeGreaterThanOrEqual(pickerBounds.dock.left);
      expect(pickerBounds.list.right).toBeLessThanOrEqual(pickerBounds.dock.right);
      expect(pickerBounds.list.top).toBeGreaterThanOrEqual(pickerBounds.body.top);
      expect(pickerBounds.list.bottom).toBeLessThanOrEqual(
        Math.min(pickerBounds.body.bottom, pickerBounds.viewportHeight) + 1,
      );

      await page.locator("#pr-result-1").click();
      await page.locator("#pr-preview-number").getByText("#1", { exact: true }).waitFor();
      expect(await page.locator("#submit").isEnabled()).toBe(true);
      expect(await page.locator("#submit").textContent()).toBe("Review this pull request");
    } finally {
      await context.close();
    }
  });

  it("keeps the sticky header visible while the narrow layout scrolls", async () => {
    const { context, page } = await openLandingPage({ width: 600, height: 640 });
    try {
      const scrollMetrics = await page.evaluate(() => {
        const root = document.scrollingElement!;
        window.scrollTo(0, root.scrollHeight);
        return { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight };
      });
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

      const header = await page.locator("nav").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      expect(header.top).toBeGreaterThanOrEqual(-1);
      expect(header.bottom).toBeGreaterThan(0);
      expect(header.height).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  });
});

async function openLandingPage(
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport });
  await context.route("https://**", (route) => route.abort());
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ key, repository }) => localStorage.setItem(key, repository),
    { key: STORAGE_KEY, repository: REPOSITORY },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#signedin").waitFor({ state: "visible" });
  expect(await page.locator("#me-login").textContent()).toBe("fixture-user");
  await page.getByText("12 open pull requests loaded", { exact: true }).waitFor();
  return { context, page };
}

function createLandingServer(): Server {
  const landingHtml = readFileSync(WEB_UI, "utf8");
  const background = readFileSync(BACKGROUND);
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(landingHtml);
      return;
    }
    if (request.method === "GET" && url.pathname === "/landing-renderer-background.png") {
      response.writeHead(200, { "content-type": "image/png", "content-length": background.length });
      response.end(background);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      sendJson(response, 200, { signedIn: true, user: { login: "fixture-user", avatarUrl: null } });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/api/repos/mine" || url.pathname === "/api/repos/search")) {
      sendJson(response, 200, {
        repos: [{
          fullName: REPOSITORY,
          isPrivate: false,
          defaultBranch: "main",
          description: null,
          ownerAvatarUrl: null,
        }],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/repos/pulls") {
      sendJson(response, 200, {
        prs: Array.from({ length: 12 }, (_, index) => pullRequest(index + 1)),
        hasMore: false,
        viewerLogin: "fixture-user",
      });
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

function pullRequest(number: number): Record<string, unknown> {
  return {
    number,
    title: `Landing review ${number}`,
    author: "octocat",
    headRef: `feature-${number}`,
    baseRef: "main",
    updatedAt: "2026-08-08T12:00:00Z",
    draft: false,
    state: "open",
  };
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
