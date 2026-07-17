import { describe, expect, it } from "vitest";
import {
  resolveExtractionWorkerConcurrency,
  resolveGenerationConcurrency,
  resolvePrInspectionConcurrency,
} from "./inspection-capacity";

const base = {
  totalMemoryMb: 64 * 1024,
  availableMemoryMb: 64 * 1024,
  parentHeapMb: 8_192,
  workerHeapMb: 8_192,
};

describe("resolveExtractionWorkerConcurrency", () => {
  it("admits two workers once the bounded parent plus full worker reservations fit", () => {
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 20 * 1024 })).toBe(1);
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 21 * 1024 })).toBe(2);
  });

  it("requests four workers by default so two PR pairs can overlap when memory permits", () => {
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 30 * 1024 })).toBe(3);
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 39 * 1024 })).toBe(4);
    expect(resolveExtractionWorkerConcurrency(base)).toBe(4);
  });

  it("preserves one guaranteed worker slot when a second worker does not fit", () => {
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 16 * 1024 })).toBe(1);
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 512 })).toBe(1);
  });

  it("honors explicit concurrency and memory-budget overrides", () => {
    expect(resolveExtractionWorkerConcurrency({ ...base, requestedConcurrency: "1" })).toBe(1);
    expect(resolveExtractionWorkerConcurrency({
      ...base,
      availableMemoryMb: 4 * 1024,
      memoryBudgetMb: String(28 * 1024),
    })).toBe(2);
  });

  it("does not reserve an unused V8 ceiling after the parent becomes projection-bounded", () => {
    expect(resolveExtractionWorkerConcurrency({
      ...base,
      parentHeapMb: 12 * 1024,
      availableMemoryMb: 20 * 1024,
    })).toBe(1);
    expect(resolveExtractionWorkerConcurrency({
      ...base,
      parentHeapMb: 12 * 1024,
      availableMemoryMb: 21 * 1024,
    })).toBe(2);
  });

  it("falls back from invalid overrides and uses the tighter detected budget", () => {
    expect(resolveExtractionWorkerConcurrency({
      ...base,
      totalMemoryMb: 16 * 1024,
      availableMemoryMb: 64 * 1024,
      requestedConcurrency: "not-a-number",
      memoryBudgetMb: "invalid",
    })).toBe(1);
  });
});

describe("logical lifecycle capacity", () => {
  it("keeps two PR lifecycles admitted even when memory permits only one worker", () => {
    expect(resolvePrInspectionConcurrency()).toBe(2);
    expect(resolveExtractionWorkerConcurrency({ ...base, availableMemoryMb: 16 * 1024 })).toBe(1);
  });

  it("bounds generation independently and falls back cleanly from invalid configuration", () => {
    expect(resolveGenerationConcurrency()).toBe(4);
    expect(resolvePrInspectionConcurrency("3")).toBe(3);
    expect(resolveGenerationConcurrency("6")).toBe(6);
    expect(resolvePrInspectionConcurrency("invalid")).toBe(2);
    expect(resolveGenerationConcurrency(0)).toBe(4);
  });
});
