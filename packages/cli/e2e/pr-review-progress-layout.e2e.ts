/** PR preparation telemetry must not move the landing card as file paths and reuse badges change. */

import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { injectPrReviewProgressModel } from "../src/server/web-boot";
import { chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));

let server: Server | undefined;
let browser: Browser | undefined;
let page: Page;
let baseUrl = "";

describe.skipIf(!chromiumInstalled())("PR review progress layout (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    await context.route("https://**", (route) => route.abort());
    page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#me-login").getByText("astrid", { exact: true }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  });

  afterAll(async () => {
    await browser?.close();
    await closeServer(server);
  });

  it("reserves the live detail and revision lanes before extraction begins", async () => {
    await page.evaluate(() => {
      const landing = globalThis as typeof globalThis & {
        setGithubIntent(intent: "explore" | "review"): void;
        showPrepareProgress(sourceKind: string, cacheAlreadyChecked: boolean, prNumber: number): void;
      };
      landing.setGithubIntent("review");
      landing.showPrepareProgress("github", false, 42);
    });
    const resolve = await progressGeometry(page);

    await setExtractionProgress(page, "src/index.ts");
    const shortPath = await progressGeometry(page);

    const picturedPath = [
      "src/aria/app/assistant/projects/windows/main-window/src/lib/components/tabs/home-tab/components/",
      "failed-process/failed-process-item/failed-process-item.component.spec.ts",
    ].join("");
    await setExtractionProgress(page, picturedPath);
    const pictured = await progressGeometry(page);

    const maximumUnbrokenPath = "x".repeat(500);
    await setExtractionProgress(page, maximumUnbrokenPath);
    const maximum = await progressGeometry(page);

    await page.evaluate(() => {
      const landing = globalThis as typeof globalThis & {
        completeReviewPrepareProgress(cache: "hit" | "miss", destination: string): void;
      };
      landing.completeReviewPrepareProgress("hit", "/view?id=fixture");
    });
    const reused = await progressGeometry(page);

    for (const [name, current] of Object.entries({ shortPath, pictured, maximum, reused })) {
      const context = JSON.stringify({ name, resolve, current });
      // Fractional font metrics can differ by a sub-pixel between paints; the original regression
      // moved this card by 108px, so these bounds distinguish stable geometry without flaking on
      // Chromium's neighboring device-pixel rounding.
      expect(Math.abs(current.progressHeight - resolve.progressHeight), context).toBeLessThanOrEqual(0.1);
      expect(Math.abs(current.signedInTop - resolve.signedInTop), context).toBeLessThanOrEqual(2);
      expect(current.scrollHeight, context).toBe(resolve.scrollHeight);
      expect(current.scrollWidth, context).toBe(current.clientWidth);
      expect(current.detailHeight, context).toBe(126);
      expect(current.revisionsHeight, context).toBe(32);
    }
    expect(maximum.announcement).toContain(maximumUnbrokenPath);
    expect(maximum.detailText).toContain(maximumUnbrokenPath);
    expect(maximum.detailTitle).toContain(maximumUnbrokenPath);
    expect(maximum.lineClamp).toBe("7");
    expect(shortPath.detailText).toContain("review graph 1/2");
    expect(shortPath.detailText).not.toContain("commit 1/2");
  });

  it("preserves a reused HEAD received from the preparation stream", async () => {
    const states = await page.evaluate(() => {
      const landing = globalThis as typeof globalThis & {
        applyPrPrepareLine(line: string): unknown;
        completeReviewPrepareProgress(cache: "hit" | "miss", destination: string): void;
        setGithubIntent(intent: "explore" | "review"): void;
        showPrepareProgress(sourceKind: string, cacheAlreadyChecked: boolean, prNumber: number): void;
      };
      landing.setGithubIntent("review");
      landing.showPrepareProgress("github", false, 42);
      landing.applyPrPrepareLine(JSON.stringify({ stage: "reuse-head" }));
      landing.applyPrPrepareLine(JSON.stringify({ stage: "reuse-merge-base" }));
      landing.completeReviewPrepareProgress("miss", "/view?id=fixture");

      return Object.fromEntries(
        ["head", "mergeBase"].map((revisionId) => {
          const revision = document.querySelector<HTMLElement>(
            `.prepare-revision[data-revision-id="${revisionId}"]`,
          );
          if (!revision) throw new Error(`Missing ${revisionId} revision lane.`);
          return [revisionId, revision.dataset.state];
        }),
      );
    });

    expect(states).toEqual({ head: "reused", mergeBase: "reused" });
  });
});

async function setExtractionProgress(target: Page, path: string): Promise<void> {
  await target.evaluate((sourcePath) => {
    const landing = globalThis as typeof globalThis & {
      setReviewPrepareStage(stage: string, progress: unknown): void;
    };
    landing.setReviewPrepareStage("extract-head", {
      version: 1,
      revision: {
        kind: "head",
        commit: "a".repeat(40),
        execution: { current: 1, total: 2 },
      },
      language: "typescript",
      phase: "structure",
      unit: { current: 2, total: 28, path: "src/app", pathTruncated: false },
      sourceFile: { current: 4479, total: 4528, path: sourcePath, pathTruncated: false },
    });
  }, path);
}

async function progressGeometry(target: Page): Promise<{
  announcement: string;
  clientWidth: number;
  detailHeight: number;
  detailText: string;
  detailTitle: string;
  lineClamp: string;
  progressHeight: number;
  revisionsHeight: number;
  scrollHeight: number;
  scrollTop: number;
  scrollWidth: number;
  signedInTop: number;
}> {
  return target.evaluate(() => {
    const progress = document.querySelector<HTMLElement>("#prepare-progress");
    const detail = document.querySelector<HTMLElement>("#prepare-detail");
    const detailText = document.querySelector<HTMLElement>("#prepare-detail-text");
    const revisions = document.querySelector<HTMLElement>(".prepare-revisions");
    const signedIn = document.querySelector<HTMLElement>("#signedin");
    const scroll = document.querySelector<HTMLElement>(".card-scroll");
    const announcement = document.querySelector<HTMLElement>("#prepare-announcement");
    if (!progress || !detail || !detailText || !revisions || !signedIn || !scroll || !announcement) {
      throw new Error("PR progress fixture did not render.");
    }
    return {
      announcement: announcement.textContent ?? "",
      clientWidth: scroll.clientWidth,
      detailHeight: detail.getBoundingClientRect().height,
      detailText: detailText.textContent ?? "",
      detailTitle: detailText.title,
      lineClamp: getComputedStyle(detailText).webkitLineClamp,
      progressHeight: progress.getBoundingClientRect().height,
      revisionsHeight: revisions.getBoundingClientRect().height,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      scrollWidth: scroll.scrollWidth,
      signedInTop: signedIn.getBoundingClientRect().top,
    };
  });
}

function createLandingServer(): Server {
  const landingHtml = injectPrReviewProgressModel(readFileSync(WEB_UI, "utf8"));
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") return html(response, landingHtml);
    if (url.pathname === "/api/auth/session") {
      return json(response, { signedIn: true, user: { login: "astrid", avatarUrl: null } });
    }
    if (url.pathname === "/api/repos/mine") return json(response, { repos: [] });
    if (url.pathname === "/api/repos/pulls") {
      return json(response, { viewerLogin: "astrid", prs: [], hasMore: false });
    }
    return json(response, { error: `Unexpected fixture route: ${request.method} ${url.pathname}` }, 404);
  });
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
