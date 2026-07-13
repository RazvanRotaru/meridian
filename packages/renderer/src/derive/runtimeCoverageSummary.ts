/** Repository-wide runtime coverage totals derived from the normalized execution extension. */

import { readTestExecutionCoverage, type GraphArtifact } from "@meridian/core";

export interface RuntimeCoverageMetric {
  /** Number of functions/branch paths whose runtime counter is greater than zero. */
  hit: number;
  total: number;
  /** Rounded whole-number percentage; absent when the report has no items of this kind. */
  percent: number | null;
}

export interface RuntimeCoverageSummary {
  functions: RuntimeCoverageMetric;
  branchPaths: RuntimeCoverageMetric;
}

const SUMMARY_CACHE = new WeakMap<GraphArtifact, RuntimeCoverageSummary | null>();

/**
 * Summarize the aggregate counters exactly as runtime coverage tools do: a function or branch
 * path is covered when its counter is positive. Invalid or absent extensions return null so the
 * renderer can fall back to its explicitly labelled static reachability estimate.
 */
export function runtimeCoverageSummary(artifact: GraphArtifact): RuntimeCoverageSummary | null {
  const cached = SUMMARY_CACHE.get(artifact);
  if (cached !== undefined || SUMMARY_CACHE.has(artifact)) {
    return cached ?? null;
  }

  const coverage = readTestExecutionCoverage(artifact);
  if (coverage === null) {
    SUMMARY_CACHE.set(artifact, null);
    return null;
  }

  let hitFunctions = 0;
  let totalFunctions = 0;
  let hitBranchPaths = 0;
  let totalBranchPaths = 0;
  for (const file of Object.values(coverage.files)) {
    for (const entry of file.functions) {
      totalFunctions += 1;
      if (entry.hits > 0) hitFunctions += 1;
    }
    for (const branch of file.branches) {
      for (const path of branch.paths) {
        totalBranchPaths += 1;
        if (path.hits > 0) hitBranchPaths += 1;
      }
    }
  }

  const summary = {
    functions: metric(hitFunctions, totalFunctions),
    branchPaths: metric(hitBranchPaths, totalBranchPaths),
  };
  SUMMARY_CACHE.set(artifact, summary);
  return summary;
}

function metric(hit: number, total: number): RuntimeCoverageMetric {
  return { hit, total, percent: total === 0 ? null : Math.round((hit / total) * 100) };
}
