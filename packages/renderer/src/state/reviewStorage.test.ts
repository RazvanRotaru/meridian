/**
 * Reviewed-flow persistence: the FNV-1a digest (known vectors), the composite key shape, a JSON
 * round-trip, graceful behavior when localStorage is unavailable, and LRU eviction past the cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fnv1a32hex, loadReviewed, reviewKey, saveReviewed } from "./reviewStorage";

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe("fnv1a32hex", () => {
  it("matches the standard 32-bit FNV-1a vectors as 8 hex chars", () => {
    expect(fnv1a32hex("")).toBe("811c9dc5");
    expect(fnv1a32hex("a")).toBe("e40c292c");
    expect(fnv1a32hex("foobar")).toBe("bf9cf968");
  });

  it("is deterministic and distinguishes different inputs", () => {
    expect(fnv1a32hex("meridian")).toBe(fnv1a32hex("meridian"));
    expect(fnv1a32hex("a")).not.toBe(fnv1a32hex("b"));
  });
});

describe("reviewKey", () => {
  it("hashes the target identity but keeps the scope readable", () => {
    expect(reviewKey("owner/repo@main", "pr42")).toBe(`meridian.review.v1:${fnv1a32hex("owner/repo@main")}:pr42`);
  });
});

describe("loadReviewed / saveReviewed", () => {
  it("round-trips a record through storage", () => {
    stubStorage();
    const key = reviewKey("target", "pr1");
    const record = { reviewed: { "flow:a": "2026-07-07T00:00:00.000Z" }, files: ["src/a.ts"], updatedAt: "2026-07-07T00:00:00.000Z" };
    saveReviewed(key, record);
    expect(loadReviewed(key)).toEqual(record);
  });

  it("returns null for a missing key and never throws when storage is unavailable", () => {
    stubStorage();
    expect(loadReviewed(reviewKey("target", "absent"))).toBeNull();
    vi.stubGlobal("window", undefined);
    expect(loadReviewed("anything")).toBeNull();
    expect(() => saveReviewed("anything", { reviewed: {}, files: [] })).not.toThrow();
  });

  it("evicts the oldest sessions once the cap is exceeded", () => {
    const store = stubStorage();
    const keys = Array.from({ length: 22 }, (_, index) => reviewKey("target", `pr${index}`));
    keys.forEach((key) => saveReviewed(key, { reviewed: {}, files: [] }));
    expect(loadReviewed(keys[0])).toBeNull();
    expect(loadReviewed(keys[1])).toBeNull();
    expect(loadReviewed(keys[21])).not.toBeNull();
    expect([...store.keys()].filter((key) => key.startsWith("meridian.review.v1:"))).toHaveLength(20);
  });
});
