/**
 * The landing page keeps one explicit GitHub repository selected across reloads. Changing it is a
 * deliberate picker action: opening the picker must not erase the saved repository, while choosing
 * a replacement must atomically update both the locked summary and localStorage.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const STORAGE_KEY = "meridian.selectedRepository";
const SAVED_REPOSITORY = "acme/saved-service";
const REPLACEMENT_REPOSITORY = "acme/replacement-service";

let server: Server | undefined;
let browser: Browser | undefined;
let page: Page;
let baseUrl = "";

describe.skipIf(!chromiumInstalled())("landing repository persistence (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("https://**", (route) => route.abort());
    page = await context.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await closeServer(server);
  });

  it("restores a locked repository and persists only an explicitly selected replacement", async () => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ key, repository }) => localStorage.setItem(key, repository),
      { key: STORAGE_KEY, repository: SAVED_REPOSITORY },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();

    const selection = page.getByRole("group", { name: "Selected GitHub repository" });
    const picker = page.locator("#repo-search-wrap");
    const repositoryInput = page.locator("#repo");
    const changeRepository = selection.getByRole("button", { name: "Change repository" });

    await selection.getByText(SAVED_REPOSITORY, { exact: true }).waitFor();
    expect(await selection.isVisible()).toBe(true);
    expect(await picker.isHidden()).toBe(true);
    expect(await storedRepository(page)).toBe(SAVED_REPOSITORY);

    await changeRepository.click();
    await picker.waitFor();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("repo");
    expect(await selection.isHidden()).toBe(true);
    expect(await repositoryInput.inputValue()).toBe(SAVED_REPOSITORY);
    expect(await storedRepository(page)).toBe(SAVED_REPOSITORY);

    await repositoryInput.fill(REPLACEMENT_REPOSITORY);
    expect(await storedRepository(page)).toBe(SAVED_REPOSITORY);
    const replacement = page.getByRole("button", { name: REPLACEMENT_REPOSITORY, exact: true });
    await replacement.waitFor();
    await replacement.click();

    await selection.getByText(REPLACEMENT_REPOSITORY, { exact: true }).waitFor();
    expect(await selection.isVisible()).toBe(true);
    expect(await picker.isHidden()).toBe(true);
    expect(await storedRepository(page)).toBe(REPLACEMENT_REPOSITORY);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("group", { name: "Selected GitHub repository" })
      .getByText(REPLACEMENT_REPOSITORY, { exact: true })
      .waitFor();
    expect(await storedRepository(page)).toBe(REPLACEMENT_REPOSITORY);
    expect(pageErrors).toEqual([]);
  });
});

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
      sendJson(response, 200, {
        signedIn: true,
        user: { login: "fixture-user", avatarUrl: null },
      });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/api/repos/mine" || url.pathname === "/api/repos/search")) {
      sendJson(response, 200, {
        repos: [{
          fullName: REPLACEMENT_REPOSITORY,
          isPrivate: false,
          defaultBranch: "main",
          description: null,
          ownerAvatarUrl: null,
        }],
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function storedRepository(target: Page): Promise<string | null> {
  return target.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

function closeServer(target: Server | undefined): Promise<void> {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
