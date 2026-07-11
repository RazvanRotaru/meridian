/**
 * The shared dashed-wire vocabulary for the unified module canvas.
 *
 * `crossFrame` deliberately does NOT participate: it is a geometric/grouping signal that still
 * drives the existing import/coupling colour vocabulary. A dash has one semantic predicate across
 * plain wires and every aggregate renderer: the wire leaves this view or its original dependency
 * crosses a package-ownership boundary.
 */

import type { Edge } from "@xyflow/react";

export const BOUNDARY_DASH_PATTERN = "5 4";

export interface EdgeBoundaryData {
  crossPackage?: boolean;
  outsideView?: boolean;
}

/** Whether an RF edge-data payload carries either reason a wire must be dashed. */
export function isDashedBoundary(data: unknown): boolean {
  const boundary = data as EdgeBoundaryData | null | undefined;
  return boundary?.crossPackage === true || boundary?.outsideView === true;
}

/** Apply the canonical dash iff the semantic predicate holds, removing any stale/legacy dash. */
export function withBoundaryDash(style: Edge["style"], data: unknown): Edge["style"] {
  const { strokeDasharray: _legacyDash, ...solid } = style ?? {};
  return isDashedBoundary(data) ? { ...solid, strokeDasharray: BOUNDARY_DASH_PATTERN } : solid;
}
