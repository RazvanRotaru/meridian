import { describe, expect, it, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  handlePullRequestChecks,
  handlePullRequestCommentMutation,
  handlePullRequestComments,
  handlePullRequestFileContent,
  handlePullRequestFiles,
  handlePullRequests,
  handleRelatedPullRequests,
  handleSubmitReview,
} from "./web-prs";
import type { Context } from "./web-server";
import type { ArtifactSource } from "./web-source";
import { SessionStore, markAuthorized } from "./session";
import { sendJson } from "./http-response";
import { WebError } from "./web-error";
import { createGitHubClient } from "./github";
import { SCHEMA_VERSION } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { materializeValidatedArtifact, WebGraphStore } from "./web-graph-store";

const TEST_ARTIFACT: GraphArtifact = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: "2026-07-20T00:00:00.000Z",
  generator: { name: "meridian", version: "test" },
  target: { name: "test", root: ".", language: "typescript" },
  nodes: [],
  edges: [],
};
const activeGraphStores: WebGraphStore[] = [];

describe("PR routes", () => {
  afterEach(() => {
    for (const store of activeGraphStores.splice(0)) store.dispose();
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
      prs: [
        {
          number: 1,
          title: "Fix",
          body: null,
          author: "daria",
          headRef: "fix",
          headSha: null,
          baseRef: "",
          updatedAt: "2026-07-08T12:00:00Z",
          draft: false,
          state: "open",
          url: "",
        },
      ],
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

  it("preserves exact source row metadata in the PR-head file response", async () => {
    stubFetch({ encoding: "base64", content: "" });
    const captured = await invoke(
      handlePullRequestFileContent,
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", ref: "head-sha", path: "src/empty.ts" }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      file: "src/empty.ts",
      code: "",
      truncated: false,
      lineCount: 0,
    });
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
        { path: "src/a.ts", status: "modified", additions: 0, deletions: 0, diffComplete: false },
        { path: "package.json", status: "renamed", additions: 0, deletions: 0, diffComplete: false },
      ],
      truncated: false,
      totalFiles: 4,
      outsideCount: 2,
      // The unsafe `..` candidate is counted as outside but cannot influence the suggested root.
      suggestedSubdir: "packages/core/src",
    });
  });

  it("finds related PRs, caches repo-root files by summary revision, and drops parent-segment paths", async () => {
    let updatedAt = "2026-07-08T12:00:00Z";
    let headSha = "abcdef1234567";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/pulls?")) {
        return new Response(
          JSON.stringify([
            {
              number: 12,
              title: "Touch renderer",
              user: { login: "daria" },
              head: { ref: "related", sha: headSha },
              base: { ref: "main" },
              updated_at: updatedAt,
              draft: false,
              state: "open",
              html_url: "https://github.com/org/repo/pull/12",
              secret: "not forwarded",
            },
          ]),
          { status: 200 },
        );
      }
      if (target.includes("/pulls/12/files?")) {
        return new Response(
          JSON.stringify([
            { filename: "packages/cli/src/a.ts", status: "modified" },
            { filename: "packages/cli/src/b.ts", status: "added" },
            { filename: "packages/core/outside.ts", status: "modified" },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected GitHub URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" });
    const dropped = await invoke(
      handleRelatedPullRequests,
      ctx,
      bodyRequest({ paths: ["../outside.ts"] }),
      new URLSearchParams({ id: "artifact" }),
    );
    expect(JSON.parse(dropped.body())).toEqual({ results: [], scanned: 0, hasMore: false, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    const cappedPaths: unknown[] = [
      "src/a.ts",
      "./src/b.ts",
      "../outside.ts",
      ...Array.from({ length: 97 }, (_, index) => `unmatched/${index}.ts`),
      42, // Entry 101 is outside the server cap and therefore cannot reject the request.
    ];
    const body = bodyRequest({ paths: cappedPaths });
    const first = await invoke(handleRelatedPullRequests, ctx, body, new URLSearchParams({ id: "artifact" }));
    expect(first.status()).toBe(200);
    expect(JSON.parse(first.body())).toEqual({
      results: [
        {
          number: 12,
          title: "Touch renderer",
          author: "daria",
          headRef: "related",
          updatedAt,
          draft: false,
          matchCount: 2,
          matchedPaths: ["src/a.ts", "src/b.ts"],
        },
      ],
      scanned: 1,
      hasMore: false,
      skipped: 0,
    });

    const second = await invoke(
      handleRelatedPullRequests,
      ctx,
      bodyRequest({ paths: ["src/a.ts"] }),
      new URLSearchParams({ id: "artifact" }),
    );
    expect(second.status()).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls/12/files?")).length).toBe(1);

    publishSource(ctx.graphStore, "core-artifact", {
      kind: "github",
      owner: "org",
      repo: "repo",
      subdir: "packages/core",
    });
    const otherSubdir = await invoke(
      handleRelatedPullRequests,
      ctx,
      bodyRequest({ paths: ["outside.ts"] }),
      new URLSearchParams({ id: "core-artifact" }),
    );
    expect(JSON.parse(otherSubdir.body())).toEqual({
      results: [
        {
          number: 12,
          title: "Touch renderer",
          author: "daria",
          headRef: "related",
          updatedAt,
          draft: false,
          matchCount: 1,
          matchedPaths: ["outside.ts"],
        },
      ],
      scanned: 1,
      hasMore: false,
      skipped: 0,
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls/12/files?")).length).toBe(1);

    headSha = "fedcba7654321";
    await invoke(
      handleRelatedPullRequests,
      ctx,
      bodyRequest({ paths: ["src/a.ts"] }),
      new URLSearchParams({ id: "artifact" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls/12/files?")).length).toBe(2);

    updatedAt = "2026-07-09T12:00:00Z";
    await invoke(
      handleRelatedPullRequests,
      ctx,
      bodyRequest({ paths: ["src/a.ts"] }),
      new URLSearchParams({ id: "artifact" }),
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/pulls/12/files?")).length).toBe(3);
    expect(ctx.prFilesCache.get("org/repo#12")).toEqual({
      updatedAt,
      headSha,
      paths: ["packages/cli/src/a.ts", "packages/cli/src/b.ts", "packages/core/outside.ts"],
    });
  });

  it("returns whitelisted comments and latest review states, and validates n before fetching", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/comments?")) {
        return new Response(
          JSON.stringify([
            {
              id: 101,
              path: "packages/cli/src/a.ts",
              line: 12,
              side: "RIGHT",
              body: "Please cover this branch",
              user: { login: "mina", avatar_url: "raw field" },
              updated_at: "2026-07-10T09:30:00Z",
              html_url: "https://github.com/org/repo/pull/7#discussion_r1",
              raw_secret: "not forwarded",
            },
            {
              id: 102,
              in_reply_to_id: 101,
              path: "packages/core/src/outside.ts",
              line: 2,
              side: "LEFT",
              body: "outside extraction root",
              user: { login: "mina" },
              updated_at: "2026-07-10T09:31:00Z",
            },
          ]),
          { status: 200, headers: { link: '<https://api.github.com/page=2>; rel="next"' } },
        );
      }
      return new Response(
        JSON.stringify([
          { user: { login: "alice" }, state: "APPROVED", submitted_at: "2026-07-09T10:00:00Z" },
          { user: { login: "bob" }, state: "COMMENTED", submitted_at: "2026-07-09T11:00:00Z" },
          { user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2026-07-09T12:00:00Z" },
          { user: { login: "zoe" }, state: "APPROVED", submitted_at: "2026-07-09T13:00:00Z" },
          { user: { login: "gone" }, state: "APPROVED", submitted_at: "2026-07-09T08:00:00Z" },
          { user: { login: "gone" }, state: "DISMISSED", submitted_at: "2026-07-09T14:00:00Z" },
        ]),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" });
    const captured = await invoke(
      handlePullRequestComments,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "7" }),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      comments: [
        {
          id: 101,
          inReplyToId: null,
          path: "src/a.ts",
          line: 12,
          side: "RIGHT",
          body: "Please cover this branch",
          author: "mina",
          updatedAt: "2026-07-10T09:30:00Z",
          url: "https://github.com/org/repo/pull/7#discussion_r1",
          viewerCanEdit: false,
        },
      ],
      reviews: { approved: ["zoe"], changesRequested: ["alice"], commented: 1 },
      hasMore: true,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/org/repo/pulls/7/comments?per_page=100",
      "https://api.github.com/repos/org/repo/pulls/7/reviews?per_page=100",
    ]);

    const invalid = await invoke(
      handlePullRequestComments,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "0" }),
    );
    expect(invalid.status()).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a capped checks rollup and validates n and sha before fetching", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          total_count: 4,
          check_runs: [
            { status: "completed", conclusion: "success", html_url: "https://github.com/org/repo/runs/1", name: "build" },
            { status: "completed", conclusion: "failure", html_url: "https://github.com/org/repo/runs/2", name: "lint" },
            { status: "in_progress", conclusion: null, html_url: "https://github.com/org/repo/runs/3", name: "test" },
            { status: "completed", conclusion: "neutral", html_url: "https://github.com/org/repo/runs/4", name: "optional" },
          ],
          raw_secret: "not forwarded",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });
    const captured = await invoke(
      handlePullRequestChecks,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "7", sha: "abcdef1234567" }),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      pending: 1,
      url: "https://github.com/org/repo/runs/2",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.github.com/repos/org/repo/commits/abcdef1234567/check-runs?per_page=100",
    );

    const badNumber = await invoke(
      handlePullRequestChecks,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "0", sha: "abcdef1" }),
    );
    const badSha = await invoke(
      handlePullRequestChecks,
      ctx,
      requestWith(undefined),
      new URLSearchParams({ id: "artifact", n: "7", sha: "not-a-sha" }),
    );
    expect([badNumber.status(), badSha.status()]).toEqual([400, 400]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("handlePullRequestCommentMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("edits with the session token, then returns a refreshed, whitelisted discussion", async () => {
    const { cookie, sessions } = signedInSession();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: 101, raw_secret: "not forwarded" }), { status: 200 });
      }
      if (target.includes("/comments?")) {
        return new Response(JSON.stringify([
          {
            id: 101,
            path: "packages/cli/src/a.ts",
            line: 12,
            side: "RIGHT",
            body: "Edited wording",
            user: { login: "DARIA", avatar_url: "not forwarded" },
            updated_at: "2026-07-13T10:00:00Z",
            html_url: "https://github.com/org/repo/pull/7#discussion_r101",
          },
          {
            id: 999,
            path: "packages/core/outside.ts",
            line: 1,
            side: "RIGHT",
            body: "Outside extraction root",
            user: { login: "daria" },
            updated_at: "2026-07-13T10:00:00Z",
          },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch);

    const captured = await invokeCommentMutation(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" }, sessions),
      bodyRequest({ number: 7, action: "edit", commentId: 101, body: "  Edited wording  " }, cookie),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      comments: [{
        id: 101,
        inReplyToId: null,
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        body: "Edited wording",
        author: "DARIA",
        updatedAt: "2026-07-13T10:00:00Z",
        url: "https://github.com/org/repo/pull/7#discussion_r101",
        viewerCanEdit: true,
      }],
      reviews: { approved: [], changesRequested: [], commented: 0 },
      hasMore: false,
    });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/org/repo/pulls/comments/101",
      "https://api.github.com/repos/org/repo/pulls/7/comments?per_page=100",
      "https://api.github.com/repos/org/repo/pulls/7/reviews?per_page=100",
    ]);
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: "Edited wording" });
    expect(calls.every(({ init }) => (init?.headers as Record<string, string>).authorization === "Bearer gho_secret")).toBe(true);
  });

  it("replies to a top-level comment with the fallback token and marks fallback-authored comments editable", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, init });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: 202 }), { status: 201 });
      }
      if (target.includes("/comments?")) {
        return new Response(JSON.stringify([{
          id: 202,
          in_reply_to_id: 101,
          path: "src/a.ts",
          line: 12,
          side: "RIGHT",
          body: "A reply",
          user: { login: "fallback-user" },
          updated_at: "2026-07-13T10:01:00Z",
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });
    ctx.fallbackToken = "gh_fallback";
    ctx.fallbackUser = { login: "fallback-user", avatarUrl: null };

    const captured = await invokeCommentMutation(
      ctx,
      bodyRequest({ number: 7, action: "reply", commentId: 101, body: "A reply" }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body()).comments[0]).toMatchObject({
      id: 202,
      inReplyToId: 101,
      body: "A reply",
      viewerCanEdit: true,
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/org/repo/pulls/7/comments/101/replies");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ body: "A reply" });
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer gh_fallback");
  });

  it("validates action, positive ids, body, and token before calling GitHub", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });
    const inputs = [
      { number: 0, action: "edit", commentId: 1, body: "x" },
      { number: 7, action: "edit", commentId: 0, body: "x" },
      { number: 7, action: "delete", commentId: 1, body: "x" },
      { number: 7, action: "reply", commentId: 1, body: "   " },
    ];
    const malformed = await Promise.all(inputs.map((input) => invokeCommentMutation(ctx, bodyRequest(input))));
    const unsigned = await invokeCommentMutation(
      ctx,
      bodyRequest({ number: 7, action: "edit", commentId: 1, body: "valid" }),
    );
    expect(malformed.map((response) => response.status())).toEqual([400, 400, 400, 400]);
    expect(unsigned.status()).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("handleSubmitReview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const VALID_BODY = {
    number: 7,
    comments: [
      { path: "src/a.ts", line: 25, body: "check" },
      { path: "src/b.ts", line: 41, body: "check this too" },
    ],
  };

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

  it("posts one COMMENT review with separate inline comments, restored paths, and no review body", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#pullrequestreview-1" }), { status: 200 });
    }) as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" });
    const captured = await invokePost(
      ctx,
      bodyRequest(VALID_BODY),
    );
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      url: "https://github.com/org/repo/pull/7#pullrequestreview-1",
      forced: false,
      pendingMerged: false,
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/org/repo/pulls/7/reviews");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      event: "COMMENT",
      comments: [
        { path: "packages/cli/src/a.ts", line: 25, side: "RIGHT", body: "check" },
        { path: "packages/cli/src/b.ts", line: 41, side: "RIGHT", body: "check this too" },
      ],
    });
  });

  it("forwards mixed LEFT and RIGHT line coordinates unchanged", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    let posted: unknown;
    vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch);

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      bodyRequest({
        number: 7,
        comments: [
          { path: "src/a.ts", line: 24, side: "LEFT", body: "deleted behavior" },
          { path: "src/a.ts", line: 25, side: "RIGHT", body: "replacement behavior" },
        ],
      }),
    );

    expect(captured.status()).toBe(200);
    expect(posted).toEqual({
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 24, side: "LEFT", body: "deleted behavior" },
        { path: "src/a.ts", line: 25, side: "RIGHT", body: "replacement behavior" },
      ],
    });
  });

  it("never adds a review-level body to the GitHub payload", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    let posted: unknown;
    vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch);
    await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));
    expect(posted).toEqual({
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 25, side: "RIGHT", body: "check" },
        { path: "src/b.ts", line: 41, side: "RIGHT", body: "check this too" },
      ],
    });
  });

  it("creates a pinned file-only pending review, attaches a FILE thread, then submits it", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_file" } } } }), { status: 200 });
      }
      if (String(url).endsWith("/events")) {
        return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#review" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 51, node_id: "PRR_node_51" }), { status: 200 });
    }) as typeof fetch);

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" }),
      bodyRequest({
        number: 7,
        event: "COMMENT",
        body: "General review context.",
        comments: [],
        fileComments: [{ path: "src/a.ts", label: null, body: "This still needs attention." }],
        commitId: "ABCDEF1234567",
      }),
    );

    expect(JSON.parse(captured.body())).toEqual({
      url: "https://github.com/org/repo/pull/7#review",
      forced: false,
      pendingMerged: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/org/repo/pulls/7/reviews",
      "https://api.github.com/graphql",
      "https://api.github.com/repos/org/repo/pulls/7/reviews/51/events",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      commit_id: "ABCDEF1234567",
      comments: [],
      body: "General review context.",
    });
    const graphql = JSON.parse(String(calls[1].init?.body));
    expect(graphql.query).toContain("subjectType: FILE");
    expect(graphql.variables).toEqual({
      reviewId: "PRR_node_51",
      path: "packages/cli/src/a.ts",
      body: "**Meridian location:** review commit `ABCDEF1`\n\nThis still needs attention.",
    });
    expect(graphql.variables).not.toHaveProperty("line");
    expect(graphql.variables).not.toHaveProperty("side");
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ event: "COMMENT" });
  });

  it("keeps valid inline comments in a mixed pending review and adds labeled FILE threads", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_mixed" } } } }), { status: 200 });
      }
      if (String(url).endsWith("/events")) {
        return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#mixed" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 52, node_id: "PRR_node_52" }), { status: 200 });
    }) as typeof fetch);

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" }),
      bodyRequest({
        number: 7,
        event: "REQUEST_CHANGES",
        body: "Please address both issues.",
        comments: [{ path: "src/a.ts", line: 25, body: "Inline issue" }],
        fileComments: [{ path: "src/b.ts", label: "L70 · previous revision", body: "File issue" }],
        commitId: "abcdef1234567890",
      }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      url: "https://github.com/org/repo/pull/7#mixed",
      forced: false,
      pendingMerged: false,
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      commit_id: "abcdef1234567890",
      body: "Please address both issues.",
      comments: [{
        path: "packages/cli/src/a.ts",
        line: 25,
        side: "RIGHT",
        body: "Inline issue",
      }],
    });
    expect(JSON.parse(String(calls[1].init?.body)).variables).toEqual({
      reviewId: "PRR_node_52",
      path: "packages/cli/src/b.ts",
      body: "**Meridian location:** `L70 · previous revision` · review commit `abcdef1`\n\nFile issue",
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ event: "REQUEST_CHANGES" });
  });

  it("posts approval and request-changes decisions with optional inline comments", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const posted: unknown[] = [];
    vi.stubGlobal("fetch", (async (_url: string | URL | Request, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#review" }), { status: 200 });
    }) as typeof fetch);
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });

    const approve = await invokePost(ctx, bodyRequest({ number: 7, event: "APPROVE", comments: [] }));
    const requestChanges = await invokePost(ctx, bodyRequest({
      number: 7,
      event: "REQUEST_CHANGES",
      body: "Please address the blocking issue.",
      comments: [{ path: "src/a.ts", line: 25, body: "This is the blocker." }],
    }));

    expect([approve.status(), requestChanges.status()]).toEqual([200, 200]);
    expect(posted).toEqual([
      { event: "APPROVE", comments: [] },
      {
        event: "REQUEST_CHANGES",
        body: "Please address the blocking issue.",
        comments: [{ path: "src/a.ts", line: 25, side: "RIGHT", body: "This is the blocker." }],
      },
    ]);
  });

  it("400s on malformed comments/fileComments, legacy notes, invalid commits, and an empty submission", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    vi.stubGlobal("fetch", vi.fn());
    const ctx = ctxWithSource({ kind: "github", owner: "org", repo: "repo" });
    const noLine = await invokePost(ctx, bodyRequest({ number: 7, comments: [{ path: "a.ts", body: "x" }] }));
    const zeroLine = await invokePost(ctx, bodyRequest({ number: 7, comments: [{ path: "a.ts", line: 0, body: "x" }] }));
    const invalidSide = await invokePost(ctx, bodyRequest({
      number: 7,
      comments: [{ path: "a.ts", line: 2, side: "MIDDLE", body: "x" }],
    }));
    const malformedFileComments = await invokePost(ctx, bodyRequest({
      number: 7,
      comments: [{ path: "a.ts", line: 2, body: "inline" }],
      fileComments: [{ path: "a.ts", label: "", body: "missing label" }],
    }));
    const legacyNotes = await invokePost(ctx, bodyRequest({
      number: 7,
      comments: [{ path: "a.ts", line: 2, body: "inline" }],
      notes: [{ path: "a.ts", label: "L2", body: "legacy" }],
    }));
    const empty = await invokePost(ctx, bodyRequest({ number: 7, comments: [] }));
    const badEvent = await invokePost(ctx, bodyRequest({ number: 7, event: "MERGE", comments: [] }));
    const changesWithoutSummary = await invokePost(ctx, bodyRequest({ number: 7, event: "REQUEST_CHANGES", comments: [] }));
    const badCommit = await invokePost(ctx, bodyRequest({ ...VALID_BODY, commitId: "not-a-sha" }));
    const badNumber = await invokePost(ctx, bodyRequest({ ...VALID_BODY, number: 0 }));
    expect([
      noLine.status(),
      zeroLine.status(),
      invalidSide.status(),
      malformedFileComments.status(),
      legacyNotes.status(),
      empty.status(),
      badEvent.status(),
      changesWithoutSummary.status(),
      badCommit.status(),
      badNumber.status(),
    ]).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect(JSON.parse(malformedFileComments.body()).error).toMatch(/path, optional label/);
    expect(JSON.parse(legacyNotes.body()).error).toMatch(/use fileComments/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries an inline-anchor 422 once with every inline draft converted to FILE threads", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
            message: "Validation Failed",
            errors: [{ message: "Pull request review thread line must be part of the diff" }],
          }), { status: 422 });
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify({ id: 61, node_id: "PRR_node_61" }), { status: 200 });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({
          data: { addPullRequestReviewThread: { thread: { id: `PRRT_${calls.length}` } } },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#forced" }), { status: 200 });
    }));
    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      bodyRequest({
        ...VALID_BODY,
        comments: [
          { path: "src/a.ts", line: 25, side: "LEFT", body: "check" },
          { path: "src/b.ts", line: 41, side: "RIGHT", body: "check this too" },
        ],
        fileComments: [{ path: "src/c.ts", label: "File", body: "Existing file note" }],
        commitId: "abcdef1234567",
      }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      url: "https://github.com/org/repo/pull/7#forced",
      forced: true,
      pendingMerged: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/org/repo/pulls/7/reviews",
      "https://api.github.com/repos/org/repo/pulls/7/reviews",
      "https://api.github.com/graphql",
      "https://api.github.com/graphql",
      "https://api.github.com/graphql",
      "https://api.github.com/repos/org/repo/pulls/7/reviews/61/events",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      commit_id: "abcdef1234567",
      comments: [
        { path: "src/a.ts", line: 25, side: "LEFT", body: "check" },
        { path: "src/b.ts", line: 41, side: "RIGHT", body: "check this too" },
      ],
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      commit_id: "abcdef1234567",
      comments: [],
    });
    expect(calls.slice(2, 5).map((call) => JSON.parse(String(call.init?.body)).variables)).toEqual([
      {
        reviewId: "PRR_node_61",
        path: "src/c.ts",
        body: "**Meridian location:** `File` · review commit `abcdef1`\n\nExisting file note",
      },
      {
        reviewId: "PRR_node_61",
        path: "src/a.ts",
        body: "**Meridian location:** `L25 · base` · review commit `abcdef1`\n\ncheck",
      },
      {
        reviewId: "PRR_node_61",
        path: "src/b.ts",
        body: "**Meridian location:** `L41` · review commit `abcdef1`\n\ncheck this too",
      },
    ]);
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({ event: "COMMENT" });
  });

  it("retries an inline 422 only once and surfaces the second rejection", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: "Validation Failed",
      errors: [{ message: "Pull request review thread line must be part of the diff" }],
    }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const captured = await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));

    expect(captured.status()).toBe(422);
    expect(JSON.parse(captured.body()).error).toMatch(/line must be part/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not force-retry an unclassified GitHub 422", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      message: "Validation Failed",
      errors: [{ resource: "PullRequestReview", code: "custom" }],
    }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    const captured = await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));

    expect(captured.status()).toBe(422);
    expect(JSON.parse(captured.body()).error).toBe("GitHub rejected the review (validation failed)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back only the newly-created pending review when a FILE-thread mutation fails", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: 71, node_id: "PRR_node_71" }), { status: 200 });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({ errors: [{ message: "thread failed" }] }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }));

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      bodyRequest({
        number: 7,
        comments: [],
        fileComments: [{ path: "src/a.ts", label: "L20", body: "Keep this" }],
      }),
    );

    expect(captured.status()).toBe(502);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["https://api.github.com/repos/org/repo/pulls/7/reviews", "POST"],
      ["https://api.github.com/graphql", "POST"],
      ["https://api.github.com/repos/org/repo/pulls/7/reviews/71", "DELETE"],
    ]);
  });

  it("rolls back the newly-created pending review when final event submission fails", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ id: 72, node_id: "PRR_node_72" }), { status: 200 });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_72" } } } }), { status: 200 });
      }
      if (String(url).endsWith("/events")) {
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      }
      return new Response(null, { status: 204 });
    }));

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo" }),
      bodyRequest({
        number: 7,
        comments: [],
        fileComments: [{ path: "src/a.ts", label: null, body: "Keep this too" }],
      }),
    );

    expect(captured.status()).toBe(502);
    expect(calls.map((call) => [call.url, call.init?.method])).toEqual([
      ["https://api.github.com/repos/org/repo/pulls/7/reviews", "POST"],
      ["https://api.github.com/graphql", "POST"],
      ["https://api.github.com/repos/org/repo/pulls/7/reviews/72/events", "POST"],
      ["https://api.github.com/repos/org/repo/pulls/7/reviews/72", "DELETE"],
    ]);
  });

  it("submits a unique existing pending review as COMMENT, then retries the requested review once", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          message: "Validation Failed",
          errors: ["User can only have one pending review per pull request"],
        }), { status: 422 });
      }
      if (calls.length === 2) {
        return new Response(JSON.stringify([
          { id: 80, state: "COMMENTED", body: "An older submitted review" },
          { id: 91, state: "PENDING", body: "Existing pending review body." },
        ]), { status: 200 });
      }
      if (calls.length === 3) {
        return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#pending-91" }), { status: 200 });
      }
      if (calls.length === 4) {
        return new Response(JSON.stringify({ id: 99, node_id: "PRR_node_99" }), { status: 200 });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "PRRT_99" } } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/org/repo/pull/7#new-99" }), { status: 200 });
    }));

    const captured = await invokePost(
      ctxWithSource({ kind: "github", owner: "org", repo: "repo", subdir: "packages/cli" }),
      bodyRequest({
        ...VALID_BODY,
        event: "REQUEST_CHANGES",
        body: "Current review summary.",
        fileComments: [{ path: "src/c.ts", label: "File", body: "Already classified as a file comment." }],
        commitId: "abcdef1234567",
      }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({
      url: "https://github.com/org/repo/pull/7#new-99",
      forced: false,
      pendingMerged: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/org/repo/pulls/7/reviews",
      "https://api.github.com/repos/org/repo/pulls/7/reviews?per_page=100&page=1",
      "https://api.github.com/repos/org/repo/pulls/7/reviews/91/events",
      "https://api.github.com/repos/org/repo/pulls/7/reviews",
      "https://api.github.com/graphql",
      "https://api.github.com/repos/org/repo/pulls/7/reviews/99/events",
    ]);
    expect(calls[1].init?.method).toBeUndefined();
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      event: "COMMENT",
    });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      commit_id: "abcdef1234567",
      body: "Current review summary.",
      comments: [
        { path: "packages/cli/src/a.ts", line: 25, side: "RIGHT", body: "check" },
        { path: "packages/cli/src/b.ts", line: 41, side: "RIGHT", body: "check this too" },
      ],
    });
    expect(JSON.parse(String(calls[4].init?.body)).variables).toEqual({
      reviewId: "PRR_node_99",
      path: "packages/cli/src/c.ts",
      body: "**Meridian location:** `File` · review commit `abcdef1`\n\nAlready classified as a file comment.",
    });
    expect(JSON.parse(String(calls[5].init?.body))).toEqual({ event: "REQUEST_CHANGES" });
  });

  it("surfaces the exact pending-review conflict when no unique pending review is visible", async () => {
    vi.stubEnv("GITHUB_TOKEN", "env_secret");
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? new Response(JSON.stringify({
          message: "Validation Failed",
          errors: [{ message: "User can only have one pending review per pull request" }],
        }), { status: 422 })
      : new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const captured = await invokePost(ctxWithSource({ kind: "github", owner: "org", repo: "repo" }), bodyRequest(VALID_BODY));

    expect(captured.status()).toBe(422);
    expect(JSON.parse(captured.body()).error).toContain("User can only have one pending review per pull request");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** A minimal IncomingMessage whose stream yields one JSON body (what readJsonBody consumes). */
function bodyRequest(payload: unknown, cookie?: string): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as IncomingMessage;
  (request as { headers: Record<string, string> }).headers = cookie ? { cookie } : {};
  return request;
}

async function invokeCommentMutation(ctx: Context, request: IncomingMessage) {
  const captured = capturedResponse();
  try {
    await handlePullRequestCommentMutation(ctx, request, captured.response, new URLSearchParams({ id: "artifact" }));
  } catch (error) {
    if (!(error instanceof WebError)) {
      throw error;
    }
    sendJson(captured.response, error.status, { error: error.message });
  }
  return captured;
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
  const graphStore = new WebGraphStore();
  activeGraphStores.push(graphStore);
  publishSource(graphStore, "artifact", source);
  return {
    shutdownSignal: new AbortController().signal,
    graphStore,
    prFilesCache: new Map(),
    rendererIndex: "",
    landingHtml: "",
    staticAssets: { rendererRoot: "", indexHtml: "" },
    cwd: "",
    sessions,
    github: createGitHubClient({ clientId: "Iv1.test" }),
    allowSyntheticExecution: false,
  } as Context;
}

function publishSource(graphStore: WebGraphStore, id: string, source: ArtifactSource): void {
  graphStore.publish({
    id,
    material: materializeValidatedArtifact(TEST_ARTIFACT),
    metadata: {
      sourceRoot: "/workspace/test",
      source,
      synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
    },
  });
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
