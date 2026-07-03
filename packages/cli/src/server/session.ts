/**
 * In-memory session store for the web sign-in flow. It holds the device-flow poll state and, once
 * authorized, the GitHub token — which lives ONLY here (never a response body, log, or graph id).
 * Sessions are keyed by a random id carried in an HttpOnly cookie, swept on TTL, and capped so
 * repeated `/api/auth/device` calls can't grow memory without bound. Poll pacing is server-side:
 * the browser's cadence is untrusted, so `pollDue` gates every real GitHub round-trip.
 */

import { randomBytes } from "node:crypto";
import type { GitHubUser } from "./github-parse";

const COOKIE_NAME = "meridian_sid";
const MAX_SESSIONS = 100;
const SLOW_DOWN_STEP_SECONDS = 5;
export const AUTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface Session {
  deviceCode: string;
  intervalSeconds: number;
  nextPollAt: number;
  expiresAt: number;
  token: string | null;
  user: GitHubUser | null;
}

export interface SessionSeed {
  deviceCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(seed: SessionSeed, now: number): { id: string; session: Session } {
    this.sweep(now);
    this.enforceCap();
    const id = randomBytes(32).toString("hex");
    const session: Session = { ...seed, nextPollAt: nextPollAt(now, seed.intervalSeconds), token: null, user: null };
    this.sessions.set(id, session);
    return { id, session };
  }

  get(id: string | undefined, now: number): Session | undefined {
    this.sweep(now);
    return id ? this.sessions.get(id) : undefined;
  }

  delete(id: string | undefined): void {
    if (id) {
      this.sessions.delete(id);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  private sweep(now: number): void {
    for (const [id, session] of this.sessions) {
      if (isExpired(session, now)) {
        this.sessions.delete(id);
      }
    }
  }

  private enforceCap(): void {
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.sessions.delete(oldest);
    }
  }
}

export function isExpired(session: Session, now: number): boolean {
  return now >= session.expiresAt;
}

export function pollDue(session: Session, now: number): boolean {
  return now >= session.nextPollAt;
}

/** After a still-pending poll, wait one interval before hitting GitHub again. */
export function scheduleRetry(session: Session, now: number): void {
  session.nextPollAt = nextPollAt(now, session.intervalSeconds);
}

/** GitHub asked us to back off: raise the interval by at least the RFC 8628 step, then reschedule. */
export function applySlowDown(session: Session, suggestedSeconds: number, now: number): void {
  session.intervalSeconds = Math.max(session.intervalSeconds + SLOW_DOWN_STEP_SECONDS, suggestedSeconds);
  session.nextPollAt = nextPollAt(now, session.intervalSeconds);
}

/** Store the token + identity and extend the session past the short-lived device-code window. */
export function markAuthorized(session: Session, token: string, user: GitHubUser, now: number): void {
  session.token = token;
  session.user = user;
  session.expiresAt = now + AUTH_SESSION_TTL_MS;
}

export function readSessionId(cookieHeader: string | undefined): string | undefined {
  return parseCookie(cookieHeader)[COOKIE_NAME];
}

export function sessionCookie(id: string): string {
  return serializeCookie(COOKIE_NAME, id, AUTH_SESSION_TTL_MS / 1000);
}

export function clearedCookie(): string {
  return serializeCookie(COOKIE_NAME, "", 0);
}

function nextPollAt(now: number, intervalSeconds: number): number {
  return now + intervalSeconds * 1000;
}

function parseCookie(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return jar;
}

// No `Secure`: the web UI is http on loopback. HttpOnly keeps the id out of document.cookie and
// SameSite=Strict keeps it off every cross-site request, closing the CSRF/rebinding path.
function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`;
}
