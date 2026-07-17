/** Complete-revision diagnostic rows are already shaped by core before graph projection. */

import type { ReachabilityCoverageRow, ReachabilityProjectionFacts } from "@meridian/core";

export type CoverageRow = ReachabilityCoverageRow;

export function coverageRows(
  report: Pick<ReachabilityProjectionFacts, "worstRows">,
): readonly CoverageRow[] {
  return report.worstRows;
}
