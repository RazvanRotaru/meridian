/**
 * The `/api/auth/*` and `/api/repos/*` HTTP handlers — the device-flow orchestration that ties
 * the GitHub client to the session store. The token stays server-side: responses carry only the
 * user code, the identity, and whitelisted repo summaries. Poll pacing is enforced here (never
 * trusting the browser's cadence) via the pure `pollDue`/`scheduleRetry`/`applySlowDown` helpers.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { WebError } from "./web-error";
import { sendJson } from "./http-response";
import { requestHeader } from "./web-guards";
import type { GitHubClient } from "./github";
import type { DeviceCode, TokenPoll } from "./github-auth";
import type { GitHubUser } from "./github-parse";
import { SessionStore, applySlowDown, clearedCookie, markAuthorized, pollDue, readSessionId, scheduleRetry, sessionCookie } from "./session";
import type { Session } from "./session";

export interface AuthContext {
  sessions: SessionStore;
  /** The GitHub client, or null when no client id was configured (sign-in disabled). */
  github: GitHubClient | null;
}

export async function handleDeviceStart(ctx: AuthContext, response: ServerResponse): Promise<void> {
  const device = await requireGitHub(ctx).requestDeviceCode();
  const now = Date.now();
  const seed = { deviceCode: device.deviceCode, intervalSeconds: device.intervalSeconds, expiresAt: now + device.expiresInSeconds * 1000 };
  const { id } = ctx.sessions.create(seed, now);
  sendJson(response, 200, publicDeviceCode(device), { "set-cookie": sessionCookie(id) });
}

export async function handleAuthStatus(ctx: AuthContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const now = Date.now();
  const id = readSessionId(requestHeader(request, "cookie"));
  const session = ctx.sessions.get(id, now);
  if (!session) {
    sendJson(response, 401, { signedIn: false, status: "expired" });
    return;
  }
  if (session.token && session.user) {
    sendJson(response, 200, authorizedBody(session.user));
    return;
  }
  const { body, terminal } = await pollStatus(ctx, session, now);
  if (terminal) {
    ctx.sessions.delete(id);
  }
  sendJson(response, 200, body);
}

export function handleLogout(ctx: AuthContext, request: IncomingMessage, response: ServerResponse): void {
  ctx.sessions.delete(readSessionId(requestHeader(request, "cookie")));
  sendJson(response, 200, { signedIn: false }, { "set-cookie": clearedCookie() });
}

export function handleAuthSession(ctx: AuthContext, request: IncomingMessage, response: ServerResponse): void {
  const session = ctx.sessions.get(readSessionId(requestHeader(request, "cookie")), Date.now());
  sendJson(response, 200, { configured: ctx.github !== null, signedIn: Boolean(session?.token), user: session?.user ?? null });
}

export async function handleRepoSearch(
  ctx: AuthContext,
  request: IncomingMessage,
  response: ServerResponse,
  query: string,
): Promise<void> {
  const token = sessionTokenFor(ctx, request);
  if (!token) {
    sendJson(response, 401, { error: "sign in to search repositories" });
    return;
  }
  sendJson(response, 200, { repos: await requireGitHub(ctx).searchRepos(token, query) });
}

export async function handleOwnRepos(ctx: AuthContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const token = sessionTokenFor(ctx, request);
  if (!token) {
    sendJson(response, 401, { error: "sign in to list your repositories" });
    return;
  }
  sendJson(response, 200, { repos: await requireGitHub(ctx).listOwnRepos(token) });
}

/** Branch names for one repo. No sign-in gate — tokenless works for public repos; a session
 * token, when present, unlocks private ones. */
export async function handleBranches(
  ctx: AuthContext,
  request: IncomingMessage,
  response: ServerResponse,
  repo: string,
): Promise<void> {
  if (repo.trim() === "") {
    sendJson(response, 400, { error: "repo query parameter is required" });
    return;
  }
  const token = sessionTokenFor(ctx, request);
  sendJson(response, 200, { branches: await requireGitHub(ctx).listBranches(token, repo.trim()) });
}

/** The session token feeding a clone (cookie → session), or undefined when not signed in. */
export function sessionTokenFor(ctx: AuthContext, request: IncomingMessage): string | undefined {
  const session = ctx.sessions.get(readSessionId(requestHeader(request, "cookie")), Date.now());
  return session?.token ?? undefined;
}

async function pollStatus(
  ctx: AuthContext,
  session: Session,
  now: number,
): Promise<{ body: Record<string, unknown>; terminal: boolean }> {
  if (!pollDue(session, now)) {
    return { body: pendingBody(), terminal: false };
  }
  const github = requireGitHub(ctx);
  const poll = await github.redeemToken(session.deviceCode);
  if (poll.status === "authorized") {
    const user = await github.getUser(poll.token);
    markAuthorized(session, poll.token, user, now);
    return { body: authorizedBody(user), terminal: false };
  }
  if (poll.status === "pending") {
    scheduleRetry(session, now);
    return { body: pendingBody(), terminal: false };
  }
  if (poll.status === "slow_down") {
    applySlowDown(session, poll.intervalSeconds, now);
    return { body: pendingBody(), terminal: false };
  }
  return { body: terminalBody(poll), terminal: true };
}

function publicDeviceCode(device: DeviceCode): Record<string, unknown> {
  return {
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  };
}

function authorizedBody(user: GitHubUser): Record<string, unknown> {
  return { signedIn: true, status: "authorized", user };
}

function pendingBody(): Record<string, unknown> {
  return { signedIn: false, status: "pending" };
}

function terminalBody(poll: Extract<TokenPoll, { status: "expired" | "denied" | "error" }>): Record<string, unknown> {
  if (poll.status === "error") {
    return { signedIn: false, status: "error", message: poll.message };
  }
  return { signedIn: false, status: poll.status };
}

function requireGitHub(ctx: AuthContext): GitHubClient {
  if (!ctx.github) {
    throw new WebError(
      400,
      "GitHub sign-in is not configured — set MERIDIAN_GITHUB_CLIENT_ID to a GitHub OAuth app client id with Device Flow enabled",
    );
  }
  return ctx.github;
}
