/**
 * The session store's network-free logic: server-side poll pacing (the browser's cadence is never
 * trusted), TTL sweeping + capacity so device-code spam can't grow memory, and the HttpOnly cookie
 * serialization. Every time-dependent helper takes `now` explicitly, so no fake clock is needed.
 */

import { describe, expect, it } from "vitest";
import {
  AUTH_SESSION_TTL_MS,
  SessionStore,
  applySlowDown,
  clearedCookie,
  markAuthorized,
  pollDue,
  readSessionId,
  scheduleRetry,
  sessionCookie,
} from "./session";
import type { Session } from "./session";

function pending(now: number): Session {
  return { deviceCode: "dev", intervalSeconds: 5, nextPollAt: now, expiresAt: now + 900_000, token: null, user: null };
}

describe("SessionStore", () => {
  it("creates a retrievable session and forgets an unknown id", () => {
    const store = new SessionStore();
    const { id } = store.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: 10_000 }, 0);
    expect(store.get(id, 0)?.deviceCode).toBe("d");
    expect(store.get("missing", 0)).toBeUndefined();
  });

  it("sweeps a session once past its expiry", () => {
    const store = new SessionStore();
    const { id } = store.create({ deviceCode: "d", intervalSeconds: 5, expiresAt: 1_000 }, 0);
    expect(store.get(id, 999)).toBeDefined();
    expect(store.get(id, 1_000)).toBeUndefined();
  });

  it("caps total sessions, evicting the oldest first", () => {
    const store = new SessionStore();
    const first = store.create({ deviceCode: "first", intervalSeconds: 5, expiresAt: 1e15 }, 0).id;
    for (let index = 0; index < 120; index += 1) {
      store.create({ deviceCode: `d${index}`, intervalSeconds: 5, expiresAt: 1e15 }, 0);
    }
    expect(store.size).toBeLessThanOrEqual(100);
    expect(store.get(first, 0)).toBeUndefined();
  });
});

describe("poll pacing", () => {
  it("is due only once now reaches nextPollAt", () => {
    const session = pending(1_000);
    expect(pollDue(session, 999)).toBe(false);
    expect(pollDue(session, 1_000)).toBe(true);
  });

  it("waits one interval after a pending poll", () => {
    const session = pending(0);
    scheduleRetry(session, 10_000);
    expect(session.nextPollAt).toBe(10_000 + 5_000);
  });

  it("backs off by at least the RFC step on slow_down", () => {
    const session = pending(0);
    applySlowDown(session, 6, 1_000);
    expect(session.intervalSeconds).toBe(10); // max(5 + 5, 6)
    expect(session.nextPollAt).toBe(1_000 + 10_000);
  });

  it("stores the token and extends the session on authorization", () => {
    const session = pending(0);
    markAuthorized(session, "gho_abc", { login: "me", avatarUrl: null }, 5_000);
    expect(session.token).toBe("gho_abc");
    expect(session.user).toEqual({ login: "me", avatarUrl: null });
    expect(session.expiresAt).toBe(5_000 + AUTH_SESSION_TTL_MS);
  });
});

describe("session cookie", () => {
  it("serializes an HttpOnly, SameSite=Strict, path-scoped cookie", () => {
    const cookie = sessionCookie("abc123");
    expect(cookie).toContain("meridian_sid=abc123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("clears the cookie with Max-Age=0", () => {
    expect(clearedCookie()).toContain("Max-Age=0");
  });

  it("reads the session id out of a Cookie header, or nothing", () => {
    expect(readSessionId("meridian_sid=abc123; other=1")).toBe("abc123");
    expect(readSessionId("other=1")).toBeUndefined();
    expect(readSessionId(undefined)).toBeUndefined();
  });
});
