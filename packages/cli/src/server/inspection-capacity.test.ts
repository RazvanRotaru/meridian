import { describe, expect, it } from "vitest";
import { resolveInspectionConcurrency } from "./inspection-capacity";

const base = {
  totalMemoryMb: 64 * 1024,
  availableMemoryMb: 64 * 1024,
  parentHeapMb: 8_192,
  workerHeapMb: 8_192,
};

describe("resolveInspectionConcurrency", () => {
  it("admits two workers once the bounded parent plus full worker reservations fit", () => {
    expect(resolveInspectionConcurrency({ ...base, availableMemoryMb: 20 * 1024 })).toBe(1);
    expect(resolveInspectionConcurrency({ ...base, availableMemoryMb: 21 * 1024 })).toBe(2);
  });

  it("preserves one compatibility slot when a second worker does not fit", () => {
    expect(resolveInspectionConcurrency({ ...base, availableMemoryMb: 16 * 1024 })).toBe(1);
    expect(resolveInspectionConcurrency({ ...base, availableMemoryMb: 512 })).toBe(1);
  });

  it("honors explicit concurrency and memory-budget overrides", () => {
    expect(resolveInspectionConcurrency({ ...base, requestedConcurrency: "1" })).toBe(1);
    expect(resolveInspectionConcurrency({
      ...base,
      availableMemoryMb: 4 * 1024,
      memoryBudgetMb: String(28 * 1024),
    })).toBe(2);
  });

  it("does not reserve an unused V8 ceiling after the parent becomes projection-bounded", () => {
    expect(resolveInspectionConcurrency({
      ...base,
      parentHeapMb: 12 * 1024,
      availableMemoryMb: 20 * 1024,
    })).toBe(1);
    expect(resolveInspectionConcurrency({
      ...base,
      parentHeapMb: 12 * 1024,
      availableMemoryMb: 21 * 1024,
    })).toBe(2);
  });

  it("falls back from invalid overrides and uses the tighter detected budget", () => {
    expect(resolveInspectionConcurrency({
      ...base,
      totalMemoryMb: 16 * 1024,
      availableMemoryMb: 64 * 1024,
      requestedConcurrency: "not-a-number",
      memoryBudgetMb: "invalid",
    })).toBe(1);
  });
});
