/**
 * Turn the panel's draft comments into the ONE GitHub review submission. The UI can draft on every
 * visible HEAD line, matching GitHub's current Files changed experience, but GitHub's public review
 * API only guarantees inline creation inside the unified diff's context-padded hunk ranges. Keep an
 * explicit line inline when it is in that API-safe context; otherwise preserve it as an L-prefixed
 * note in the review body instead of risking failure of the entire review. Row-level comments still
 * derive a tight changed-line anchor. Deleted/unparsed files and vanished/drifted units likewise
 * become notes, NEVER guessed anchors. Notes keep the subdir-STRIPPED path; the server restores the
 * repo-root prefix when it assembles the body (web-prs.ts).
 */

import { rangesOverlap, type LineRange, type ReviewContext } from "@meridian/core";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";

export interface ReviewSubmission {
  comments: { path: string; line: number; body: string }[];
  notes: { path: string; label: string | null; body: string }[];
}

export type ReviewCommentRanges = Readonly<Record<string, readonly LineRange[]>>;

/** Build the submission payload. Pure; preserves draft order within each list. */
export function buildReviewSubmission(
  drafts: readonly ReviewComment[],
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges = EMPTY_COMMENT_RANGES,
): ReviewSubmission {
  const submission: ReviewSubmission = { comments: [], notes: [] };
  for (const draft of drafts) {
    const line = anchorLine(draft, files, context, commentRangesByFile);
    if (line !== null) {
      submission.comments.push({ path: draft.path, line, body: draft.body });
    } else {
      submission.notes.push({ path: draft.path, label: draft.line === null ? draft.anchorLabel : `L${draft.line}`, body: draft.body });
    }
  }
  return submission;
}

/** The new-side diff line a draft anchors to; null ⇒ fold it into the body as a note. */
function anchorLine(
  draft: ReviewComment,
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges,
): number | null {
  const hunks = anchorableHunks(draft.path, context);
  if (hunks.length === 0) {
    return null;
  }
  const explicitLine = draft.line;
  if (explicitLine !== null) {
    if (draft.lineStale === true) {
      return null;
    }
    // `hunks` is intentionally tight (actual edit lines) for graph marking; `commentRangesByFile`
    // comes from the patch headers and includes GitHub's surrounding context rows. Artifact-only
    // reviews have no header map, so their tight hunks remain the conservative fallback.
    const ranges = commentRangesByFile[draft.path] ?? hunks;
    return explicitLine >= 1 && ranges.some((range) => explicitLine >= range.start && explicitLine <= range.end)
      ? explicitLine
      : null;
  }
  if (draft.nodeId === null) {
    return hunks[0].start;
  }
  const unit = unitOf(draft.nodeId, files, draft.path);
  const overlap = unit && hunks.find((hunk) => rangesOverlap(unit.startLine, unit.endLine, hunk));
  // A vanished unit — or one that drifted off every hunk after a push — folds; never guess a line.
  return overlap ? Math.max(overlap.start, unit.startLine) : null;
}

/** The file's hunks that can host a RIGHT-side comment: a pure-deletion hunk starts at 0 and names
 * no real new-side line, so it is not an anchor. */
export function anchorableHunks(path: string, context: ReviewContext): LineRange[] {
  const hunks = context.changedFiles.find((file) => file.path === path)?.hunks ?? [];
  return hunks.filter((hunk) => hunk.start >= 1);
}

function unitOf(nodeId: string, files: readonly ReviewFileRow[], path: string): ReviewUnitRow | undefined {
  return files.find((file) => file.path === path)?.units.find((unit) => unit.nodeId === nodeId);
}

const EMPTY_COMMENT_RANGES: ReviewCommentRanges = {};
