import { describe, expect, it } from "vitest";
import {
  PR_PREPARE_MAX_CHANGED_PATH_BYTES,
  PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL,
  PR_PREPARE_MAX_WARNINGS,
  PR_PREPARE_MAX_WARNING_BYTES,
  PR_PREPARE_MAX_WARNING_BYTES_TOTAL,
  PR_PREPARE_STAGES,
  PR_PREPARE_V1_FIELDS,
  compareCanonicalPrPreparePaths,
  hasExactPrPrepareFields,
  isPrPrepareElapsedMs,
  isPrPrepareStage,
  normalizePrPrepareChangedFiles,
  normalizePrPrepareTimings,
  normalizePrPrepareWarnings,
} from "./pr-prepare-contract";

describe("PR preparation v1 contract", () => {
  it("recognizes exactly the five named stages and finite non-negative elapsed values", () => {
    expect(PR_PREPARE_STAGES).toEqual([
      "resolve",
      "git",
      "extract-head",
      "extract-merge-base",
      "publish",
    ]);
    expect(PR_PREPARE_STAGES.every(isPrPrepareStage)).toBe(true);
    expect(isPrPrepareStage("clone")).toBe(false);
    expect(isPrPrepareElapsedMs(0)).toBe(true);
    expect(isPrPrepareElapsedMs(1.25)).toBe(true);
    expect(isPrPrepareElapsedMs(-1)).toBe(false);
    expect(isPrPrepareElapsedMs(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("normalizes only partial timing records keyed by those stages", () => {
    expect(normalizePrPrepareTimings({ resolve: 1, "extract-head": 2 })).toEqual({
      resolve: 1,
      "extract-head": 2,
    });
    expect(normalizePrPrepareTimings({ totalMs: 3 })).toBeNull();
    expect(normalizePrPrepareTimings({ git: -1 })).toBeNull();
    expect(normalizePrPrepareTimings({ git: Number.NaN })).toBeNull();
  });

  it("applies one warning contract by count, per-entry bytes, and aggregate bytes", () => {
    expect(normalizePrPrepareWarnings(["warning"])).toEqual(["warning"]);
    expect(normalizePrPrepareWarnings(
      Array.from({ length: PR_PREPARE_MAX_WARNINGS + 1 }, () => "warning"),
    )).toBeNull();
    expect(normalizePrPrepareWarnings(["x".repeat(PR_PREPARE_MAX_WARNING_BYTES + 1)])).toBeNull();
    expect(normalizePrPrepareWarnings(Array.from(
      { length: Math.ceil(PR_PREPARE_MAX_WARNING_BYTES_TOTAL / PR_PREPARE_MAX_WARNING_BYTES) + 1 },
      () => "x".repeat(PR_PREPARE_MAX_WARNING_BYTES),
    ))).toBeNull();
  });

  it("normalizes exact changed-file records under shared UTF-8 and aggregate path bounds", () => {
    expect(normalizePrPrepareChangedFiles([
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      { path: "src/modified.ts", status: "modified" },
    ])).toEqual([
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      { path: "src/modified.ts", status: "modified" },
    ]);
    expect(normalizePrPrepareChangedFiles([
      { path: "src/a.ts", status: "modified", additions: 1 },
    ])).toBeNull();
    expect(normalizePrPrepareChangedFiles([
      { path: "é".repeat(Math.floor(PR_PREPARE_MAX_CHANGED_PATH_BYTES / 2) + 1), status: "modified" },
    ])).toBeNull();
    expect(normalizePrPrepareChangedFiles(Array.from(
      { length: Math.ceil(PR_PREPARE_MAX_CHANGED_PATH_BYTES_TOTAL / 4_000) + 1 },
      (_, index) => ({ path: `${index.toString(36)}/${"x".repeat(4_000)}`, status: "modified" }),
    ))).toBeNull();
  });

  it("defines one locale-independent UTF-8 path order", () => {
    expect(["src/😀.ts", "src/é.ts", "src/z.ts", "src/中.ts", "src/ä.ts"]
      .sort(compareCanonicalPrPreparePaths)).toEqual([
      "src/z.ts", "src/ä.ts", "src/é.ts", "src/中.ts", "src/😀.ts",
    ]);
  });

  it("rejects missing and unknown record fields", () => {
    const progress = { version: 1, type: "progress", stage: "resolve", elapsedMs: 1 };
    expect(hasExactPrPrepareFields(progress, PR_PREPARE_V1_FIELDS.progress)).toBe(true);
    expect(hasExactPrPrepareFields({ ...progress, legacyStage: "clone" }, PR_PREPARE_V1_FIELDS.progress))
      .toBe(false);
    const { elapsedMs: _elapsedMs, ...missingElapsed } = progress;
    expect(hasExactPrPrepareFields(missingElapsed, PR_PREPARE_V1_FIELDS.progress)).toBe(false);

    const descriptor = {
      graphId: "pr-head",
      manifestUrl: "/api/graph/manifest?id=pr-head",
      projectionUrl: "/api/graph/projection?id=pr-head",
      searchUrl: "/api/graph/search?id=pr-head",
      sourceUrl: "/api/source?id=pr-head",
      metaUrl: "/api/meta?id=pr-head",
      graphSummary: {},
    };
    expect(hasExactPrPrepareFields(descriptor, PR_PREPARE_V1_FIELDS.descriptor)).toBe(true);
    const { searchUrl: _searchUrl, ...missingSearch } = descriptor;
    expect(hasExactPrPrepareFields(missingSearch, PR_PREPARE_V1_FIELDS.descriptor)).toBe(false);
  });
});
