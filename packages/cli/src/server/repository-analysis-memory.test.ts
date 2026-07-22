import { describe, expect, it } from "vitest";
import {
  repositoryAnalysisMemoryPolicy,
  repositoryAnalysisWorkerHeapArg,
  repositoryAnalysisWorkerHeapMb,
} from "./repository-analysis-memory";

const GIBIBYTE_BYTES = 1_024 ** 3;

describe("repository analysis worker heap", () => {
  it("uses the explicit worker heap before NODE_OPTIONS", () => {
    expect(repositoryAnalysisWorkerHeapMb({
      MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB: "4096",
      NODE_OPTIONS: "--max-old-space-size=16384",
    })).toBe(4_096);
  });

  it("uses the last valid old-space setting from NODE_OPTIONS", () => {
    expect(repositoryAnalysisWorkerHeapMb({
      NODE_OPTIONS: "--max_old_space_size 4096 --max-old-space-size=6144",
    })).toBe(6_144);
  });

  it("falls back to the default heap when NODE_OPTIONS has no valid worker setting", () => {
    expect(repositoryAnalysisWorkerHeapMb({
      NODE_OPTIONS: "--max-old-space-size=999999",
    })).toBe(8_192);
  });

  it("fails fast on invalid explicit heap configuration", () => {
    expect(() => repositoryAnalysisWorkerHeapMb({
      MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB: "4096junk",
    })).toThrow("MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB must be between 1024 and 131072 MiB");
    expect(() => repositoryAnalysisWorkerHeapMb({
      MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB: "512",
    })).toThrow("MERIDIAN_REPOSITORY_ANALYSIS_WORKER_HEAP_MB must be between 1024 and 131072 MiB");
  });

  it("builds a validated heap argument from an immutable reservation", () => {
    expect(repositoryAnalysisWorkerHeapArg(4_096)).toBe("--max-old-space-size=4096");
    expect(() => repositoryAnalysisWorkerHeapArg(512)).toThrow(
      "repository analysis worker heap must be between 1024 and 131072 MiB",
    );
  });
});

describe("repository analysis admission", () => {
  it("serializes workers on a 16 GiB host and preserves two-way analysis at 22 GiB", () => {
    expect(limitFor({ memory: memory(16) })).toBe(1);
    expect(limitFor({
      memory: { totalBytes: gibibytes(22) - 1, constrainedBytes: 0 },
    })).toBe(1);
    expect(limitFor({ memory: memory(22) })).toBe(2);
  });

  it("uses the lower process constraint without letting a larger constraint inflate capacity", () => {
    expect(limitFor({
      memory: { totalBytes: gibibytes(48), constrainedBytes: gibibytes(16) },
    })).toBe(1);
    expect(limitFor({
      memory: { totalBytes: gibibytes(16), constrainedBytes: gibibytes(48) },
    })).toBe(1);
  });

  it("treats unrecognized process constraints as absent", () => {
    expect(limitFor({
      memory: { totalBytes: gibibytes(48), constrainedBytes: 0 },
    })).toBe(2);
    expect(limitFor({
      memory: { totalBytes: gibibytes(48), constrainedBytes: -1 },
    })).toBe(2);
    expect(limitFor({
      memory: { totalBytes: gibibytes(48), constrainedBytes: Number.MAX_VALUE },
    })).toBe(2);
  });

  it("accounts for the configured worker heap", () => {
    expect(limitFor({
      memory: memory(12),
      workerHeapMb: 4_096,
    })).toBe(2);
    expect(limitFor({
      memory: memory(12),
      workerHeapMb: 8_192,
    })).toBe(1);
  });

  it("keeps one worker available below the calculated reservation", () => {
    expect(limitFor({ memory: memory(4) })).toBe(1);
    expect(limitFor({ memory: memory(256) })).toBe(2);
  });

  it("treats the internal override as a cap and validates policy inputs", () => {
    expect(limitFor({ maxConcurrentAnalyses: 1, memory: memory(48) })).toBe(1);
    expect(limitFor({ maxConcurrentAnalyses: 3, memory: memory(4) })).toBe(1);
    expect(() => repositoryAnalysisMemoryPolicy({ maxConcurrentAnalyses: 0 })).toThrow(
      "maxConcurrentAnalyses must be a positive integer",
    );
    expect(() => repositoryAnalysisMemoryPolicy({
      memory: { totalBytes: Number.NaN },
    })).toThrow("total memory must be a positive safe integer");
  });

  it("returns the worker reservation used to derive the limit", () => {
    expect(repositoryAnalysisMemoryPolicy({
      memory: memory(12),
      workerHeapMb: 4_096,
    })).toEqual({ maxConcurrentAnalyses: 2, workerHeapMb: 4_096 });
  });
});

function limitFor(
  options: Parameters<typeof repositoryAnalysisMemoryPolicy>[0],
): number {
  return repositoryAnalysisMemoryPolicy(options).maxConcurrentAnalyses;
}

function memory(gibibytesCount: number) {
  return { totalBytes: gibibytes(gibibytesCount), constrainedBytes: 0 };
}

function gibibytes(count: number): number {
  return count * GIBIBYTE_BYTES;
}
