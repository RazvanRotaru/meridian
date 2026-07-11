/**
 * Turn the panel's draft comments into the ONE GitHub review submission: inline comments anchored
 * to new-side diff lines, plus anchorless NOTES the server folds into the review body. GitHub only
 * accepts an inline comment on a line the diff actually shows, so each anchor is derived from the
 * same parsed hunks the review graph was built from (core's rangesOverlap) — a unit comment lands
 * on the first changed line inside the unit's span, a file comment on the file's first changed
 * line. Anything without a real diff line to stand on — a deleted file (its new-side hunk starts
 * at 0), an unparsed patch, a unit that vanished or drifted off every hunk after a push — becomes
 * a note, NEVER a guessed anchor: a misplaced inline comment on an unrelated line is worse than a
 * body paragraph. Notes keep the subdir-STRIPPED path; the server restores the repo-root prefix
 * when it assembles the body (web-prs.ts), which is why the body is not built as prose here.
 */

import { rangesOverlap, type LineRange, type ReviewContext } from "@meridian/core";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";

export interface ReviewSubmission {
  comments: { path: string; line: number; body: string }[];
  notes: { path: string; label: string | null; body: string }[];
}

/** Build the submission payload. Pure; preserves draft order within each list. */
export function buildReviewSubmission(
  drafts: readonly ReviewComment[],
  files: readonly ReviewFileRow[],
  context: ReviewContext,
): ReviewSubmission {
  const submission: ReviewSubmission = { comments: [], notes: [] };
  for (const draft of drafts) {
    const line = anchorLine(draft, files, context);
    if (line !== null) {
      submission.comments.push({ path: draft.path, line, body: draft.body });
    } else {
      submission.notes.push({ path: draft.path, label: draft.anchorLabel, body: draft.body });
    }
  }
  return submission;
}

/** The new-side diff line a draft anchors to; null ⇒ fold it into the body as a note. */
function anchorLine(draft: ReviewComment, files: readonly ReviewFileRow[], context: ReviewContext): number | null {
  const hunks = anchorableHunks(draft.path, context);
  if (hunks.length === 0) {
    return null;
  }
  const explicitLine = draft.line;
  if (explicitLine !== null && hunks.some((hunk) => explicitLine >= hunk.start && explicitLine <= hunk.end)) {
    return explicitLine;
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
