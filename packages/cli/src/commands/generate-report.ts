/**
 * The post-`generate` summary, in both encodings.
 *
 * The human lines (stderr) read like a receipt a non-technical user can scan; the `--json`
 * payload (stdout) is the same facts machine-shaped. Issue #6's "N/M nodes carry a one-line
 * summary" coverage is surfaced here because drill-down readability depends on it.
 */

import type { ExtractionResult, GraphArtifact, LanguageExtractor } from "@meridian/core";
import type { Reporter } from "../reporter";

const MAX_HUMAN_WARNINGS = 20;

export interface ReportInputs {
  extractors: LanguageExtractor[];
  depth: string;
  artifact: GraphArtifact;
  extraction: ExtractionResult;
  warnings: string[];
  outPath: string;
}

export function reportGenerate(reporter: Reporter, inputs: ReportInputs): void {
  for (const line of humanLines(inputs)) {
    reporter.info(line);
  }
  reporter.payload(jsonSummary(inputs));
}

function humanLines(inputs: ReportInputs): string[] {
  const stats = inputs.extraction.stats;
  const coverage = stats.summaryCoverage;
  return [
    `extractors  ${inputs.extractors.map((extractor) => extractor.displayName).join(" + ")} (depth=${inputs.depth})`,
    `files       ${stats.files}`,
    `nodes       ${inputs.artifact.nodes.length}  [${formatCounts(nodeKindCounts(inputs.artifact))}]`,
    `edges       ${inputs.artifact.edges.length}  [${formatCounts(edgeResolutionCounts(inputs.artifact))}]`,
    `summaries   ${coverage.withSummary}/${coverage.total} nodes carry a one-line summary`,
    `validated   ok (${inputs.warnings.length} warning${inputs.warnings.length === 1 ? "" : "s"})`,
    ...humanWarningLines(inputs.warnings),
    `wrote       ${inputs.outPath}`,
  ];
}

function humanWarningLines(warnings: readonly string[]): string[] {
  const lines = warnings.slice(0, MAX_HUMAN_WARNINGS).map((warning) => `warning     ${warning}`);
  if (warnings.length > MAX_HUMAN_WARNINGS) {
    lines.push(`warning     … and ${warnings.length - MAX_HUMAN_WARNINGS} more`);
  }
  return lines;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, count]) => `${key}:${count}`)
    .join(" ");
}

// Tally from the final artifact (not extraction stats) so boundary nodes/edges are counted.
function nodeKindCounts(artifact: GraphArtifact): Record<string, number> {
  return tally(artifact.nodes.map((node) => node.kind));
}

function edgeResolutionCounts(artifact: GraphArtifact): Record<string, number> {
  return tally(artifact.edges.map((edge) => edge.resolution ?? "resolved"));
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function jsonSummary(inputs: ReportInputs): Record<string, unknown> {
  const stats = inputs.extraction.stats;
  return {
    out: inputs.outPath,
    extractor: inputs.extraction.language,
    extractors: inputs.extractors.map((extractor) => extractor.language),
    depth: inputs.depth,
    files: stats.files,
    nodeCount: inputs.artifact.nodes.length,
    edgeCount: inputs.artifact.edges.length,
    nodeCountByKind: nodeKindCounts(inputs.artifact),
    edgeCountByResolution: edgeResolutionCounts(inputs.artifact),
    summaryCoverage: stats.summaryCoverage,
    validated: true,
    warnings: inputs.warnings,
  };
}
