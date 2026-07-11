import { describe, expect, it, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handlePullRequestFiles, handlePullRequests, handleSubmitReview } from "./web-prs";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore, markAuthorized } from "./session";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";

describe("PR routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("404s for a non-GitHub artifact source", async () => {
    const ctx = ctxWithSource({ kind: "other" });
    const captured = await invoke(
      handlePullRequests,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", state: "open", page: "1" }),
    );
    const files = await invoke(handlePullRequestFiles, ctx, requestWith(undefined), new URLSearchParams({ id: "artifact", n: "1" }));
    expect(captured.status()).toBe(404);
    expect(files.status()).toBe(404);
    expect(JSON.parse(captured.body())).toEqual({ error: "pull requests need a GitHub-sourced session" });
  });

  it("validates the PR number before calling GitHub", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const captured = await invoke(
      handlePullRequestFiles,
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "0" }),
    );
    expect(captured.status()).toBe(400);
    expect(JSON.parse(captured.body())).toEqual({ error: "n must be a positive integer" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists PRs with the session token and returns the renderer shape", async () => {
    const seenAuth: string[] = [];
    stubFetch([{ number: 1, title: "Fix", user: { login: "daria" }, head: { ref: "fix" }, updated_at: "2026-07-08T12:00:00Z", state: "open" }], seenAuth);
    const { cookie, sessions } = signedInSession();
    const captured = await invoke(
      handlePullRequests,
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }, sessions),
      requestWith(cookie),
      new URLSearchParams({ id: "artifact", state: "open", page: "1" }),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      prs: [{ number: 1, title: "Fix", author: "daria", headRef: "fix", baseRef: "", updatedAt: "2026-07-08T12:00:00Z", draft: false, state: "open", url: "" }],
      hasMore: false,
    });
    expect(seenAuth).toEqual(["Bearer gho_secret"]);
  });

  it("falls back to the environment token for PR lists and files", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    vi.stubEnv("GH_TOKEN", "ignored");
    const seenAuth: string[] = [];
    stubFetch(
      [{ number: 1, title: "Fix", user: { login: "daria" }, head: { ref: "fix" }, updated_at: "2026-07-08T12:00:00Z", state: "open", filename: "src/a.ts", status: "modified" }],
      seenAuth,
    );
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "private" });
    await invoke(handlePullRequests, ctx, requestWith(undefined), new URLSearchParams({ id: "artifact", state: "open", page: "1" }));
    await invoke(handlePullRequestFiles, ctx, requestWith(undefined), new URLSearchParams({ id: "artifact", n: "1" }));
    expect(seenAuth).toEqual(["Bearer env_secret", "Bearer env_secret"]);
  });

  it("keeps public-repo requests unauthenticated when no token source exists", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const seenAuth: string[] = [];
    stubFetch([{ number: 1, title: "Fix", user: { login: "daria" }, head: { ref: "fix" }, updated_at: "2026-07-08T12:00:00Z", state: "open" }], seenAuth);
    await invoke(
      handlePullRequests,
      ctxWithSource({ kind: "github", owner: "org", repo: "public" }),
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", state: "open", page: "1" }),
    );
    expect(seenAuth).toEqual([]);
  });

  it("strips the extraction subdir and drops files outside it", async () => {
    stubFetch([
      { filename: "packages/cli/src/a.ts", status: "modified" },
      { filename: "packages/core/src/b.ts", status: "added" },
      { filename: "packages/cli/package.json", status: "renamed" },
      { filename: "packages/../escape.ts", status: "modified" },
    ]);
    const captured = await invoke(
      handlePullRequestFiles,
      ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" }),
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "42" }),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      files: [
        { path: "src/a.ts", status: "modified", additions: 0, deletions: 0 },
        { path: "package.json", status: "renamed", additions: 0, deletions: 0 },
      ],
      truncated: false,
      totalFiles: 4,
      outsideCount: 2,
      // The unsafe `..` candidate is counted as outside but cannot influence the suggested root.
      suggestedSubdir: "packages/core/src",
    });
  });
});

describe("handleSubmitReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const VALID_BODY = { number: 7, comments: [{ path: "src/a.ts", line: 25, body: "check" }] };

  it("404s for a non-GitHub artifact source", async () => {
    const captured = await invokePost(ctxWithSource({ kind: "other" }), bodyRequest(VALID_BODY));
    expect(captured.status()).toBe(404);
  });

  it("401s when no token can be resolved — a review is a write, never anonymous", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());
    const captured = await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));
    expect(captured.status()).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts ONE COMMENT review, restoring the extraction subdir on comment AND note paths", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#pullrequestreview-1" }), { status: 200 });
    }) as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" });
    const captured = await invokePost(
      ctx,
      bodyRequest({
        ...VALID_BODY,
        notes: [
          { path: "src/gone.ts", label: "OldUnit", body: "why delete?" },
          { path: "src/x.ts", body: "general" },
        ],
      }),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ url: "https://github.com/org/repo/pull/7#pullrequestreview-1" });
    expect(calls[0].url).toBe("https://api.github.com/repos/org/repo/pulls/7/reviews");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      event: "COMMENT",
      // Notes fold into the body SERVER-side so their display paths are repo-root-relative too.
      body: "**packages/cli/src/gone.ts** · OldUnit: why delete?\n\n**packages/cli/src/x.ts**: general",
      comments: [{ path: "packages/cli/src/a.ts", line: 25, side: "RIGHT", body: "check" }],
    });
  });

  it("omits an empty review body from the GitHub payload", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    let posted: unknown;
    vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch);
    await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));
    expect(posted).toEqual({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 25, side: "RIGHT", body: "check" }] });
  });

  it("400s on malformed comments and on an empty submission, before any GitHub call", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });
    const noLine = await invokePost(ctx, bodyRequest({ number: 7, comments: [{ path: "a.ts", body: "x" }] }));
    const zeroLine = await invokePost(ctx, bodyRequest({ number: 7, comments: [{ path: "a.ts", line: 0, body: "x" }] }));
    const empty = await invokePost(ctx, bodyRequest({ number: 7, comments: [], notes: [] }));
    const badNumber = await invokePost(ctx, bodyRequest({ ...VALID_BODY, number: 0 }));
    expect([noLine.status(), zeroLine.status(), empty.status(), badNumber.status()]).toEqual([400, 400, 400, 400]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces GitHub's 422 as the anchor hint", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 422 })) as typeof fetch);
    const captured = await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));
    expect(captured.status()).toBe(422);
    expect(JSON.parse(captured.body()).error).toMatch(/anchor/);
  });
});

/** A minimal IncomingMessage whose stream yields one JSON body (what readJsonBody consumes). */
function bodyRequest(payload: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  (request as { headers: Record<string, string> }).headers = {};
  return request;
}

async function invokePost(ctx: Context, request: IncomingMessage) {
  const captured = capturedResponse();
  try {
    await handleSubmitReview(ctx, request, captured.response, new URLSearchParams({ id: "artifact" }));
  } catch (error) {
    if (!(error instanceof WebError)) {
      throw error;
    }
    sendJson(captured.response, error.status, { error: error.message });
  }
  return captured;
}

type PrHandler = (
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  query: URLSearchParams,
) => Promise<void>;

async function invoke(handler: PrHandler, ctx: Context, request: IncomingMessage, query: URLSearchParams) {
  const captured = capturedResponse();
  try {
    await handler(ctx, request, captured.response, query);
  } catch (error) {
    if (!(error instanceof WebError)) {
      throw error;
    }
    sendJson(captured.response, error.status, { error: error.message });
  }
  return captured;
}

function ctxWithSource(source: ArtifactSource, sessions = new SessionStore()): Context {
  return {
    graphs: new Map(),
    sourceRoots: new Map(),
    sources: new Map([["artifact", source]]),
    tempCleanups: new Set(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions,
    github: null,
  } as Context;
}

function signedInSession(): { cookie: string; sessions: SessionStore } {
  const sessions = new SessionStore();
  const now = Date.now();
  const { id, session } = sessions.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: now + 60_000 }, now);
  markAuthorized(session, "gho_secret", { login: "daria", avatarUrl: null }, now);
  return { cookie: `meridian_sid=${id}`, sessions };
}

function requestWith(cookie: string | undefined): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as IncomingMessage;
}

function stubFetch(body: unknown, seenAuth: string[] = []): void {
  vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.authorization) {
      seenAuth.push(headers.authorization);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
}

function capturedResponse(): { response: ServerResponse; status: () => number; body: () => string } {
  let status = 0;
  let body = "";
  const response = {
    writeHead(code: number) {
      status = code;
      return response;
    },
    end(chunk?: unknown) {
      body = typeof chunk === "string" ? chunk : "";
    },
  } as unknown as ServerResponse;
  return { response, status: () => status, body: () => body };
}
