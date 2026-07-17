/** The landing page consumes only the strict direct PR-preparation v1 handoff. */

import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PR_PREPARE_CLIENT, chromiumInstalled, listenServer } from "./harness";

const WEB_UI = fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
const REPOSITORY = "acme/direct-review";
const HEAD_GRAPH_ID = "pr-head-fixture-a1";
const BASE_GRAPH_ID = "pr-base-fixture-b2";
const HANDOFF_ID = `prh-v1-${"d".repeat(64)}`;

type PrepareHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
) => void | Promise<void>;

let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext;
let page: Page;
let baseUrl = "";
let prepareHandler: PrepareHandler | undefined;
let capturedRequest: unknown;
let capturedAccept: string | undefined;
let legacyGenerateCalls = 0;
let prPrepareClientFailuresRemaining = 0;
let prPrepareClientRequests = 0;

describe.skipIf(!chromiumInstalled())("landing direct PR preparation (headless chromium)", () => {
  beforeAll(async () => {
    server = createLandingServer();
    baseUrl = await listenServer(server);
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("https://**", (route) => route.abort());
  });

  beforeEach(async () => {
    prepareHandler = undefined;
    capturedRequest = undefined;
    capturedAccept = undefined;
    legacyGenerateCalls = 0;
    prPrepareClientFailuresRemaining = 0;
    prPrepareClientRequests = 0;
    page = await context.newPage();
  });

  afterEach(async () => {
    prepareHandler = undefined;
    await page.close();
  });

  afterAll(async () => {
    await browser?.close();
    await closeServer(server);
  });

  it("sends the immutable selected summary, handles parallel progress, and follows only the validated handoff", async () => {
    const extractionGate = deferred();
    const handoffGate = deferred();
    prepareHandler = async (_request, response) => {
      beginNdjson(response);
      writeNdjson(response, progress("resolve", 1));
      writeNdjson(response, progress("git", 2));
      writeNdjson(response, progress("extract-merge-base", 3));
      await extractionGate.promise;
      writeNdjson(response, progress("extract-head", 4));
      writeNdjson(response, progress("publish", 5));
      await handoffGate.promise;
      writeNdjson(response, validDone());
      response.end();
    };

    try {
      await openSelectedPullRequest(page);
      await page.locator("#submit").click();

      await expect.poll(() => stage("resolve").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("git").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("extract-merge-base").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("extract-head").getAttribute("data-state")).toBe("active");
      await expect.poll(() => stage("publish").getAttribute("data-state")).toBe("pending");
      await expect.poll(() => page.locator("#prepare-announcement").textContent()).toContain(
        "Extracting the HEAD projection",
      );

      extractionGate.resolve();
      await expect.poll(() => stage("publish").getAttribute("data-state")).toBe("active");
      await expect.poll(() => page.locator('.prepare-step[data-stage="open"]').getAttribute("data-state"))
        .toBe("pending");
      await expect.poll(() => page.locator("#prepare-announcement").textContent())
        .toBe("Finalizing the immutable review handoff.");
      handoffGate.resolve();
      await page.waitForURL((url) => url.pathname === "/view");

      expect(capturedAccept).toBe("application/x-ndjson");
      expect(capturedRequest).toEqual({
        owner: "acme",
        repo: "direct-review",
        prNumber: 17,
        baseRef: "main",
        headRef: "feature/direct-review",
      });
      expect(new URL(page.url()).search).toBe(
        `?id=${HEAD_GRAPH_ID}&view=modules&prn=17&rev=1&prepared=${HANDOFF_ID}`,
      );
      expect(legacyGenerateCalls).toBe(0);
    } finally {
      extractionGate.resolve();
      handoffGate.resolve();
    }
  });

  it("infers missing prerequisite progress when joining an in-flight singleflight", async () => {
    const remainderGate = deferred();
    prepareHandler = async (_request, response) => {
      beginNdjson(response);
      // A late subscriber does not receive progress completed before it joined.
      writeNdjson(response, progress("extract-head", 4));
      await remainderGate.promise;
      writeNdjson(response, progress("extract-merge-base", 3));
      writeNdjson(response, progress("publish", 5));
      writeNdjson(response, validDone());
      response.end();
    };

    try {
      await openSelectedPullRequest(page);
      await page.locator("#submit").click();
      await expect.poll(() => stage("resolve").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("git").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("extract-head").getAttribute("data-state")).toBe("done");
      await expect.poll(() => stage("extract-merge-base").getAttribute("data-state")).toBe("active");
      await expect.poll(() => stage("publish").getAttribute("data-state")).toBe("pending");
      remainderGate.resolve();
      await page.waitForURL((url) => url.pathname === "/view");
    } finally {
      remainderGate.resolve();
    }
  });

  it("surfaces a bounded pre-stream JSON failure without attempting legacy generation", async () => {
    prepareHandler = (_request, response) => {
      sendJson(response, 503, { error: "fixture admission unavailable" });
    };
    await openSelectedPullRequest(page);
    await page.locator("#submit").click();
    await page.locator("#status").getByText("fixture admission unavailable", { exact: true }).waitFor();
    expect(legacyGenerateCalls).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  it("retries a transient shared-client load failure without requiring a page reload", async () => {
    prPrepareClientFailuresRemaining = 1;
    prepareHandler = (_request, response) => sendNdjson(response, ndjson(validDone()));

    await openSelectedPullRequest(page);
    await page.locator("#submit").click();
    await page.locator("#status").getByText("Could not reach the server.", { exact: true }).waitFor();
    await expect.poll(() => page.locator("#submit").isEnabled()).toBe(true);
    expect(prPrepareClientRequests).toBe(1);

    await page.locator("#submit").click();
    await page.waitForURL((url) => url.pathname === "/view");
    expect(prPrepareClientRequests).toBe(2);
    expect(legacyGenerateCalls).toBe(0);
  });

  it("aborts an in-flight preparation and suppresses stale navigation when review context changes", async () => {
    const release = deferred();
    let responseClosed = false;
    prepareHandler = async (_request, response) => {
      response.once("close", () => { responseClosed = true; });
      beginNdjson(response);
      writeNdjson(response, progress("resolve", 1));
      await release.promise;
      if (!response.destroyed && !response.writableEnded) {
        writeNdjson(response, validDone());
        response.end();
      }
    };

    try {
      await openSelectedPullRequest(page);
      await page.locator("#submit").click();
      await expect.poll(() => stage("resolve").getAttribute("data-state")).toBe("done");
      await page.locator("#intent-explore").click();

      await expect.poll(() => responseClosed).toBe(true);
      await expect.poll(() => page.locator("#submit").isEnabled()).toBe(true);
      expect(await page.locator("#prepare-progress").isHidden()).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(legacyGenerateCalls).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it("marks cache-reused extraction stages as skipped instead of pretending they ran", async () => {
    const eofGate = deferred();
    prepareHandler = async (_request, response) => {
      const done = validDone();
      done.cache = "hit";
      done.timings = { resolve: 1, git: 2 };
      beginNdjson(response);
      writeNdjson(response, progress("resolve", 1));
      writeNdjson(response, progress("git", 2));
      writeNdjson(response, done);
      await eofGate.promise;
      response.end();
    };

    try {
      await openSelectedPullRequest(page);
      await page.locator("#submit").click();
      await expect.poll(() => stage("extract-head").getAttribute("data-state")).toBe("skipped");
      await expect.poll(() => stage("extract-merge-base").getAttribute("data-state")).toBe("skipped");
      await expect.poll(() => stage("publish").getAttribute("data-state")).toBe("active");
      await expect.poll(() => page.locator('.prepare-step[data-stage="open"]').getAttribute("data-state"))
        .toBe("pending");
      await expect.poll(() => page.locator("#prepare-announcement").textContent())
        .toBe("Finalizing the immutable review handoff.");
      eofGate.resolve();
      await page.waitForURL((url) => url.pathname === "/view");
      expect(legacyGenerateCalls).toBe(0);
    } finally {
      eofGate.resolve();
    }
  });

  const invalidStreams: Array<{ name: string; body: () => string }> = [
    {
      name: "an unversioned terminal record",
      body: () => ndjson({ ...validDone(), version: undefined }),
    },
    {
      name: "a graph-id-only compatibility response",
      body: () => ndjson({ version: 1, type: "done", id: "legacy-graph" }),
    },
    {
      name: "a HEAD-only response",
      body: () => {
        const done = validDone();
        delete done.mergeBase;
        return ndjson(done);
      },
    },
    {
      name: "a nullable comparison descriptor",
      body: () => ndjson({ ...validDone(), mergeBase: null }),
    },
    {
      name: "an unknown progress stage",
      body: () => ndjson({ version: 1, type: "progress", stage: "checkout", elapsedMs: 1 }),
    },
    {
      name: "a rename without previousPath",
      body: () => ndjson({
        ...validDone(),
        changedFiles: [{ path: "renamed.ts", status: "renamed" }],
      }),
    },
    {
      name: "data after the terminal record",
      body: () => ndjson(validDone(), progress("resolve", 1)),
    },
    {
      name: "a blank record after the terminal record",
      body: () => `${ndjson(validDone())}\n`,
    },
    {
      name: "an uppercase commit identity",
      body: () => ndjson({ ...validDone(), headSha: "A".repeat(40) }),
    },
    {
      name: "one graph identity for both sides",
      body: () => ndjson({ ...validDone(), mergeBase: descriptor(HEAD_GRAPH_ID) }),
    },
    {
      name: "a noncanonical descriptor URL",
      body: () => {
        const done = validDone();
        const head = done.head as Record<string, unknown>;
        done.head = { ...head, manifestUrl: `/api/graph/manifest?id=${HEAD_GRAPH_ID}&extra=1` };
        return ndjson(done);
      },
    },
  ];

  it.each(invalidStreams)("rejects $name and never falls back", async ({ body }) => {
    prepareHandler = (_request, response) => sendNdjson(response, body());
    await openSelectedPullRequest(page);
    await page.locator("#submit").click();
    await expect.poll(() => page.locator("#status").textContent())
      .toMatch(/^invalid PR preparation (?:stream|done line):/);
    expect(legacyGenerateCalls).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/");
  });
});

function stage(name: string) {
  return page.locator(`.prepare-review-step[data-stage="${name}"]`);
}

async function openSelectedPullRequest(target: Page): Promise<void> {
  await target.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await target.evaluate((repository) => {
    localStorage.setItem("meridian.selectedRepository", repository);
  }, REPOSITORY);
  await target.reload({ waitUntil: "domcontentloaded" });
  await target.locator("#me-login").getByText("fixture-user", { exact: true }).waitFor();
  await target.locator("#intent-review").click();
  await target.getByText("1 open pull request loaded", { exact: true }).waitFor();
  await target.locator("#pr-query").click();
  await target.locator("#pr-result-17").click();
  await target.locator("#pr-preview-number").getByText("#17", { exact: true }).waitFor();
}

function validDone(): Record<string, unknown> {
  return {
    version: 1,
    type: "done",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    changedFiles: [
      { path: "a.ts", status: "added" },
      { path: "b.ts", status: "renamed", previousPath: "old-b.ts" },
      { path: "c.ts", status: "deleted" },
    ],
    head: descriptor(HEAD_GRAPH_ID),
    mergeBase: descriptor(BASE_GRAPH_ID),
    cache: "miss",
    timings: {
      resolve: 1,
      git: 2,
      "extract-head": 4,
      "extract-merge-base": 3,
      publish: 5,
    },
    warnings: [],
    handoff: {
      id: HANDOFF_ID,
      url: `/api/pr/prepared?id=${HANDOFF_ID}`,
      viewUrl: `/view?id=${HEAD_GRAPH_ID}&view=modules&prn=17&rev=1&prepared=${HANDOFF_ID}`,
    },
  };
}

function descriptor(graphId: string): Record<string, unknown> {
  return {
    graphId,
    manifestUrl: `/api/graph/manifest?id=${graphId}`,
    projectionUrl: `/api/graph/projection?id=${graphId}`,
    searchUrl: `/api/graph/search?id=${graphId}`,
    sourceUrl: `/api/source?id=${graphId}`,
    metaUrl: `/api/meta?id=${graphId}`,
    graphSummary: {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-17T12:00:00.000Z",
      nodeCount: 12,
      edgeCount: 20,
    },
  };
}

function progress(stageName: string, elapsedMs: number): Record<string, unknown> {
  return { version: 1, type: "progress", stage: stageName, elapsedMs };
}

function ndjson(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function beginNdjson(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  response.flushHeaders();
}

function writeNdjson(response: ServerResponse, record: unknown): void {
  response.write(`${JSON.stringify(record)}\n`);
}

function sendNdjson(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
  response.end(body);
}

function createLandingServer(): Server {
  const landingHtml = readFileSync(WEB_UI, "utf8");
  const prPrepareClient = readFileSync(PR_PREPARE_CLIENT, "utf8");
  return createServer((request, response) => {
    void handleLandingRequest(landingHtml, prPrepareClient, request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : "fixture error" });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

async function handleLandingRequest(
  landingHtml: string,
  prPrepareClient: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(landingHtml);
    return;
  }
  if (request.method === "GET" && url.pathname === "/pr-prepare-client.js") {
    prPrepareClientRequests++;
    if (prPrepareClientFailuresRemaining > 0) {
      prPrepareClientFailuresRemaining--;
      response.writeHead(503, { "content-type": "text/javascript; charset=utf-8" });
      response.end("throw new Error('transient fixture module failure');");
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(prPrepareClient);
    return;
  }
  if (request.method === "GET" && url.pathname === "/view") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Prepared review</title><main id=prepared-view>Prepared review</main>");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    sendJson(response, 200, { signedIn: true, user: { login: "fixture-user", avatarUrl: null } });
    return;
  }
  if (request.method === "GET" && (url.pathname === "/api/repos/mine" || url.pathname === "/api/repos/search")) {
    sendJson(response, 200, { repos: [{
      fullName: REPOSITORY,
      isPrivate: false,
      defaultBranch: "main",
      description: null,
      ownerAvatarUrl: null,
    }] });
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
  if (request.method === "GET" && url.pathname === "/api/repos/pulls") {
    sendJson(response, 200, {
      prs: [{
        number: 17,
        title: "Use direct preparation",
        author: "octocat",
        headRef: "feature/direct-review",
        baseRef: "main",
        updatedAt: "2026-07-17T12:00:00Z",
        draft: false,
        state: "open",
      }],
      hasMore: false,
      viewerLogin: "fixture-user",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/generate") {
    legacyGenerateCalls++;
    sendJson(response, 500, { error: "legacy generation must not be called" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/pr/prepare") {
    capturedAccept = request.headers.accept;
    capturedRequest = JSON.parse(await readRequestBody(request));
    if (!prepareHandler) {
      sendJson(response, 500, { error: "missing fixture preparation handler" });
      return;
    }
    await prepareHandler(request, response, capturedRequest);
    return;
  }
  sendJson(response, 404, { error: `Unexpected fixture route: ${request.method} ${url.pathname}` });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function closeServer(target: Server | undefined): Promise<void> {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
