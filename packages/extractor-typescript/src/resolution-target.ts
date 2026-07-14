/** One target-id policy shared by dependency edges and Logic-flow call steps. */

import { externalTargetId, unresolvedTargetId } from "@meridian/core";
import type { TargetResolution } from "./edge-resolve";

const TYPESCRIPT_BOUNDARY_ECOSYSTEM = "npm";

/** Map a checker verdict to its canonical graph target. External and unresolved ids live in npm's
 * dependency namespace; resolved targets retain the extractor's ordinary `ts:` node id. */
export function targetIdForResolution(resolution: TargetResolution): string | null {
  switch (resolution.resolution) {
    case "resolved":
      return resolution.resolvedTarget;
    case "external":
      return externalTargetId(
        TYPESCRIPT_BOUNDARY_ECOSYSTEM,
        resolution.externalModulePath ?? "unknown",
        resolution.externalQualname ?? undefined,
      );
    default:
      return unresolvedTargetId(TYPESCRIPT_BOUNDARY_ECOSYSTEM);
  }
}
