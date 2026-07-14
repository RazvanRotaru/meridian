/**
 * Running core's Tier-1+Tier-2 validation and turning a failure into the `validation` exit.
 *
 * `generate` fails closed (writes nothing on error); `mock` and `view` reject a graph they
 * cannot trust. We cap the printed issues so a structurally-broken file can't flood stderr.
 */

import { validateArtifact } from "@meridian/core";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "./errors";

const MAX_REPORTED_ISSUES = 20;

export interface Validated {
  artifact: GraphArtifact;
  warnings: string[];
}

export function validateOrThrow(candidate: unknown, label: string): Validated {
  const result = validateArtifact(candidate);
  if (!result.ok || !result.artifact) {
    throw new CliError(EXIT.validation, `${label} failed validation`, summarizeIssues(result.errors));
  }
  return { artifact: result.artifact, warnings: result.warnings.map((issue) => issue.message) };
}

/** Preserve first-seen warning order while collapsing the same diagnostic across validation passes. */
export function mergeWarnings(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}

function summarizeIssues(issues: Array<{ message: string }>): string[] {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => `  - ${issue.message}`);
  if (issues.length > MAX_REPORTED_ISSUES) {
    shown.push(`  … and ${issues.length - MAX_REPORTED_ISSUES} more`);
  }
  return shown;
}
