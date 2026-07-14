/**
 * `coverage`: a terminal view of the same static coverage the renderer overlays — which
 * callables tests reach (directly or transitively), which they don't, and why. `--fail-under`
 * turns it into a CI gate: exit code 1 when the covered percentage falls below the threshold.
 */

import { computeCoverage } from "@meridian/core";
import type { CoverageReport, GraphArtifact, GraphNode } from "@meridian/core";
import { InvalidArgumentError } from "commander";
import { CliError, EXIT } from "../errors";
import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile } from "../json-io";
import { validateOrThrow } from "../validation";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";

export interface CoverageOptions extends GlobalOptions {
  failUnder?: number;
}

export function runCoverage(graph: string, options: CoverageOptions): void {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const graphPath = resolveAgainst(cwd, graph);
  const { artifact } = validateOrThrow(readJsonFile(graphPath), `graph ${graphPath}`);
  const report = computeCoverage(artifact.nodes, artifact.edges);
  print(reporter, artifact, report);
  reporter.payload({ summary: report.summary, uncovered: uncoveredIds(report) });
  enforceThreshold(report, options.failUnder);
}

export function parseFailUnder(value: string): number {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new InvalidArgumentError("--fail-under must be a number in 0..100");
  }
  return threshold;
}

function print(reporter: Reporter, artifact: GraphArtifact, report: CoverageReport): void {
  const { summary } = report;
  reporter.info(`coverage    ${artifact.target.name}: ${summary.percent}% of ${summary.callables} callables reached by tests`);
  reporter.info(`            ${summary.covered} direct, ${summary.indirect} transitive, ${summary.uncovered} uncovered (${summary.testNodes} test nodes)`);
  if (summary.testNodes === 0) {
    reporter.info("            no test code found in the graph");
  }
  if (summary.unresolvedFromTests > 0) {
    reporter.info(`            caveat: ${summary.unresolvedFromTests} unresolved call(s) leave test code; real coverage may be higher`);
  }
  printContainers(reporter, artifact, report);
}

/** One line per class/module that has callables, worst first, with its uncovered members. */
function printContainers(reporter: Reporter, artifact: GraphArtifact, report: CoverageReport): void {
  const nodesById = new Map(artifact.nodes.map((node) => [node.id, node]));
  const rows = Object.entries(report.containers)
    .filter(([id, coverage]) => coverage.status !== "no-callables" && hasDirectCallable(id, report, nodesById))
    .sort(([, a], [, b]) => a.percent - b.percent);
  for (const [id, coverage] of rows) {
    const name = nodesById.get(id)?.qualifiedName ?? id;
    reporter.info(`  ${String(coverage.percent).padStart(3)}%  ${name}  (${coverage.covered}/${coverage.total})`);
    printUncoveredMembers(reporter, id, report, nodesById);
  }
}

/** Report only the row where callables actually live; package roll-ups would repeat the same numbers. */
function hasDirectCallable(id: string, report: CoverageReport, nodesById: Map<string, GraphNode>): boolean {
  return Object.keys(report.leaves).some((leafId) => nodesById.get(leafId)?.parentId === id);
}

function printUncoveredMembers(
  reporter: Reporter,
  containerId: string,
  report: CoverageReport,
  nodesById: Map<string, GraphNode>,
): void {
  for (const [leafId, leaf] of Object.entries(report.leaves)) {
    if (leaf.status !== "uncovered" || nodesById.get(leafId)?.parentId !== containerId) {
      continue;
    }
    const name = nodesById.get(leafId)?.displayName ?? leafId;
    reporter.info(`         ✗ ${name} — ${reasonText(leaf.reason, nodesById)}`);
  }
}

function reasonText(
  reason: { kind: string; callers: string[] } | undefined,
  nodesById: Map<string, GraphNode>,
): string {
  if (!reason || reason.kind === "never-called") {
    return "never called in the graph (entry point or dead code)";
  }
  const names = reason.callers.map((id) => nodesById.get(id)?.qualifiedName ?? id).join(", ");
  return `only called by uncovered code: ${names}`;
}

function uncoveredIds(report: CoverageReport): string[] {
  return Object.entries(report.leaves)
    .filter(([, leaf]) => leaf.status === "uncovered")
    .map(([id]) => id);
}

function enforceThreshold(report: CoverageReport, failUnder: number | undefined): void {
  if (failUnder !== undefined && report.summary.percent < failUnder) {
    throw new CliError(EXIT.validation, `coverage ${report.summary.percent}% is below --fail-under ${failUnder}%`);
  }
}
