/**
 * WebKit regression for browser-view graph protection. A `/view` document deliberately ships
 * `Referrer-Policy: no-referrer`; lease requests must still carry the document origin so the
 * server's CSRF boundary can admit them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webkit, type Browser, type Page, type Response } from "playwright";
import { createWebService, type WebService } from "../src/server/web-server";
import {
  FIXTURE,
  RENDERER_INDEX,
  ensureBuilt,
  listenServer,
  webkitInstalled,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const HAS_WEBKIT = webkitInstalled();

if (process.env.CI && !HAS_WEBKIT) {
  throw new Error("Playwright WebKit is required in CI; run `playwright install webkit`.");
}

describe.skipIf(!HAS_WEBKIT)("graph-view lease origin (headless WebKit)", () => {
  let browser: Browser | undefined;
  let page: Page;
  let service: WebService | undefined;
  let temporaryRoot: string | undefined;
  let baseUrl = "";
  let graphId = "";

  beforeAll(async () => {
    ensureBuilt();
    temporaryRoot = mkdtempSync(join(tmpdir(), "meridian-webkit-lease-"));
    service = createWebService({
      rendererRoot: dirname(RENDERER_INDEX),
      webUiPath: WEB_UI,
      cwd: REPO_ROOT,
      cacheRoot: join(temporaryRoot, "cache"),
    });
    baseUrl = await listenServer(service.server);
    graphId = await generateGraph(baseUrl);
    browser = await webkit.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await service?.close();
      } finally {
        if (temporaryRoot !== undefined) {
          rmSync(temporaryRoot, { recursive: true, force: true });
        }
      }
    }
  });

  it("renews a no-referrer view with its real same-origin header", async () => {
    const documentResponse = await page.goto(
      `${baseUrl}/view?id=${encodeURIComponent(graphId)}`,
      { waitUntil: "domcontentloaded" },
    );

    expect(documentResponse?.headers()["referrer-policy"]).toBe("no-referrer");
    const renewal = page.waitForResponse(isGraphViewRenewal, { timeout: 15_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    const response = await renewal;
    expect((await response.request().allHeaders()).origin).toBe(baseUrl);
    expect(response.status()).toBe(200);
  }, 20_000);
});

function isGraphViewRenewal(response: Response): boolean {
  return response.request().method() === "PUT"
    && new URL(response.url()).pathname.startsWith("/api/graph-views/");
}

async function generateGraph(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "path", value: FIXTURE }),
  });
  if (!response.ok) {
    throw new Error(`fixture graph generation failed (${response.status}): ${await response.text()}`);
  }
  const result = await response.json() as { id?: unknown };
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new Error("fixture graph generation returned no graph id");
  }
  return result.id;
}
