/**
 * Bridge a selected GitHub PR into the PR-review deep-dive: turn the PR's changed files (as served
 * by the `web` GitHub proxy — path + status + optional patch hunks) into a core `ReviewContext`,
 * the same shape `meridian review` stamps into an artifact. The store then feeds it through
 * `deriveReviewDataFromContext` + the affected-code-block graph, so a GitHub PR and a local
 * `meridian review` render through one identical pipeline.
 */

import type { ChangedFile, ChangeStatus, ReviewContext } from "@meridian/core";
import type { PrChangedFile, PrFileStatus } from "../state/prTypes";

/** GitHub calls a deletion "removed"; core's ChangeStatus calls it "deleted". Every other value lines up. */
function toChangeStatus(status: PrFileStatus): ChangeStatus {
  return status === "removed" ? "deleted" : status;
}

function toChangedFile(file: PrChangedFile, baseSide: boolean): ChangedFile {
  const changed: ChangedFile = { path: file.path, status: toChangeStatus(file.status) };
  if (file.previousPath) {
    changed.previousPath = file.previousPath;
  }
  if (file.hunks && file.hunks.length > 0) {
    changed.hunks = file.hunks;
  }
  // Base-side hunks let computeAffectedNodes mark BASE-relative node ranges (a review overlaid on
  // the boot artifact). On a head-accurate graph they'd mis-mark head coordinates, so the caller
  // opts out and the new-side `hunks` above (head coordinates) carry the marking instead.
  if (baseSide && file.oldHunks && file.oldHunks.length > 0) {
    changed.oldHunks = file.oldHunks;
  }
  return changed;
}

export interface PrReviewContextArgs {
  prNumber: number;
  /** The PR's head branch (display only); null when unknown. */
  headRef: string | null;
  /** The PR's target branch (display only — the provenance line's base label); null when unknown. */
  baseRef: string | null;
  /** A stable per-repo string that scopes the persisted review ticks in localStorage (the PR-files
   * URL carries the artifact id, so distinct repos never share a scope). */
  scopeId: string;
  files: readonly PrChangedFile[];
}

/** Build the runtime review context for a GitHub PR. Pure. `baseSide` says which coordinate space
 * the loaded graph's node ranges live in: true (default) for the boot/base artifact, false for a
 * swapped-in head-accurate one (drops the base-side hunks — see toChangedFile). */
export function reviewContextFromPrFiles(args: PrReviewContextArgs, options: { baseSide: boolean } = { baseSide: true }): ReviewContext {
  return {
    changedFiles: args.files.map((file) => toChangedFile(file, options.baseSide)),
    baseRef: args.baseRef,
    // The base commit is never fetched, so it stays null — as `meridian review --changed` leaves it.
    baseSha: null,
    headRef: args.headRef,
    reviewKey: `${args.scopeId}|pr-${args.prNumber}`,
    warnings: [],
  };
}
