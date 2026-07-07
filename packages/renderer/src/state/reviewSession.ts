/**
 * The store's bridge to `reviewStorage`: turn the artifact header + review scope into a stable
 * storage key, and load/persist which flow roots are ticked off. Split out of the store so the key
 * derivation (target identity, PR-vs-file-hash scope) stays small and unit-testable. The key is
 * deliberately commit-INDEPENDENT — a reviewer's ticks survive a rebase/force-push of the same PR.
 */

import type { Target } from "@meridian/core";
import { normalizePath } from "../derive/matchAffectedFiles";
import { fnv1a32hex, loadReviewed, reviewKey, saveReviewed } from "./reviewStorage";

/** A stable identity for the artifact's target — repo/name/version/root, NEVER the commit sha. */
export function artifactTargetIdentity(target: Target): string {
  return [target.vcs?.repository ?? "", target.name, target.version ?? "", target.root].join("|");
}

/** The review scope: an explicit PR ref when the PR flow supplied one, else a hash of the file set. */
export function reviewScopeRefFor(explicitScopeRef: string | null, affectedFiles: string[]): string {
  if (explicitScopeRef) {
    return explicitScopeRef;
  }
  const normalized = [...new Set(affectedFiles.map(normalizePath))].sort().join("\n");
  return fnv1a32hex(normalized);
}

/** The localStorage key for the current (artifact target, review scope) pair. */
export function reviewSessionKey(target: Target, explicitScopeRef: string | null, affectedFiles: string[]): string {
  return reviewKey(artifactTargetIdentity(target), reviewScopeRefFor(explicitScopeRef, affectedFiles));
}

/** Load the persisted ticks for a key as a Set of flow-root ids (empty when none/unavailable/malformed). */
export function loadReviewedIds(key: string): Set<string> {
  const reviewed = loadReviewed(key)?.reviewed;
  return new Set(isPlainRecord(reviewed) ? Object.keys(reviewed) : []);
}

/** A persisted `reviewed` map is only usable when it's a non-null, non-array object we can key over. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Persist the ticked flow roots, preserving each flow's original review date where we already had it. */
export function persistReviewedIds(key: string, reviewedFlowIds: ReadonlySet<string>, files: string[]): void {
  const previous = loadReviewed(key)?.reviewed ?? {};
  const now = new Date().toISOString();
  const reviewed: Record<string, string> = {};
  for (const id of reviewedFlowIds) {
    reviewed[id] = previous[id] ?? now;
  }
  saveReviewed(key, { reviewed, files, updatedAt: now });
}
