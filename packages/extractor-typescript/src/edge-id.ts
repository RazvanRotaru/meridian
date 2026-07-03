/**
 * The deterministic edge id — `${kind}@${source}|${target}` — exactly as Tier-2 validation
 * reconstructs it. Kept in one place so the producer and the depth-collapse re-aggregation
 * never drift.
 */

import type { EdgeKind } from "@meridian/core";

export function edgeId(kind: EdgeKind, source: string, target: string): string {
  return `${kind}@${source}|${target}`;
}

export function aggregationKey(kind: EdgeKind, source: string, target: string): string {
  return `${kind}|${source}|${target}`;
}
