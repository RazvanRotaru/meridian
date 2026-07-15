import { describe, expect, it } from "vitest";
import { RecentViewProjectionCache } from "./recentViewProjectionCache";

interface Projection {
  label: string;
}

const projection = (label: string): Projection => ({ label });

describe("RecentViewProjectionCache", () => {
  it("pins the active projection outside both recent-view limits", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 0,
      maxRecentBytes: 0,
    });
    const active = projection("large current view");

    cache.setActive("current", active, 500_000_000);

    expect(cache.activeKey).toBe("current");
    expect(cache.active).toBe(active);
    expect(cache.get("current")).toBe(active);
    expect(cache.recentEntryCount).toBe(0);
    expect(cache.recentResidentByteLength).toBe(0);
  });

  it("moves the previous active projection into recent storage and swaps it back on activation", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 2,
      maxRecentBytes: 1_000,
    });
    const first = projection("first");
    const second = projection("second");

    cache.setActive("first", first, 120);
    cache.setActive("second", second, 180);

    expect(cache.active).toBe(second);
    expect(cache.get("first")).toBe(first);
    expect(cache.recentEntryCount).toBe(1);
    expect(cache.recentResidentByteLength).toBe(120);

    expect(cache.activate("first")).toBe(first);
    expect(cache.activeKey).toBe("first");
    expect(cache.get("second")).toBe(second);
    expect(cache.recentResidentByteLength).toBe(180);
  });

  it("evicts least-recently-used entries when the resident-byte budget is exceeded", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 10,
      maxRecentBytes: 300,
    });

    cache.setActive("a", projection("a"), 100);
    cache.setActive("b", projection("b"), 120);
    cache.setActive("c", projection("c"), 130);
    cache.setActive("d", projection("d"), 90);

    // Activating d offered c to recent storage: 100 + 120 + 130 exceeds 300, so a is oldest.
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.activeKey).toBe("d");
    expect(cache.recentResidentByteLength).toBe(250);
  });

  it("also enforces the independent recent-entry count", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 2,
      maxRecentBytes: 10_000,
    });

    cache.setActive("a", projection("a"), 10);
    cache.setActive("b", projection("b"), 20);
    cache.setActive("c", projection("c"), 30);
    cache.setActive("d", projection("d"), 40);

    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.activeKey).toBe("d");
    expect(cache.recentEntryCount).toBe(2);
    expect(cache.recentResidentByteLength).toBe(50);
  });

  it("promotes a recent get to MRU before the next eviction", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 2,
      maxRecentBytes: 10_000,
    });

    cache.setActive("a", projection("a"), 10);
    cache.setActive("b", projection("b"), 20);
    cache.setActive("c", projection("c"), 30);
    expect(cache.get("a")?.label).toBe("a");
    cache.setActive("d", projection("d"), 40);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("skips an oversized inactive projection but continues pinning it while active", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 3,
      maxRecentBytes: 100,
    });
    const oversized = projection("oversized");

    cache.setActive("oversized", oversized, 101);
    expect(cache.active).toBe(oversized);
    cache.setActive("next", projection("next"), 10);

    expect(cache.has("oversized")).toBe(false);
    expect(cache.activeKey).toBe("next");
    expect(cache.recentEntryCount).toBe(0);
    expect(cache.recentResidentByteLength).toBe(0);
  });

  it("uses caller-supplied conservative resident weights rather than decoded object shape", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 3,
      maxRecentBytes: 11,
    });
    // Both decoded values are tiny and identically shaped; the caller's heap weights differ.
    cache.setActive("multibyte", projection("x"), 8);
    cache.setActive("compressed-looking", projection("x"), 4);
    cache.setActive("current", projection("x"), 1);

    expect(cache.has("multibyte")).toBe(false);
    expect(cache.has("compressed-looking")).toBe(true);
    expect(cache.recentResidentByteLength).toBe(4);
  });

  it("replaces the same active key without retaining or double-charging the old decode", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 3,
      maxRecentBytes: 1_000,
    });
    const stale = projection("stale");
    const fresh = projection("fresh");

    cache.setActive("same", stale, 700);
    cache.setActive("same", fresh, 200);

    expect(cache.active).toBe(fresh);
    expect(cache.recentEntryCount).toBe(0);
    expect(cache.recentResidentByteLength).toBe(0);
  });

  it("clears active and recent projections with exact accounting reset", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 3,
      maxRecentBytes: 1_000,
    });
    cache.setActive("a", projection("a"), 100);
    cache.setActive("b", projection("b"), 200);

    cache.clear();

    expect(cache.active).toBeUndefined();
    expect(cache.activeKey).toBeUndefined();
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
    expect(cache.recentEntryCount).toBe(0);
    expect(cache.recentResidentByteLength).toBe(0);
  });

  it("rejects invalid limits and resident byte weights before corrupting accounting", () => {
    expect(() => new RecentViewProjectionCache({ maxRecentEntries: -1, maxRecentBytes: 1 })).toThrow(RangeError);
    expect(() => new RecentViewProjectionCache({ maxRecentEntries: 1, maxRecentBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError);

    const cache = new RecentViewProjectionCache<string, Projection>({ maxRecentEntries: 1, maxRecentBytes: 10 });
    expect(() => cache.setActive("bad", projection("bad"), 1.5)).toThrow(RangeError);
    expect(cache.active).toBeUndefined();
  });

  it("uses Map-compatible key equality for unusual generic keys", () => {
    const cache = new RecentViewProjectionCache<number, Projection>({ maxRecentEntries: 1, maxRecentBytes: 10 });
    const active = projection("nan");
    cache.setActive(Number.NaN, active, 1);

    expect(cache.has(Number.NaN)).toBe(true);
    expect(cache.get(Number.NaN)).toBe(active);
  });

  it("can evict an undefined generic key without confusing it for an empty LRU", () => {
    const cache = new RecentViewProjectionCache<string | undefined, Projection>({
      maxRecentEntries: 1,
      maxRecentBytes: 10,
    });
    cache.setActive(undefined, projection("undefined"), 1);
    cache.setActive("second", projection("second"), 1);
    cache.setActive("current", projection("current"), 1);

    expect(cache.has(undefined)).toBe(false);
    expect(cache.has("second")).toBe(true);
    expect(cache.activeKey).toBe("current");
  });
});
