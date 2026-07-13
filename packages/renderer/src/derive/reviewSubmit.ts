/**
 * Turn the panel's draft comments into the ONE GitHub review submission. GitHub's public review API
 * only supports inline creation inside the unified diff's context-padded hunk ranges. Keep an
 * explicit line inline when it is in that API-safe context; otherwise report it as blocked instead
 * of silently changing a per-line draft into an aggregate review-body note. Row-level comments
 * still derive a tight changed-line anchor. Deleted/unparsed files and vanished/drifted units are
 * blocked too, NEVER guessed anchors. The caller rejects the whole submission when any draft is
 * blocked, so every successfully submitted draft remains an individual inline GitHub comment.
 */

import { rangesOverlap, type LineRange, type ReviewContext } from "@meridian/core";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";
import { normalizePath } from "./matchAffectedFiles";

export interface ReviewSubmission {
  comments: { path: string; line: number; body: string }[];
  blocked: ReviewComment[];
}

export type ReviewCommentRanges = Readonly<Record<string, readonly LineRange[]>>;

/** Build the submission payload. Pure; preserves draft order within each list. */
export function buildReviewSubmission(
  drafts: readonly ReviewComment[],
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges = EMPTY_COMMENT_RANGES,
): ReviewSubmission {
  const submission: ReviewSubmission = { comments: [], blocked: [] };
  for (const draft of drafts) {
    const anchor = reviewAnchor(draft, files, context, commentRangesByFile);
    if (anchor !== null) {
      submission.comments.push({ path: anchor.path, line: anchor.line, body: draft.body });
    } else {
      submission.blocked.push(draft);
    }
  }
  return submission;
}

interface ReviewAnchor {
  /** Canonical PR/context path expected by the submission endpoint. */
  path: string;
  line: number;
}

/** The canonical PR path + new-side diff line a draft anchors to; null ⇒ block submission. */
function reviewAnchor(
  draft: ReviewComment,
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges,
): ReviewAnchor | null {
  const path = resolveReviewPath(draft.path, files, context);
  if (path === null) {
    return null;
  }
  const hunks = anchorableHunks(path, context);
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
    const ranges = rangesForPath(commentRangesByFile, draft.path, path) ?? hunks;
    return explicitLine >= 1 && ranges.some((range) => explicitLine >= range.start && explicitLine <= range.end)
      ? { path, line: explicitLine }
      : null;
  }
  if (draft.nodeId === null) {
    return { path, line: hunks[0].start };
  }
  const unit = unitOf(draft.nodeId, files, path);
  const overlap = unit && hunks.find((hunk) => rangesOverlap(unit.startLine, unit.endLine, hunk));
  // A vanished unit — or one that drifted off every hunk after a push — blocks; never guess a line.
  return overlap ? { path, line: Math.max(overlap.start, unit.startLine) } : null;
}

/** Resolve a graph-relative draft path to the changed file's canonical PR path. Exact normalized
 * matches win; otherwise accept one unambiguous `/`-boundary suffix alias. This mirrors the graph's
 * PR-file matching contract without guessing when a monorepo contains duplicate suffixes. */
function resolveReviewPath(
  draftPath: string,
  files: readonly ReviewFileRow[],
  context: ReviewContext,
): string | null {
  const changedByNormalized = new Map(context.changedFiles.map((file) => [normalizePath(file.path), file.path]));
  const visiblePaths = files
    .map((file) => changedByNormalized.get(normalizePath(file.path)))
    .filter((path): path is string => path !== undefined);
  const candidates = visiblePaths.length > 0 ? [...new Set(visiblePaths)] : context.changedFiles.map((file) => file.path);
  return uniquePathAlias(draftPath, candidates);
}

function rangesForPath(
  rangesByFile: ReviewCommentRanges,
  draftPath: string,
  contextPath: string,
): readonly LineRange[] | undefined {
  const exactDraft = rangesByFile[draftPath];
  if (exactDraft !== undefined) {
    return exactDraft;
  }
  const exactContext = rangesByFile[contextPath];
  if (exactContext !== undefined) {
    return exactContext;
  }
  const key = uniquePathAlias(draftPath, Object.keys(rangesByFile))
    ?? uniquePathAlias(contextPath, Object.keys(rangesByFile));
  return key === null ? undefined : rangesByFile[key];
}

function uniquePathAlias(path: string, candidates: readonly string[]): string | null {
  const normalized = normalizePath(path);
  const exact = candidates.filter((candidate) => normalizePath(candidate) === normalized);
  if (exact.length === 1) {
    return exact[0];
  }
  let bestLength = 0;
  let winners: string[] = [];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizePath(candidate);
    const suffixLength = normalizedCandidate.endsWith(`/${normalized}`)
      ? normalized.length
      : normalized.endsWith(`/${normalizedCandidate}`) ? normalizedCandidate.length : 0;
    if (suffixLength > bestLength) {
      bestLength = suffixLength;
      winners = [candidate];
    } else if (suffixLength > 0 && suffixLength === bestLength) {
      winners.push(candidate);
    }
  }
  return winners.length === 1 ? winners[0] : null;
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
