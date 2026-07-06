/**
 * Coverage-mode palette. One hue per verdict, used consistently across node accents, badges,
 * the MiniMap, and the legend, so the coverage story reads at any zoom level: green = a test
 * calls it, amber = tests reach it only through other code, red = nothing reaches it,
 * violet = it IS test code.
 */

import type { CoverageReport } from "@meridian/core";

export const COVERAGE_COLORS = {
  covered: "#3FB950",
  indirect: "#D29922",
  uncovered: "#F85149",
  test: "#A371F7",
  none: "#6E7681",
} as const;

export type CoverageVerdict = keyof typeof COVERAGE_COLORS;

/** The verdict a node renders under coverage mode; containers borrow their roll-up status. */
export function coverageVerdict(nodeId: string, report: CoverageReport): CoverageVerdict {
  if (report.testIds.has(nodeId)) {
    return "test";
  }
  const leaf = report.leaves[nodeId];
  if (leaf) {
    return leaf.status;
  }
  const container = report.containers[nodeId];
  if (!container || container.status === "no-callables") {
    return "none";
  }
  return container.status === "partial" ? "indirect" : container.status;
}

export function coverageAccent(nodeId: string, report: CoverageReport): string {
  return COVERAGE_COLORS[coverageVerdict(nodeId, report)];
}

export function coverageBadgeText(nodeId: string, report: CoverageReport): string | null {
  if (report.testIds.has(nodeId)) {
    return "TEST";
  }
  const container = report.containers[nodeId];
  if (container) {
    return container.status === "no-callables" ? null : `${container.percent}%`;
  }
  const leaf = report.leaves[nodeId];
  if (!leaf) {
    return null;
  }
  return leaf.status === "covered" ? "✓ tested" : leaf.status === "indirect" ? "◑ reached" : "✗ untested";
}
