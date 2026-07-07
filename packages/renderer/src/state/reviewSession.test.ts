import { afterEach, describe, expect, it, vi } from "vitest";
import type { Target } from "@meridian/core";
import {
  artifactTargetIdentity,
  loadReviewedIds,
  persistReviewedIds,
  reviewScopeRefFor,
  reviewSessionKey,
} from "./reviewSession";

/** A fake window whose localStorage covers the get/set/remove reviewStorage exercises. */
function fakeWindow(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
}

function target(overrides: Partial<Target> = {}): Target {
  return { name: "orders", version: "1.0.0", root: "/repo", language: "typescript", ...overrides } as Target;
}

afterEach(() => vi.unstubAllGlobals());

describe("artifactTargetIdentity", () => {
  it("is stable across commits (never includes the sha)", () => {
    const a = target({ vcs: { repository: "git@x", commit: "aaa" } as Target["vcs"] });
    const b = target({ vcs: { repository: "git@x", commit: "bbb" } as Target["vcs"] });
    expect(artifactTargetIdentity(a)).toBe(artifactTargetIdentity(b));
  });

  it("differs when the repo/name/root differ", () => {
    expect(artifactTargetIdentity(target({ name: "orders" }))).not.toBe(artifactTargetIdentity(target({ name: "billing" })));
  });
});

describe("reviewScopeRefFor", () => {
  it("uses an explicit PR scope verbatim", () => {
    expect(reviewScopeRefFor("pr42", ["a/x.ts"])).toBe("pr42");
  });

  it("hashes the file set order-independently and after normalization", () => {
    const a = reviewScopeRefFor(null, ["b/y.ts", "a/x.ts"]);
    const b = reviewScopeRefFor(null, ["./a/x.ts", "b\\y.ts"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the file set changes", () => {
    expect(reviewScopeRefFor(null, ["a/x.ts"])).not.toBe(reviewScopeRefFor(null, ["a/x.ts", "b/y.ts"]));
  });
});

describe("reviewSessionKey", () => {
  it("prefixes the meridian review namespace and carries the scope", () => {
    expect(reviewSessionKey(target(), "pr7", ["a/x.ts"])).toMatch(/^meridian\.review\.v1:[0-9a-f]{8}:pr7$/);
  });
});

describe("persist/load reviewed ids", () => {
  it("round-trips the ticked flow set", () => {
    vi.stubGlobal("window", fakeWindow());
    const key = reviewSessionKey(target(), "pr1", ["a/x.ts"]);
    persistReviewedIds(key, new Set(["ts:a#f", "ts:a#g"]), ["a/x.ts"]);
    expect(loadReviewedIds(key)).toEqual(new Set(["ts:a#f", "ts:a#g"]));
  });

  it("preserves an earlier review date when the set is re-persisted", () => {
    const win = fakeWindow();
    vi.stubGlobal("window", win);
    const key = reviewSessionKey(target(), "pr1", ["a/x.ts"]);
    persistReviewedIds(key, new Set(["ts:a#f"]), ["a/x.ts"]);
    const firstDate = JSON.parse(win.localStorage.getItem(key) as string).reviewed["ts:a#f"];
    persistReviewedIds(key, new Set(["ts:a#f", "ts:a#g"]), ["a/x.ts"]);
    expect(JSON.parse(win.localStorage.getItem(key) as string).reviewed["ts:a#f"]).toBe(firstDate);
  });

  it("returns an empty set when nothing is stored", () => {
    vi.stubGlobal("window", fakeWindow());
    expect(loadReviewedIds("meridian.review.v1:deadbeef:prX")).toEqual(new Set());
  });

  it("returns an empty set (never throws) for a malformed persisted record", () => {
    const missing = "meridian.review.v1:deadbeef:prMissing"; // no `reviewed` key at all
    const invalid = "meridian.review.v1:deadbeef:prInvalid"; // `reviewed` is not an object
    vi.stubGlobal(
      "window",
      fakeWindow({
        [missing]: JSON.stringify({ files: [] }),
        [invalid]: JSON.stringify({ reviewed: "nope", files: [] }),
      }),
    );
    expect(() => loadReviewedIds(missing)).not.toThrow();
    expect(loadReviewedIds(missing)).toEqual(new Set());
    expect(loadReviewedIds(invalid)).toEqual(new Set());
  });
});
