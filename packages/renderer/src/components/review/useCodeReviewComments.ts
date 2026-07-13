import { useMemo } from "react";
import type { LineRange } from "@meridian/core";
import { useBlueprint } from "../../state/StoreContext";
import type { PrGitHubComment } from "../../state/prTypes";
import type { ReviewComment } from "../../state/reviewTicksPref";

const NO_COMMENTS: readonly PrGitHubComment[] = [];
const NO_DRAFTS: readonly ReviewComment[] = [];
const NO_RANGES: readonly LineRange[] = [];
const NO_LINES: ReadonlySet<number> = new Set<number>();

/** GitHub review threads can only be created on rows present in the PR diff, including its context
 * rows. Intersect those API-safe ranges with the source slice currently on screen so the UI never
 * offers a line action that would later have to be flattened into a review summary. */
export function commentableReviewLines(
  ranges: readonly LineRange[],
  baseLine: number,
  code: string | null,
  enabled: boolean,
): ReadonlySet<number> {
  if (!enabled || code === null || ranges.length === 0) {
    return NO_LINES;
  }
  const endLine = baseLine + Math.max(code.split("\n").length - 1, 0);
  const lines = new Set<number>();
  for (const range of ranges) {
    const start = Math.max(baseLine, range.start);
    const end = Math.min(endLine, range.end);
    for (let line = start; line <= end; line += 1) {
      lines.add(line);
    }
  }
  return lines.size > 0 ? lines : NO_LINES;
}

/** Store-backed GitHub diff/context rows for one visible HEAD source slice. */
export function useGitHubCommentableReviewLines(
  path: string | null,
  baseLine: number,
  code: string | null,
): ReadonlySet<number> {
  const ranges = useBlueprint((state) => path === null ? NO_RANGES : (state.reviewCommentRangesByFile[path] ?? NO_RANGES));
  const enabled = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  return useMemo(
    () => commentableReviewLines(ranges, baseLine, code, enabled),
    [baseLine, code, enabled, ranges],
  );
}

/** Only RIGHT-side comments can be placed against the HEAD source rendered by canvas code views.
 * LEFT-side and no-current-line comments remain in the review panel so an old-side line is never
 * attached to unrelated current code merely because the two line numbers happen to match. */
export function isHeadSideReviewComment(
  comment: PrGitHubComment,
): comment is PrGitHubComment & { line: number; side: "RIGHT" } {
  return comment.side === "RIGHT" && comment.line !== null;
}

/** Select placeable comments for exactly the file slice a code widget renders. Source widgets use
 * absolute HEAD line numbers, so no base-to-head remapping belongs here. Order is kept as received
 * from GitHub, including multiple replies/comments on one line. */
export function codeReviewComments(
  comments: readonly PrGitHubComment[],
  paths: string | readonly string[] | null,
  baseLine: number,
  code: string | null,
  visible: boolean,
): readonly PrGitHubComment[] {
  if (!visible || paths === null || code === null) {
    return NO_COMMENTS;
  }
  const endLine = baseLine + Math.max(code.split("\n").length - 1, 0);
  const matchesPath = typeof paths === "string"
    ? (comment: PrGitHubComment) => comment.path === paths
    : (comment: PrGitHubComment) => paths.includes(comment.path);
  return comments.filter(
    (comment) => matchesPath(comment)
      && isHeadSideReviewComment(comment)
      && comment.line >= baseLine
      && comment.line <= endLine,
  );
}

/** Select fresh explicit line drafts for the same HEAD source slice. File/unit drafts remain in the
 * review rail, and stale line anchors stay there too: after a new PR revision, reusing their old
 * line number could attach the body to unrelated code. Local drafts are intentionally independent
 * of the existing-comments visibility toggle so adding one always produces immediate feedback. */
export function codeReviewDrafts(
  drafts: readonly ReviewComment[],
  paths: string | readonly string[] | null,
  baseLine: number,
  code: string | null,
  active: boolean,
): readonly ReviewComment[] {
  if (!active || paths === null || code === null) {
    return NO_DRAFTS;
  }
  const endLine = baseLine + Math.max(code.split("\n").length - 1, 0);
  const matchesPath = typeof paths === "string"
    ? (draft: ReviewComment) => draft.path === paths
    : (draft: ReviewComment) => paths.includes(draft.path);
  return drafts.filter(
    (draft) => matchesPath(draft)
      && draft.line !== null
      && draft.lineStale !== true
      && draft.line >= baseLine
      && draft.line <= endLine,
  );
}

function useReviewCommentPaths(path: string | null): readonly string[] | null {
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const index = useBlueprint((state) => state.index);
  return useMemo(() => {
    if (path === null) return null;
    const aliases = new Set([path]);
    for (const file of reviewFiles) {
      if (file.moduleId !== null && index.nodesById.get(file.moduleId)?.location.file === path) {
        aliases.add(file.path);
      }
    }
    return [...aliases];
  }, [index, path, reviewFiles]);
}

/** Store-backed adapter shared by the hover, inline, modal, and edge source hosts. */
export function useCodeReviewComments(
  path: string | null,
  baseLine: number,
  code: string | null,
): readonly PrGitHubComment[] {
  const discussion = useBlueprint((state) => state.prDiscussion);
  const visible = useBlueprint((state) => state.reviewCommentsVisible);
  const livePrReview = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => codeReviewComments(discussion?.comments ?? NO_COMMENTS, paths, baseLine, code, visible && livePrReview),
    [baseLine, code, discussion, livePrReview, paths, visible],
  );
}

/** Store-backed adapter for local line drafts. Unlike GitHub comments, drafts remain visible when
 * the existing-comments layer is hidden and update the source widget in the same render as Add. */
export function usePendingCodeReviewComments(
  path: string | null,
  baseLine: number,
  code: string | null,
): readonly ReviewComment[] {
  const drafts = useBlueprint((state) => state.reviewComments);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => codeReviewDrafts(drafts, paths, baseLine, code, reviewActive),
    [baseLine, code, drafts, paths, reviewActive],
  );
}
