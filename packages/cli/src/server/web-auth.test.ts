/**
 * `/api/repos/*` + `/api/auth/session`. The load-bearing guarantees: with no usable token at all
 * (no session, no env, no gh fallback) `/api/repos/mine` 401s without ever touching GitHub, while
 * public branch discovery still runs anonymously; a `gh` fallback token signs the UI in and reaches
 * private data WITHOUT an interactive session; tokens are never forwarded to the browser.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAuthSession, handleOwnRepos, handleRepoBranches } from "./web-auth";
import type { AuthContext } from "./web-auth";
import { SessionStore, markAuthorized } from "./session";
import type { BranchesRequest, GitHubClient } from "./github";
import type { GitHubUser, RepoSummary } from "./github-parse";

const REPO: RepoSummary = {
  fullName: "daria/meridian-playground",
  isPrivate: true,
  defaultBranch: "main",
  description: "a test repo",
  ownerAvatarUrl: null,
};

const GH_USER: GitHubUser = { login: "iulia", avatarUrl: null };

describe("handleOwnRepos", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", saved.GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", saved.GH_TOKEN);
  });

  it("401s without any usable token and never calls GitHub", async () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: neverCalledGitHub() };
    const captured = capturedResponse();
    await handleOwnRepos(ctx, requestWith(undefined), captured.response);
    expect(captured.status()).toBe(401);
  });

  it("returns the signed-in user's repos", async () => {
    const sessions = new SessionStore();
    const now = Date.now();
    const { id, session } = sessions.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: now + 60_000 }, now);
    markAuthorized(session, "gho_secret", { login: "daria", avatarUrl: null }, now);
    const ctx: AuthContext = { sessions, github: githubListing([REPO]) };
    const captured = capturedResponse();
    await handleOwnRepos(ctx, requestWith(`meridian_sid=${id}`), captured.response);
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ repos: [REPO] });
  });

  it("lists repos via the gh fallback token — no interactive session needed", async () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: githubListing([REPO]), fallbackToken: "gho_gh_cli" };
    const captured = capturedResponse();
    await handleOwnRepos(ctx, requestWith(undefined), captured.response);
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ repos: [REPO] });
  });
});

describe("handleAuthSession", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", saved.GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", saved.GH_TOKEN);
  });

  it("reports signed-out when there's no token anywhere", () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: neverCalledGitHub() };
    const captured = capturedResponse();
    handleAuthSession(ctx, requestWith(undefined), captured.response);
    expect(JSON.parse(captured.body())).toEqual({ signedIn: false, user: null });
  });

  it("reports signed-in as the gh fallback user without any session", () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: neverCalledGitHub(), fallbackToken: "gho_gh_cli", fallbackUser: GH_USER };
    const captured = capturedResponse();
    handleAuthSession(ctx, requestWith(undefined), captured.response);
    expect(JSON.parse(captured.body())).toEqual({ signedIn: true, user: GH_USER });
  });
});

describe("handleRepoBranches", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", saved.GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", saved.GH_TOKEN);
  });

  it("lists a signed-out public repo with no token", async () => {
    const seen: BranchesRequest[] = [];
    const ctx: AuthContext = { sessions: new SessionStore(), github: githubBranches(["main", "next"], seen) };
    const captured = capturedResponse();

    await handleRepoBranches(ctx, requestWith(undefined), captured.response, "https://github.com/public-org/project.git");

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ branches: ["main", "next"] });
    expect(seen).toEqual([{ owner: "public-org", repo: "project", token: undefined }]);
  });

  it("passes an available token for private repository discovery", async () => {
    const seen: BranchesRequest[] = [];
    const ctx: AuthContext = {
      sessions: new SessionStore(),
      github: githubBranches(["main"], seen),
      fallbackToken: "gho_gh_cli",
    };
    const captured = capturedResponse();

    await handleRepoBranches(ctx, requestWith(undefined), captured.response, "private-org/project");

    expect(captured.status()).toBe(200);
    expect(seen[0]).toEqual({ owner: "private-org", repo: "project", token: "gho_gh_cli" });
  });

  it("forwards a non-empty priority query without requiring authentication", async () => {
    const seen: BranchesRequest[] = [];
    const ctx: AuthContext = {
      sessions: new SessionStore(),
      github: githubBranches(["feature/search"], seen),
    };
    const captured = capturedResponse();

    await handleRepoBranches(ctx, requestWith(undefined), captured.response, "public-org/project", " search ");

    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ branches: ["feature/search"] });
    expect(seen).toEqual([{
      owner: "public-org",
      repo: "project",
      token: undefined,
      query: "search",
    }]);
  });

  it("rejects fuzzy or non-GitHub repository input before calling GitHub", async () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: neverCalledGitHub() };
    const captured = capturedResponse();

    await handleRepoBranches(ctx, requestWith(undefined), captured.response, "search words");

    expect(captured.status()).toBe(400);
    expect(JSON.parse(captured.body())).toEqual({ error: "repository must be owner/repo or a github.com URL" });
  });
});

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

function githubListing(repos: RepoSummary[]): GitHubClient {
  return { ...neverCalledGitHub(), listOwnRepos: async () => repos };
}

function githubBranches(branches: string[], seen: BranchesRequest[]): GitHubClient {
  return {
    ...neverCalledGitHub(),
    listBranches: async (request) => {
      seen.push(request);
      return branches;
    },
  };
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
