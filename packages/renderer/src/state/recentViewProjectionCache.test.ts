import { describe, expect, it } from "vitest";
import {
  RecentAllocationBudget,
  RecentViewProjectionCache,
} from "./recentViewProjectionCache";

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

  it("atomically replaces composite constituents while retaining unrelated navigation entries", () => {
    const cache = new RecentViewProjectionCache<string, Projection>({
      maxRecentEntries: 4,
      maxRecentBytes: 1_000,
    });
    const composite = projection("head + merge base");

    cache.setActive("unrelated", projection("unrelated"), 30);
    cache.setActive("head", projection("head"), 100);
    cache.setActive("merge-base", projection("merge base"), 200);
    cache.setActiveReplacing("review", composite, 300, ["head", "merge-base"]);

    expect(cache.activeKey).toBe("review");
    expect(cache.active).toBe(composite);
    expect(cache.has("head")).toBe(false);
    expect(cache.has("merge-base")).toBe(false);
    expect(cache.has("unrelated")).toBe(true);
    expect(cache.recentEntryCount).toBe(1);
    expect(cache.recentResidentByteLength).toBe(30);
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

  it("discards selected inactive projections without touching the active view or other allocations", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 4, maxRecentBytes: 1_000 });
    const cache = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 4, maxRecentBytes: 1_000 },
      budget,
    );
    const retained = projection("retained single");
    const discardedFirst = projection("discarded review one");
    const discardedSecond = projection("discarded review two");
    const active = projection("active review");
    cache.setActive("single", retained, 100);
    cache.setActive("review:one", discardedFirst, 200);
    cache.setActive("review:two", discardedSecond, 300);
    cache.setActive("review:active", active, 400);

    cache.discardRecentWhere((key) => key.startsWith("review:"));

    expect(cache.activeKey).toBe("review:active");
    expect(cache.active).toBe(active);
    expect(cache.has("single")).toBe(true);
    expect(cache.has("review:one")).toBe(false);
    expect(cache.has("review:two")).toBe(false);
    expect(cache.recentEntryCount).toBe(1);
    expect(cache.recentResidentByteLength).toBe(100);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(100);
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

  it("shares one exact global LRU across independent inactive caches", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 2, maxRecentBytes: 1_000 });
    const first = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 10, maxRecentBytes: 10_000 },
      budget,
    );
    const second = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 10, maxRecentBytes: 10_000 },
      budget,
    );

    first.setActive("a1", projection("a1"), 100);
    first.setActive("a2", projection("a2"), 200);
    second.setActive("b1", projection("b1"), 300);
    second.setActive("b2", projection("b2"), 400);

    expect(budget.inactiveEntryCount).toBe(2);
    expect(budget.inactiveResidentByteLength).toBe(400);
    expect(first.get("a1")?.label).toBe("a1"); // a1 is now globally MRU.
    first.setActive("a3", projection("a3"), 500);

    // Adding inactive a2 evicts globally-oldest b1, including its owning cache's accounting.
    expect(second.has("b1")).toBe(false);
    expect(second.recentEntryCount).toBe(0);
    expect(first.has("a1")).toBe(true);
    expect(first.has("a2")).toBe(true);
    expect(first.recentResidentByteLength).toBe(300);
    expect(budget.inactiveEntryCount).toBe(2);
    expect(budget.inactiveResidentByteLength).toBe(300);
  });

  it("enforces the shared resident-byte limit independently of its entry limit", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 10, maxRecentBytes: 250 });
    const first = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 10, maxRecentBytes: 10_000 },
      budget,
    );
    const second = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 10, maxRecentBytes: 10_000 },
      budget,
    );
    first.setActive("a1", projection("a1"), 100);
    first.setActive("a2", projection("a2"), 1);
    second.setActive("b1", projection("b1"), 160);
    second.setActive("b2", projection("b2"), 1);

    expect(first.has("a1")).toBe(false);
    expect(second.has("b1")).toBe(true);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(160);
  });

  it("uncharges a globally shared entry while active and recharges it on deactivation", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000 });
    const cache = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 3, maxRecentBytes: 1_000 },
      budget,
    );
    cache.setActive("first", projection("first"), 120);
    cache.setActive("second", projection("second"), 180);

    expect(budget.inactiveResidentByteLength).toBe(120);
    expect(cache.activate("first")?.label).toBe("first");
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(180);

    cache.deactivateActive();
    expect(cache.active).toBeUndefined();
    expect(cache.recentEntryCount).toBe(2);
    expect(cache.recentResidentByteLength).toBe(300);
    expect(budget.inactiveEntryCount).toBe(2);
    expect(budget.inactiveResidentByteLength).toBe(300);
  });

  it("discards an unreachable active view on destructive activation hits and misses", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000 });
    const cache = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 3, maxRecentBytes: 1_000 },
      budget,
    );
    const first = projection("first");
    const second = projection("second");
    const unreachable = projection("unreachable");
    cache.setActive("first", first, 100);
    cache.setActive("second", second, 200);
    cache.setActive("unreachable", unreachable, 300);

    expect(cache.activateAndDiscardPrevious("second")).toBe(second);
    expect(cache.active).toBe(second);
    expect(cache.has("unreachable")).toBe(false);
    expect(cache.has("first")).toBe(true);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(100);

    expect(cache.activateAndDiscardPrevious("missing")).toBeUndefined();
    expect(cache.active).toBeUndefined();
    expect(cache.has("second")).toBe(false);
    expect(cache.has("first")).toBe(true);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(100);
  });

  it("never registers an oversized deactivated allocation in either inactive cache", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 100 });
    const cache = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 3, maxRecentBytes: 1_000 },
      budget,
    );
    cache.setActive("oversized", projection("oversized"), 101);

    cache.deactivateActive();

    expect(cache.active).toBeUndefined();
    expect(cache.has("oversized")).toBe(false);
    expect(cache.recentEntryCount).toBe(0);
    expect(cache.recentResidentByteLength).toBe(0);
    expect(budget.inactiveEntryCount).toBe(0);
    expect(budget.inactiveResidentByteLength).toBe(0);
  });

  it("releases only the clearing cache's allocations from a shared budget", () => {
    const budget = new RecentAllocationBudget({ maxRecentEntries: 3, maxRecentBytes: 1_000 });
    const first = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 3, maxRecentBytes: 1_000 },
      budget,
    );
    const second = new RecentViewProjectionCache<string, Projection>(
      { maxRecentEntries: 3, maxRecentBytes: 1_000 },
      budget,
    );
    first.setActive("a1", projection("a1"), 100);
    first.setActive("a2", projection("a2"), 200);
    second.setActive("b1", projection("b1"), 300);
    second.setActive("b2", projection("b2"), 400);

    first.clear();

    expect(first.recentResidentByteLength).toBe(0);
    expect(second.has("b1")).toBe(true);
    expect(budget.inactiveEntryCount).toBe(1);
    expect(budget.inactiveResidentByteLength).toBe(300);
  });

  it("rejects invalid global limits and weights before changing global accounting", () => {
    expect(() => new RecentAllocationBudget({ maxRecentEntries: -1, maxRecentBytes: 1 }))
      .toThrow(RangeError);
    const budget = new RecentAllocationBudget({ maxRecentEntries: 1, maxRecentBytes: 10 });

    expect(() => budget.register(1.5, () => undefined)).toThrow(RangeError);
    expect(budget.inactiveEntryCount).toBe(0);
    expect(budget.inactiveResidentByteLength).toBe(0);
  });
});
