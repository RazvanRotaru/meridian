/**
 * The `/api/repos/*` handlers. The load-bearing guarantees: for `mine`, the session cookie is the
 * only credential (no cookie -> 401 without ever touching GitHub) and a signed-in session forwards
 * only the whitelisted repo summaries — never the token; for `branches`, no cookie means a
 * tokenless (public-data) GitHub call, not a 401.
 */

import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleBranches, handleOwnRepos } from "./web-auth";
import type { AuthContext } from "./web-auth";
import { SessionStore, markAuthorized } from "./session";
import type { GitHubClient } from "./github";
import type { RepoSummary } from "./github-parse";

const REPO: RepoSummary = {
  fullName: "daria/meridian-playground",
  isPrivate: true,
  defaultBranch: "main",
  description: "a test repo",
  ownerAvatarUrl: null,
};

describe("handleOwnRepos", () => {
  it("401s without a session and never calls GitHub", async () => {
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
});

describe("handleBranches", () => {
  it("400s on a missing repo parameter", async () => {
    const ctx: AuthContext = { sessions: new SessionStore(), github: neverCalledGitHub() };
    const captured = capturedResponse();
    await handleBranches(ctx, requestWith(undefined), captured.response, "  ");
    expect(captured.status()).toBe(400);
  });

  it("lists branches tokenless when nobody is signed in", async () => {
    const calls: Array<{ token: string | undefined; repo: string }> = [];
    const github: GitHubClient = {
      ...neverCalledGitHub(),
      listBranches: async (token, repo) => {
        calls.push({ token, repo });
        return ["main", "dev"];
      },
    };
    const ctx: AuthContext = { sessions: new SessionStore(), github };
    const captured = capturedResponse();
    await handleBranches(ctx, requestWith(undefined), captured.response, "owner/repo");
    expect(captured.status()).toBe(200);
    expect(JSON.parse(captured.body())).toEqual({ branches: ["main", "dev"] });
    expect(calls).toEqual([{ token: undefined, repo: "owner/repo" }]);
  });

  it("forwards the signed-in session's token", async () => {
    const sessions = new SessionStore();
    const now = Date.now();
    const { id, session } = sessions.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: now + 60_000 }, now);
    markAuthorized(session, "gho_secret", { login: "daria", avatarUrl: null }, now);
    const tokens: Array<string | undefined> = [];
    const github: GitHubClient = {
      ...neverCalledGitHub(),
      listBranches: async (token) => {
        tokens.push(token);
        return ["main"];
      },
    };
    const captured = capturedResponse();
    await handleBranches({ sessions, github }, requestWith(`meridian_sid=${id}`), captured.response, "owner/repo");
    expect(captured.status()).toBe(200);
    expect(tokens).toEqual(["gho_secret"]);
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

function neverCalledGitHub(): GitHubClient {
  const reject = () => Promise.reject(new Error("unexpected GitHub call"));
  return {
    requestDeviceCode: reject,
    redeemToken: reject,
    getUser: reject,
    searchRepos: reject,
    listOwnRepos: reject,
    listBranches: reject,
  };
}
