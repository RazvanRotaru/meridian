/**
 * `githubTokenFor` precedence: explicit → session → GITHUB_TOKEN → GH_TOKEN → the `gh` CLI fallback.
 * The fallback (resolved once at boot) sits BELOW the env vars so an explicit token always wins.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { githubTokenFor } from "./web-auth";
import type { AuthContext } from "./web-auth";
import { SessionStore, markAuthorized } from "./session";

describe("githubTokenFor precedence", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    restoreEnv("GITHUB_TOKEN", saved.GITHUB_TOKEN);
    restoreEnv("GH_TOKEN", saved.GH_TOKEN);
  });

  it("prefers an explicit token over everything", () => {
    const { ctx, request } = signedInContext("session");
    process.env.GITHUB_TOKEN = "env";
    ctx.fallbackToken = "gh";
    expect(githubTokenFor(ctx, request, "explicit")).toBe("explicit");
  });

  it("prefers a signed-in session over env and fallback", () => {
    const { ctx, request } = signedInContext("session");
    process.env.GITHUB_TOKEN = "env";
    ctx.fallbackToken = "gh";
    expect(githubTokenFor(ctx, request)).toBe("session");
  });

  it("prefers an env token over the gh fallback", () => {
    const ctx = ctxWith({ fallbackToken: "gh" });
    process.env.GITHUB_TOKEN = "env";
    expect(githubTokenFor(ctx, requestWith())).toBe("env");
  });

  it("uses GH_TOKEN when GITHUB_TOKEN is absent, still above the fallback", () => {
    const ctx = ctxWith({ fallbackToken: "gh" });
    process.env.GH_TOKEN = "gh-env";
    expect(githubTokenFor(ctx, requestWith())).toBe("gh-env");
  });

  it("falls back to the gh CLI token when nothing else is present", () => {
    const ctx = ctxWith({ fallbackToken: "gh" });
    expect(githubTokenFor(ctx, requestWith())).toBe("gh");
  });

  it("is undefined when no source of a token exists", () => {
    expect(githubTokenFor(ctxWith(), requestWith())).toBeUndefined();
  });
});

function ctxWith(overrides: Partial<AuthContext> = {}): AuthContext {
  return { sessions: new SessionStore(), github: null, ...overrides };
}

function requestWith(cookie?: string): IncomingMessage {
  return { headers: cookie ? { cookie } : {} } as IncomingMessage;
}

function signedInContext(token: string): { ctx: AuthContext; request: IncomingMessage } {
  const sessions = new SessionStore();
  const now = Date.now();
  const { id, session } = sessions.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: now + 60_000 }, now);
  markAuthorized(session, token, { login: "u", avatarUrl: null }, now);
  return { ctx: ctxWith({ sessions }), request: requestWith(`meridian_sid=${id}`) };
}

function restoreEnv(key: "GITHUB_TOKEN" | "GH_TOKEN", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
