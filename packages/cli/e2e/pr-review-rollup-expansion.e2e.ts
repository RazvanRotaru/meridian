/**
 * Characterize the large-review disclosure contract through the production Git/GitHub/analyzer
 * pipeline. A twelve-file PR must start as one package rollup, then disclose the exact extracted
 * file and callable nodes without losing nested expansion state when the rollup is closed.
 */

import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { buildNodeId } from "@meridian/core";
import { createWebServer } from "../src/server/web-server";
import {
  RENDERER_INDEX,
  buildPrReviewRollupFixture,
  chromiumInstalled,
  ensureBuilt,
  listenServer,
  startSmartGitServer,
  verifySmartHttpClone,
  type PrReviewFixture,
} from "./harness";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const ROLLUP_ID = buildNodeId({ lang: "ts", modulePath: "src/rollup" });
const nativeFetch = globalThis.fetch.bind(globalThis);
const HAS_CHROMIUM = chromiumInstalled();

if (process.env.CI && !HAS_CHROMIUM) {
  throw new Error("PR rollup disclosure characterization requires Chromium in CI");
}

let fixture: PrReviewFixture | undefined;
let smartGitServer: Server | undefined;
let webServer: Server | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let viewUrl = "";
let restoreGitRedirect: (() => void) | undefined;
const unexpectedGitHubRequests: string[] = [];

describe.skipIf(!HAS_CHROMIUM)("PR review rollup disclosure (headless chromium)", () => {
  beforeAll(setup, 240_000);
  afterAll(teardown);

  it("expands, collapses, and losslessly restores real extracted file and callable nodes", async () => {
    if (!page || !fixture) throw new Error("PR rollup fixture was not initialized");
    const changedPaths = fixture.files.map((file) => file.api.filename).sort();
    expect(changedPaths).toHaveLength(12);

    await page.goto(viewUrl, { waitUntil: "networkidle" });
    await page.getByText("1 open", { exact: true }).waitFor();
    await page.getByTitle("Open the full Pull requests page").click();
    await page.getByRole("heading", { name: "Pull requests" }).waitFor();
    const prCard = page.getByText("#7", { exact: true }).locator("xpath=ancestor::button[1]");
    await prCard.waitFor();
    await prCard.click();

    const detail = page.locator("aside.mrd-scroll");
    await detail.getByTitle(changedPaths[0]!).waitFor();
    await detail.getByRole("button", { name: "Review in graph" }).click();
    await page.getByText("Files changed", { exact: true }).waitFor({ timeout: 120_000 });
    await page.getByText(/^pr-head → main · head graph @[0-9a-f]{7}$/).waitFor({ timeout: 180_000 });

    const reviewSurface = page.getByRole("region", { name: "Extracted graph" });
    await reviewSurface.waitFor();
    const rollup = graphNode(reviewSurface, ROLLUP_ID);
    await rollup.waitFor({ state: "visible", timeout: 60_000 });
    await waitForGraphViewportToSettle(reviewSurface);

    const fileIds = changedPaths.map((path) => buildNodeId({ lang: "ts", modulePath: path }));
    expect(await rollup.locator('[data-base-node-kind="folder"]').count()).toBe(1);
    expect(await rollup.evaluate((element) => element.classList.contains("react-flow__node-package"))).toBe(true);
    expect(await visibleGraphNodeIds(reviewSurface, fileIds)).toEqual([]);

    const rollupDisclosure = disclosure(rollup);
    await expectDisclosureState(rollupDisclosure, false);
    await rollupDisclosure.click();
    await expectDisclosureState(rollupDisclosure, true);

    for (const fileId of fileIds) {
      const fileNode = graphNode(reviewSurface, fileId);
      await fileNode.waitFor({ state: "visible", timeout: 30_000 });
      expect(await fileNode.locator('[data-base-node-kind="file"]').count()).toBe(1);
    }

    const firstPath = changedPaths[0]!;
    const firstFileId = buildNodeId({ lang: "ts", modulePath: firstPath });
    const ordinal = /reviewUnit(\d+)\.ts$/.exec(firstPath)?.[1];
    if (!ordinal) throw new Error(`unexpected rollup fixture path: ${firstPath}`);
    const functionId = buildNodeId({
      lang: "ts",
      modulePath: firstPath,
      qualname: `reviewUnit${ordinal}`,
    });
    const firstFile = graphNode(reviewSurface, firstFileId);
    const fileDisclosure = disclosure(firstFile);
    await expectDisclosureState(fileDisclosure, false);
    expect(await graphNode(reviewSurface, functionId).count()).toBe(0);

    await fileDisclosure.click();
    await expectDisclosureState(fileDisclosure, true);
    const exportedFunction = graphNode(reviewSurface, functionId);
    await exportedFunction.waitFor({ state: "visible", timeout: 30_000 });
    await exportedFunction.getByText(`reviewUnit${ordinal}`, { exact: true }).waitFor();

    await rollupDisclosure.click();
    await expectDisclosureState(rollupDisclosure, false);
    expect(await visibleGraphNodeIds(reviewSurface, fileIds)).toEqual([]);
    expect(await exportedFunction.count()).toBe(0);

    await rollupDisclosure.click();
    await expectDisclosureState(rollupDisclosure, true);
    expect(await visibleGraphNodeIds(reviewSurface, fileIds)).toEqual(fileIds);
    await exportedFunction.waitFor({ state: "visible", timeout: 30_000 });
    await expectDisclosureState(disclosure(graphNode(reviewSurface, firstFileId)), true);

    expect(unexpectedGitHubRequests).toEqual([]);
  }, 240_000);
});

async function setup(): Promise<void> {
  unexpectedGitHubRequests.length = 0;
  ensureBuilt();
  fixture = buildPrReviewRollupFixture();
  const smartGit = await startSmartGitServer(fixture);
  smartGitServer = smartGit.server;
  await verifySmartHttpClone(smartGit.repoUrl);
  restoreGitRedirect = installGitRedirect(smartGit.repoUrl);
  vi.stubGlobal("fetch", fakeGitHub(fixture));
  webServer = createWebServer({
    rendererRoot: dirname(RENDERER_INDEX),
    webUiPath: WEB_UI,
    cwd: REPO_ROOT,
    cacheRoot: join(fixture.dir, "cache"),
    githubClientId: "Iv1.meridian-rollup-e2e",
    fallbackToken: "meridian-rollup-e2e-token",
    fallbackUser: { login: "rollup-e2e-reviewer", avatarUrl: null },
  });
  const baseUrl = await listenServer(webServer);
  const generated = await generateSession(baseUrl);
  viewUrl = `${baseUrl}/view?id=${encodeURIComponent(generated.id)}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
}

async function teardown(): Promise<void> {
  const errors: unknown[] = [];
  for (const close of [
    () => browser?.close(),
    () => closeServer(webServer),
    () => closeServer(smartGitServer),
  ]) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    restoreGitRedirect?.();
    vi.unstubAllGlobals();
    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  fixture = undefined;
  smartGitServer = undefined;
  webServer = undefined;
  browser = undefined;
  page = undefined;
  restoreGitRedirect = undefined;
  if (errors.length > 0) throw new AggregateError(errors, "PR rollup E2E cleanup failed");
}

function graphNode(surface: Locator, nodeId: string): Locator {
  return surface.locator(`.react-flow__node[data-id="${nodeId}"]:visible`);
}

function disclosure(node: Locator): Locator {
  return node.locator('button[data-base-node-disclosure="true"]');
}

async function expectDisclosureState(control: Locator, expanded: boolean): Promise<void> {
  await expect.poll(() => control.getAttribute("aria-expanded"), { timeout: 30_000 }).toBe(String(expanded));
  expect(await control.getAttribute("data-node-disclosure-state")).toBe(expanded ? "expanded" : "collapsed");
}

async function visibleGraphNodeIds(surface: Locator, expectedIds: readonly string[]): Promise<string[]> {
  const visible = await surface.locator(".react-flow__node[data-id]:visible").evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute("data-id")).filter((id): id is string => id !== null),
  );
  return expectedIds.filter((id) => visible.includes(id));
}

async function waitForGraphViewportToSettle(surface: Locator): Promise<void> {
  const viewport = surface.locator(".react-flow__viewport");
  await viewport.waitFor();
  let previous = await viewport.getAttribute("style");
  let stableSamples = 0;
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
    throw new Error(`PR rollup session generation failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

function fakeGitHub(source: PrReviewFixture): typeof fetch {
  const summary = {
    number: 7,
    title: "Add a large review package",
    body: null,
    user: { login: "rollup-e2e-reviewer" },
    head: { ref: "pr-head", sha: source.headSha },
    base: { ref: "main" },
    updated_at: "2026-07-20T10:00:00Z",
    draft: false,
    state: "open",
    html_url: "https://github.com/e2e/shop/pull/7",
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "api.github.com") return nativeFetch(input, init);
    const path = url.pathname;
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls") return json([summary]);
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls/7") return json(summary);
    if (request.method === "GET" && path === "/repos/e2e/shop/pulls/7/files") {
      return json(source.files.map((file) => file.api));
    }
    if (request.method === "GET" && /^\/repos\/e2e\/shop\/pulls\/7\/(comments|reviews)$/.test(path)) {
      return json([]);
    }
    if (request.method === "GET" && /^\/repos\/e2e\/shop\/commits\/[0-9a-f]+\/check-runs$/.test(path)) {
      return json({ total_count: 0, check_runs: [] });
    }
    unexpectedGitHubRequests.push(`${request.method} ${url.pathname}${url.search}`);
    return json({ message: "unexpected GitHub fixture request" }, 404);
  }) as typeof fetch;
}

// git-exec inherits these variables, redirecting production clone/fetch argv to the local smart
// HTTP server without weakening the repository-analysis path under test.
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}
