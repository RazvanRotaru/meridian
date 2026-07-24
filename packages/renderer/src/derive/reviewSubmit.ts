/**
 * Turn the panel's draft comments into the ONE GitHub review submission. GitHub's public review API
 * supports RIGHT-side creation inside the unified diff's context-padded hunk ranges and LEFT-side
 * creation on exact deletion rows. Keep an explicit line inline when it is in that API-safe
 * context; otherwise preserve it as a real file-level review comment. Row-level comments still
 * derive a tight changed-line anchor.
 * Deleted/unparsed files and vanished/drifted units become file comments too, NEVER guessed
 * anchors. This keeps the whole draft set submittable without attaching prose to unrelated code.
 */

import { rangesOverlap, type ChangedDiffLine, type LineRange, type ReviewContext } from "@meridian/core";
import type { PrReviewCommentSide } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow, ReviewUnitRow } from "./reviewFiles";
import { normalizePath } from "./matchAffectedFiles";

export interface ReviewSubmission {
  comments: { path: string; line: number; side: PrReviewCommentSide; body: string }[];
  fileComments: { path: string; label: string | null; body: string }[];
}

export type ReviewCommentRanges = Readonly<Record<string, readonly LineRange[]>>;
export type ReviewDiffLines = Readonly<Record<string, readonly ChangedDiffLine[]>>;

export interface ReviewSubmissionOptions {
  /** File-level comments are revision-independent; use when no immutable reviewed SHA is known. */
  forceFileComments?: boolean;
  /** Exact canonical diff rows used to validate old-side line anchors without guessing. */
  diffLinesByFile?: ReviewDiffLines;
}

/** Build the submission payload. Pure; preserves draft order within each list. */
export function buildReviewSubmission(
  drafts: readonly ReviewComment[],
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges = EMPTY_COMMENT_RANGES,
  options: ReviewSubmissionOptions = {},
): ReviewSubmission {
  const submission: ReviewSubmission = { comments: [], fileComments: [] };
  for (const draft of drafts) {
    const path = resolveReviewPath(draft, files, context);
    const anchor = options.forceFileComments || path === null
      ? null
      : reviewAnchor(
        draft,
        path,
        files,
        context,
        commentRangesByFile,
        options.diffLinesByFile ?? EMPTY_DIFF_LINES,
      );
    if (anchor !== null) {
      submission.comments.push({ path: anchor.path, line: anchor.line, side: anchor.side, body: draft.body });
    } else {
      submission.fileComments.push({
        // Keep the exact draft path only when the current PR cannot resolve one safe canonical
        // identity. Retaining that location is safer than guessing a different file.
        path: path ?? draft.path,
        label: draft.line === null ? draft.anchorLabel : explicitLineLabel(draft),
        body: draft.body,
      });
    }
  }
  return submission;
}

interface ReviewAnchor {
  /** Canonical PR/context coordinate expected by the submission endpoint. */
  path: string;
  line: number;
  side: PrReviewCommentSide;
}

/** The canonical PR path + exact diff coordinate a draft anchors to; null ⇒ attach it to the file. */
function reviewAnchor(
  draft: ReviewComment,
  path: string,
  files: readonly ReviewFileRow[],
  context: ReviewContext,
  commentRangesByFile: ReviewCommentRanges,
  diffLinesByFile: ReviewDiffLines,
): ReviewAnchor | null {
  const explicitLine = draft.line;
  const explicitSide = explicitLine === null ? null : draft.side === "LEFT" ? "LEFT" : "RIGHT";
  if (explicitLine !== null && explicitSide === "LEFT") {
    if (draft.lineStale === true || explicitLine < 1) {
      return null;
    }
    const diffLines = linesForPath(diffLinesByFile, path, draft.path);
    return diffLines?.some((line) => line.kind === "deleted" && line.oldLine === explicitLine)
      ? { path, line: explicitLine, side: "LEFT" }
      : null;
  }
  const hunks = anchorableHunks(path, context);
  if (hunks.length === 0) {
    return null;
  }
  const unit = draft.nodeId === null ? undefined : unitOf(draft.nodeId, files, path);
  // A base-only unit comment has no exact selected deletion row. Even a coincidentally matching
  // number must not turn that semantic/file draft into a line comment on unrelated code.
  if (unit?.sourceSide === "base") {
    return null;
  }
  if (explicitLine !== null) {
    if (draft.lineStale === true) {
      return null;
    }
    // `hunks` is intentionally tight (actual edit lines) for graph marking; `commentRangesByFile`
    // comes from the patch headers and includes GitHub's surrounding context rows. Artifact-only
    // reviews have no header map, so their tight hunks remain the conservative fallback.
    const ranges = rangesForPath(commentRangesByFile, draft.path, path) ?? hunks;
    return explicitLine >= 1 && ranges.some((range) => explicitLine >= range.start && explicitLine <= range.end)
      ? { path, line: explicitLine, side: "RIGHT" }
      : null;
  }
  if (draft.nodeId === null) {
    return { path, line: hunks[0].start, side: "RIGHT" };
  }
  const overlap = unit && hunks.find((hunk) => rangesOverlap(unit.startLine, unit.endLine, hunk));
  // A vanished unit — or one that drifted off every hunk after a push — becomes a file comment;
  // never guess a line.
  return overlap ? { path, line: Math.max(overlap.start, unit.startLine), side: "RIGHT" } : null;
}

function explicitLineLabel(draft: ReviewComment): string {
  return [
    `L${draft.line}`,
    draft.side === "LEFT" ? "base" : null,
    draft.lineStale === true ? "previous revision" : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** Resolve a graph-relative draft path to the changed file's canonical PR path. LEFT/pre-image
 * anchors prefer an explicit rename owner; other drafts prefer current paths. Suffix aliases remain
 * unambiguous-only so duplicate monorepo tails never become guessed targets. */
function resolveReviewPath(
  draft: Pick<ReviewComment, "path" | "nodeId" | "line" | "side">,
  files: readonly ReviewFileRow[],
  context: ReviewContext,
): string | null {
  const changedByNormalized = new Map(context.changedFiles.map((file) => [normalizePath(file.path), file.path]));
  const visiblePaths = files
    .map((file) => changedByNormalized.get(normalizePath(file.path)))
    .filter((path): path is string => path !== undefined);
  const candidates = visiblePaths.length > 0 ? [...new Set(visiblePaths)] : context.changedFiles.map((file) => file.path);
  const candidateSet = new Set(candidates);
  if (draft.nodeId !== null) {
    const owningPaths = new Set(
      files
        .filter((file) => file.units.some((unit) => unit.nodeId === draft.nodeId))
        .map((file) => changedByNormalized.get(normalizePath(file.path)))
        .filter((path): path is string => path !== undefined),
    );
    if (owningPaths.size === 1) return [...owningPaths][0]!;
  }
  // A LEFT coordinate names the pre-image. Prefer an explicit rename's previous path before current
  // paths so `old.ts → new.ts` plus a newly-added `old.ts` cannot retarget the deletion to the new
  // file. Base-only semantic unit drafts get the same preference when their unit has vanished.
  if (
    (draft.line !== null && draft.side === "LEFT")
    || (draft.line === null && draft.nodeId !== null)
  ) {
    const previousPath = resolvePreviousReviewPath(draft.path, context, candidateSet);
    if (previousPath !== null) return previousPath;
  }
  return uniquePathAlias(draft.path, candidates);
}

function resolvePreviousReviewPath(
  draftPath: string,
  context: ReviewContext,
  candidates: ReadonlySet<string>,
): string | null {
  const aliases = context.changedFiles.flatMap((file) =>
    candidates.has(file.path) && file.previousPath
      ? [{ alias: file.previousPath, path: file.path }]
      : []);
  const matchedAlias = uniquePathAlias(draftPath, aliases.map((entry) => entry.alias));
  if (matchedAlias === null) return null;
  const paths = new Set(
    aliases
      .filter((entry) => normalizePath(entry.alias) === normalizePath(matchedAlias))
      .map((entry) => entry.path),
  );
  return paths.size === 1 ? [...paths][0]! : null;
}

function rangesForPath(
  rangesByFile: ReviewCommentRanges,
  draftPath: string,
  contextPath: string,
): readonly LineRange[] | undefined {
  const exactContext = rangesByFile[contextPath];
  if (exactContext !== undefined) {
    return exactContext;
  }
  const exactDraft = rangesByFile[draftPath];
  if (exactDraft !== undefined) {
    return exactDraft;
  }
  const key = uniquePathAlias(draftPath, Object.keys(rangesByFile))
    ?? uniquePathAlias(contextPath, Object.keys(rangesByFile));
  return key === null ? undefined : rangesByFile[key];
}

function linesForPath(
  linesByFile: ReviewDiffLines,
  contextPath: string,
  draftPath: string,
): readonly ChangedDiffLine[] | undefined {
  const exactContext = linesByFile[contextPath];
  if (exactContext !== undefined) {
    return exactContext;
  }
  const exactDraft = linesByFile[draftPath];
  if (exactDraft !== undefined) {
    return exactDraft;
  }
  const key = uniquePathAlias(draftPath, Object.keys(linesByFile))
    ?? uniquePathAlias(contextPath, Object.keys(linesByFile));
  return key === null ? undefined : linesByFile[key];
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
const EMPTY_DIFF_LINES: ReviewDiffLines = {};
