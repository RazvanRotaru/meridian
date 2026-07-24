import type { ExtractionResult } from "@meridian/core";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  semanticExtractionDigest,
  semanticExtractionSnapshot,
  type SemanticExtractionSnapshot,
} from "./semantic-normalize";

export const DIFFERENTIAL_CATEGORIES = [
  "language",
  "nodes",
  "edges",
  "stats",
  "diagnostics",
  "flows",
  "ports",
] as const;

export type DifferentialCategory = (typeof DIFFERENTIAL_CATEGORIES)[number];

export interface DifferentialMismatch {
  category: DifferentialCategory;
  message: string;
  incrementalDigest: string;
  coldDigest: string;
}

export interface DifferentialReport {
  equal: boolean;
  incrementalDigest: string;
  coldDigest: string;
  mismatches: DifferentialMismatch[];
}

/**
 * The caller owns cache setup. `coldWithEmptyCache` must invoke the same
 * extraction pipeline with a new empty cache, never a separate legacy path.
 */
export interface DifferentialRunners {
  incremental(): Promise<ExtractionResult>;
  coldWithEmptyCache(): Promise<ExtractionResult>;
}

/** Run the two pipelines and compare every semantic extraction category. */
export async function runExtractionDifferential(runners: DifferentialRunners): Promise<DifferentialReport> {
  const incremental = await runners.incremental();
  const cold = await runners.coldWithEmptyCache();
  return compareExtractionResults(incremental, cold);
}

/** Pure comparison helper for tests that already own both extraction results. */
export function compareExtractionResults(
  incremental: ExtractionResult,
  cold: ExtractionResult,
): DifferentialReport {
  const incrementalSnapshot = semanticExtractionSnapshot(incremental);
  const coldSnapshot = semanticExtractionSnapshot(cold);
  const mismatches = DIFFERENTIAL_CATEGORIES.flatMap((category) => (
    mismatchFor(category, incrementalSnapshot, coldSnapshot)
  ));
  return {
    equal: mismatches.length === 0,
    incrementalDigest: semanticExtractionDigest(incremental),
    coldDigest: semanticExtractionDigest(cold),
    mismatches,
  };
}

/** Throw one compact, categorized error when the cold semantic oracle disagrees. */
export function assertExtractionDifferential(report: DifferentialReport): void {
  if (report.equal) return;
  const details = report.mismatches.map((mismatch) => `  - [${mismatch.category}] ${mismatch.message}`);
  throw new Error([
    "incremental extraction differs from the empty-cache cold oracle",
    ...details,
  ].join("\n"));
}

/** Run and assert in one call while still returning the successful digests to a benchmark. */
export async function requireExtractionDifferential(
  runners: DifferentialRunners,
): Promise<DifferentialReport> {
  const report = await runExtractionDifferential(runners);
  assertExtractionDifferential(report);
  return report;
}

function mismatchFor(
  category: DifferentialCategory,
  incremental: SemanticExtractionSnapshot,
  cold: SemanticExtractionSnapshot,
): DifferentialMismatch[] {
  const incrementalValue = incremental[category];
  const coldValue = cold[category];
  const incrementalJson = canonicalJson(incrementalValue);
  const coldJson = canonicalJson(coldValue);
  if (incrementalJson === coldJson) return [];

  const incrementalDigest = canonicalJsonSha256(incrementalValue);
  const coldDigest = canonicalJsonSha256(coldValue);
  return [{
    category,
    incrementalDigest,
    coldDigest,
    message: [
      `${category} differ`,
      `(incremental ${describeCategory(category, incremental)}, sha256=${incrementalDigest};`,
      `cold ${describeCategory(category, cold)}, sha256=${coldDigest})`,
    ].join(" "),
  }];
}

function describeCategory(
  category: DifferentialCategory,
  snapshot: SemanticExtractionSnapshot,
): string {
  switch (category) {
    case "language":
      return JSON.stringify(snapshot.language);
    case "nodes":
      return `${snapshot.nodes.length} node(s)`;
    case "edges":
      return `${snapshot.edges.length} edge(s)`;
    case "stats":
      return `${snapshot.stats.files} file(s)`;
    case "diagnostics":
      return `${snapshot.diagnostics.length} diagnostic(s)`;
    case "flows":
      return snapshot.flows === null
        ? "absent"
        : `${Object.keys(snapshot.flows).length} flow owner(s)`;
    case "ports":
      return snapshot.ports === null ? "absent" : `${snapshot.ports.length} port(s)`;
  }
}
