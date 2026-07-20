import type { PrGitHubComment, ReviewCommentFilter } from "../state/prTypes";

/** Filter GitHub comments without losing the discussion around a viewer-authored reply.
 * `viewerCanEdit` is GitHub's authenticated-viewer ownership signal, so this does not require
 * separately exposing the signed-in login to the renderer. */
export function filterReviewComments(
  comments: readonly PrGitHubComment[],
  filter: ReviewCommentFilter | undefined,
): readonly PrGitHubComment[] {
  if (filter === undefined || filter === "all") {
    return comments;
  }
  if (filter === "mine") {
    return comments.filter((comment) => comment.viewerCanEdit);
  }

  const participatedThreadIds = new Set<number>();
  for (const comment of comments) {
    if (comment.viewerCanEdit) {
      participatedThreadIds.add(comment.inReplyToId ?? comment.id);
    }
  }
  return comments.filter((comment) => participatedThreadIds.has(comment.inReplyToId ?? comment.id));
}
