import { useMemo } from "react";
import { useBlueprint } from "../../state/StoreContext";
import type { PrGitHubComment } from "../../state/prTypes";

const NO_COMMENTS: readonly PrGitHubComment[] = [];

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

/** Store-backed adapter shared by the hover, inline, modal, and edge source hosts. */
export function useCodeReviewComments(
  path: string | null,
  baseLine: number,
  code: string | null,
): readonly PrGitHubComment[] {
  const discussion = useBlueprint((state) => state.prDiscussion);
  const visible = useBlueprint((state) => state.reviewCommentsVisible);
  const livePrReview = useBlueprint((state) => state.prReviewed !== null && state.review !== null);
  const reviewFiles = useBlueprint((state) => state.reviewFiles);
  const index = useBlueprint((state) => state.index);
  const paths = useMemo(() => {
    if (path === null) return null;
    const aliases = new Set([path]);
    for (const file of reviewFiles) {
      if (file.moduleId !== null && index.nodesById.get(file.moduleId)?.location.file === path) {
        aliases.add(file.path);
      }
    }
    return [...aliases];
  }, [index, path, reviewFiles]);
  return useMemo(
    () => codeReviewComments(discussion?.comments ?? NO_COMMENTS, paths, baseLine, code, visible && livePrReview),
    [baseLine, code, discussion, livePrReview, paths, visible],
  );
}
