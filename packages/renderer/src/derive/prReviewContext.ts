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

function toChangedFile(file: PrChangedFile): ChangedFile {
  const changed: ChangedFile = { path: file.path, status: toChangeStatus(file.status) };
  if (file.previousPath) {
    changed.previousPath = file.previousPath;
  }
  if (file.hunks && file.hunks.length > 0) {
    changed.hunks = file.hunks;
  }
  if (file.oldHunks && file.oldHunks.length > 0) {
    changed.oldHunks = file.oldHunks;
  }
  return changed;
}

export interface PrReviewContextArgs {
  prNumber: number;
  /** The PR's head branch (display only); null when unknown. */
  headRef: string | null;
  /** A stable per-repo string that scopes the persisted review ticks in localStorage (the PR-files
   * URL carries the artifact id, so distinct repos never share a scope). */
  scopeId: string;
  files: readonly PrChangedFile[];
}

/** Build the runtime review context for a GitHub PR. Pure. */
export function reviewContextFromPrFiles(args: PrReviewContextArgs): ReviewContext {
  return {
    changedFiles: args.files.map(toChangedFile),
    // A GitHub PR's base is its target branch; we don't fetch it, so the base fields stay null —
    // exactly as `meridian review --changed` leaves them. The panel simply omits the "vs base" line.
    baseRef: null,
    baseSha: null,
    headRef: args.headRef,
    reviewKey: `${args.scopeId}|pr-${args.prNumber}`,
    warnings: [],
  };
}
