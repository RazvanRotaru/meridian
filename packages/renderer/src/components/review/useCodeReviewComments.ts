import { useMemo } from "react";
import type { LineRange } from "@meridian/core";
import { useBlueprint } from "../../state/StoreContext";
import type { PrGitHubComment } from "../../state/prTypes";
import type { ReviewComment } from "../../state/reviewTicksPref";
import { filterReviewComments } from "../../derive/reviewCommentFilter";

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
  lineCount?: number,
): ReadonlySet<number> {
  if (!enabled || code === null || ranges.length === 0) {
    return NO_LINES;
  }
  const endLine = sourceEndLine(baseLine, code, lineCount);
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
  lineCount?: number,
): ReadonlySet<number> {
  const ranges = useBlueprint((state) => path === null ? NO_RANGES : (state.reviewCommentRangesByFile[path] ?? NO_RANGES));
  const enabled = useBlueprint((state) => state.prReviewed !== null
    && state.review !== null
    && !state.prReviewRefreshing
    && state.prReviewStatus !== "preparing");
  return useMemo(
    () => commentableReviewLines(ranges, baseLine, code, enabled, lineCount),
    [baseLine, code, enabled, lineCount, ranges],
  );
}

/** Only RIGHT-side comments can be placed against ordinary HEAD source rows. LEFT-side comments
 * require an exact canonical deletion row, selected separately below, so an old-side line is never
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
  lineCount?: number,
): readonly PrGitHubComment[] {
  if (!visible || paths === null || code === null) {
    return NO_COMMENTS;
  }
  const endLine = sourceEndLine(baseLine, code, lineCount);
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

/** Select LEFT-side comments for the exact deleted rows rendered in a source diff. */
export function deletedCodeReviewComments(
  comments: readonly PrGitHubComment[],
  paths: string | readonly string[] | null,
  deletedLines: ReadonlySet<number>,
  visible: boolean,
): readonly PrGitHubComment[] {
  if (!visible || paths === null || deletedLines.size === 0) {
    return NO_COMMENTS;
  }
  const matchesPath = typeof paths === "string"
    ? (comment: PrGitHubComment) => comment.path === paths
    : (comment: PrGitHubComment) => paths.includes(comment.path);
  return comments.filter(
    (comment) => matchesPath(comment)
      && comment.side === "LEFT"
      && comment.line !== null
      && deletedLines.has(comment.line),
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
  lineCount?: number,
): readonly ReviewComment[] {
  if (!active || paths === null || code === null) {
    return NO_DRAFTS;
  }
  const endLine = sourceEndLine(baseLine, code, lineCount);
  const matchesPath = typeof paths === "string"
    ? (draft: ReviewComment) => draft.path === paths
    : (draft: ReviewComment) => paths.includes(draft.path);
  return drafts.filter(
    (draft) => matchesPath(draft)
      && draft.line !== null
      && draft.side === "RIGHT"
      && draft.lineStale !== true
      && draft.line >= baseLine
      && draft.line <= endLine,
  );
}

/** Select fresh local LEFT-side drafts for the exact deleted rows rendered in a source diff. */
export function deletedCodeReviewDrafts(
  drafts: readonly ReviewComment[],
  paths: string | readonly string[] | null,
  deletedLines: ReadonlySet<number>,
  active: boolean,
): readonly ReviewComment[] {
  if (!active || paths === null || deletedLines.size === 0) {
    return NO_DRAFTS;
  }
  const matchesPath = typeof paths === "string"
    ? (draft: ReviewComment) => draft.path === paths
    : (draft: ReviewComment) => paths.includes(draft.path);
  return drafts.filter(
    (draft) => matchesPath(draft)
      && draft.side === "LEFT"
      && draft.line !== null
      && draft.lineStale !== true
      && deletedLines.has(draft.line),
  );
}

type ReviewPathFile = {
  path: string;
  moduleId: string | null;
  units: readonly { nodeId: string }[];
};

type ReviewPathNodes = ReadonlyMap<string, { location: { file: string } }>;

function reviewFileOwnsSourcePath(
  file: ReviewPathFile,
  path: string,
  nodesById: ReviewPathNodes,
): boolean {
  return (
    file.moduleId !== null
    && nodesById.get(file.moduleId)?.location.file === path
  ) || file.units.some((unit) => nodesById.get(unit.nodeId)?.location.file === path);
}

export function reviewCommentPaths(
  path: string,
  reviewFiles: readonly ReviewPathFile[],
  nodesById: ReviewPathNodes,
): readonly string[] {
  const aliases = new Set([path]);
  for (const file of reviewFiles) {
    if (reviewFileOwnsSourcePath(file, path, nodesById)) {
      // A renamed file's deleted/base units retain the old source path while GitHub addresses review
      // comments by the current PR path. Keep both identities so submitted LEFT comments reappear.
      aliases.add(file.path);
    }
  }
  return [...aliases];
}

/** Resolve a source path to the one unambiguous current PR file that owns it. Local LEFT drafts use
 * this current identity in the review rail while retaining their separate BASE line coordinate. */
export function currentReviewCommentPath(
  path: string,
  reviewFiles: readonly ReviewPathFile[],
  nodesById: ReviewPathNodes,
  sourceNodeId?: string,
): string {
  if (sourceNodeId !== undefined) {
    const nodeOwners = new Set(
      reviewFiles
        .filter((file) => file.moduleId === sourceNodeId || file.units.some((unit) => unit.nodeId === sourceNodeId))
        .map((file) => file.path),
    );
    if (nodeOwners.size === 1) return [...nodeOwners][0]!;
  }
  const owners = reviewFiles.filter((file) => file.path === path || reviewFileOwnsSourcePath(file, path, nodesById));
  const paths = new Set(owners.map((file) => file.path));
  return paths.size === 1 ? [...paths][0]! : path;
}

function useReviewCommentPaths(path: string | null): readonly string[] | null {
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const index = useBlueprint((state) => state.index);
  return useMemo(
    () => path === null ? null : reviewCommentPaths(path, reviewFiles, index.nodesById),
    [index, path, reviewFiles],
  );
}

/** Store-backed adapter shared by the hover, inline, modal, and edge source hosts. */
export function useCodeReviewComments(
  path: string | null,
  baseLine: number,
  code: string | null,
  lineCount?: number,
): readonly PrGitHubComment[] {
  const discussion = useBlueprint((state) => state.prDiscussion);
  const visible = useBlueprint((state) => state.reviewCommentsVisible);
  const filter = useBlueprint((state) => state.reviewCommentFilter ?? "all");
  const livePrReview = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => codeReviewComments(filterReviewComments(discussion?.comments ?? NO_COMMENTS, filter), paths, baseLine, code, visible && livePrReview, lineCount),
    [baseLine, code, discussion, filter, lineCount, livePrReview, paths, visible],
  );
}

/** Store-backed adapter for existing comments on visible deleted rows. */
export function useDeletedCodeReviewComments(
  path: string | null,
  deletedLines: ReadonlySet<number>,
): readonly PrGitHubComment[] {
  const discussion = useBlueprint((state) => state.prDiscussion);
  const visible = useBlueprint((state) => state.reviewCommentsVisible);
  const filter = useBlueprint((state) => state.reviewCommentFilter ?? "all");
  const livePrReview = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => deletedCodeReviewComments(
      filterReviewComments(discussion?.comments ?? NO_COMMENTS, filter),
      paths,
      deletedLines,
      visible && livePrReview,
    ),
    [deletedLines, discussion, filter, livePrReview, paths, visible],
  );
}

/** Store-backed adapter for local line drafts. Unlike GitHub comments, drafts remain visible when
 * the existing-comments layer is hidden and update the source widget in the same render as Add. */
export function usePendingCodeReviewComments(
  path: string | null,
  baseLine: number,
  code: string | null,
  lineCount?: number,
): readonly ReviewComment[] {
  const drafts = useBlueprint((state) => state.reviewComments);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => codeReviewDrafts(drafts, paths, baseLine, code, reviewActive, lineCount),
    [baseLine, code, drafts, lineCount, paths, reviewActive],
  );
}

/** Store-backed adapter for fresh local drafts on visible deleted rows. */
export function usePendingDeletedCodeReviewComments(
  path: string | null,
  deletedLines: ReadonlySet<number>,
): readonly ReviewComment[] {
  const drafts = useBlueprint((state) => state.reviewComments);
  const reviewActive = useBlueprint((state) => state.review !== null);
  const paths = useReviewCommentPaths(path);
  return useMemo(
    () => deletedCodeReviewDrafts(drafts, paths, deletedLines, reviewActive),
    [deletedLines, drafts, paths, reviewActive],
  );
}

function sourceEndLine(baseLine: number, code: string, lineCount: number | undefined): number {
  return baseLine + (lineCount ?? code.split("\n").length) - 1;
}
