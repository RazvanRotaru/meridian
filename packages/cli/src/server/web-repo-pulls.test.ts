import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GitHubClient, PullRequestsRequest, PullRequestsResult } from "./github";
import type { PrSummary } from "./github-parse";
import { SessionStore, markAuthorized } from "./session";
import type { AuthContext } from "./web-auth";
import { handleRepoPullRequests } from "./web-repo-pulls";

const RESULT: PullRequestsResult = {
  prs: [
    {
      number: 17,
      title: "Add direct review",
      body: null,
      author: "daria",
      headRef: "feature/direct-review",
      headSha: "abc1234",
      baseRef: "main",
      updatedAt: "2026-07-12T10:00:00Z",
      draft: false,
      state: "open",
      url: "https://github.com/meridian-app/meridian/pull/17",
    } satisfies PrSummary,
  ],
  hasMore: true,
};

describe("handleRepoPullRequests", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", saved.GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", saved.GH_TOKEN);
  });

  it("lists a public repository anonymously and returns the existing PR-list shape", async () => {
    const seen: PullRequestsRequest[] = [];
    const captured = capturedResponse();

    await handleRepoPullRequests(
      contextListing(RESULT, seen),
      requestWith(undefined),
      captured.response,
      new URLSearchParams({ repo: "meridian-app/meridian", state: "open", page: "2" }),
    );

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual(RESULT);
    expect(seen).toEqual([
      {
        owner: "meridian-app",
        repo: "meridian",
        state: "open",
        page: 2,
        token: undefined,
        includeViewerStatus: true,
      },
    ]);
  });

  it("uses the normal token chain for private repositories", async () => {
    process.env.GITHUB_TOKEN = "ghp_environment";
    const seen: PullRequestsRequest[] = [];
    const captured = capturedResponse();

    await handleRepoPullRequests(
      { ...contextListing(RESULT, seen), fallbackToken: "gho_fallback" },
      requestWith(undefined),
      captured.response,
      new URLSearchParams({ repo: "private-org/project", state: "closed", page: "1" }),
    );

    expect(captured.status()).toBe(200);
    expect(seen[0]).toEqual({
      owner: "private-org",
      repo: "project",
      state: "closed",
      page: 1,
      token: "ghp_environment",
      includeViewerStatus: true,
    });
  });

  it("prefers an interactive session token over ambient and fallback tokens", async () => {
    process.env.GITHUB_TOKEN = "ghp_environment";
    const sessions = new SessionStore();
    const now = Date.now();
    const { id, session } = sessions.create({ deviceCode: "device", intervalSeconds: 5, expiresAt: now + 60_000 }, now);
    markAuthorized(session, "gho_session", { login: "daria", avatarUrl: null }, now);
    const seen: PullRequestsRequest[] = [];
    const captured = capturedResponse();
    const ctx = { ...contextListing(RESULT, seen), sessions, fallbackToken: "gho_fallback" };

    await handleRepoPullRequests(
      ctx,
      requestWith(`meridian_sid=${id}`),
      captured.response,
      new URLSearchParams({ repo: "private-org/project", state: "open", page: "1" }),
    );

    expect(seen[0].token).toBe("gho_session");
  });

  it.each([
    [{ state: "open", page: "1" }, "repo must be an exact owner/repo"],
    [{ repo: "https://github.com/org/repo", state: "open", page: "1" }, "repo must be an exact owner/repo"],
    [{ repo: "org/repo/extra", state: "open", page: "1" }, "repo must be an exact owner/repo"],
    [{ repo: "org/repo", state: "all", page: "1" }, "state must be 'open' or 'closed'"],
    [{ repo: "org/repo", state: "open", page: "0" }, "page must be a positive integer"],
    [{ repo: "org/repo", state: "open", page: "1.5" }, "page must be a positive integer"],
    [{ repo: "org/repo", state: "open", page: "9007199254740992" }, "page must be a positive integer"],
  ])("rejects invalid query parameters before calling GitHub: %o", async (params, error) => {
    const captured = capturedResponse();

    await handleRepoPullRequests(
      { sessions: new SessionStore(), github: neverCalledGitHub() },
      requestWith(undefined),
      captured.response,
      new URLSearchParams(params),
    );

    expect(captured.status()).toBe(400);
    expect(JSON.parse(captured.body())).toEqual({ error });
  });
});

function contextListing(result: PullRequestsResult, seen: PullRequestsRequest[]): AuthContext {
  return {
    sessions: new SessionStore(),
    github: {
      ...neverCalledGitHub(),
      listPullRequests: async (request) => {
        seen.push(request);
        return result;
      },
    },
  };
}

function requestWith(cookie: string | undefined): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as IncomingMessage;
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

function neverCalledGitHub(): GitHubClient {
  const reject = () => Promise.reject(new Error("unexpected GitHub call"));
  return {
    requestDeviceCode: reject,
    redeemToken: reject,
    getUser: reject,
    searchRepos: reject,
    listOwnRepos: reject,
    listBranches: reject,
    listPullRequests: reject,
    fetchPullRequestFiles: reject,
    submitPullRequestReview: reject,
  };
}

function restoreEnv(key: "GITHUB_TOKEN" | "GH_TOKEN", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
