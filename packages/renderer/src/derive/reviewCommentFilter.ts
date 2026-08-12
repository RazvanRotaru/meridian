import type {
  PrGitHubComment,
  ReviewCommentFilter,
  ReviewCommentFilterSubject,
} from "../state/prTypes";

export const DEFAULT_REVIEW_COMMENT_FILTER: ReviewCommentFilter = {
  subject: { kind: "all" },
  mode: "authored",
};

export interface ReviewCommentAuthor {
  readonly login: string;
  readonly isViewer: boolean;
}

/** Keep a person-specific filter only while that person still exists in the latest loaded
 * discussion. Viewer and all-user filters remain meaningful even when their current count is zero. */
export function reviewCommentFilterForComments(
  filter: ReviewCommentFilter,
  comments: readonly PrGitHubComment[],
): ReviewCommentFilter {
  const subject = filter.subject;
  if (
    subject.kind === "author"
    && !comments.some((comment) => normalizeLogin(comment.author) === normalizeLogin(subject.login))
  ) {
    return DEFAULT_REVIEW_COMMENT_FILTER;
  }
  return filter;
}

/** Unique comment authors for the person picker. GitHub logins are case-insensitive, while the
 * first spelling returned by GitHub remains the display spelling. */
export function reviewCommentAuthors(
  comments: readonly PrGitHubComment[],
): readonly ReviewCommentAuthor[] {
  const authors = new Map<string, ReviewCommentAuthor>();
  for (const comment of comments) {
    const key = normalizeLogin(comment.author);
    const existing = authors.get(key);
    if (existing === undefined) {
      authors.set(key, { login: comment.author, isViewer: comment.viewerCanEdit });
    } else if (!existing.isViewer && comment.viewerCanEdit) {
      authors.set(key, { ...existing, isViewer: true });
    }
  }
  return [...authors.values()].sort((left, right) =>
    left.login.localeCompare(right.login, undefined, { sensitivity: "base" }),
  );
}

/** Filter GitHub comments by a selected person. Authored mode keeps only that person's comments;
 * participated mode keeps the complete root/reply threads in which they wrote at least once.
 * `viewerCanEdit` remains the authenticated-viewer identity signal, so the renderer does not need
 * the signed-in login. */
export function filterReviewComments(
  comments: readonly PrGitHubComment[],
  filter: ReviewCommentFilter | undefined,
): readonly PrGitHubComment[] {
  const active = filter ?? DEFAULT_REVIEW_COMMENT_FILTER;
  const subject = active.subject;
  if (subject.kind === "all") {
    return comments;
  }
  if (active.mode === "authored") {
    return comments.filter((comment) => commentMatchesSubject(comment, subject));
  }

  const participatedThreadIds = new Set<number>();
  for (const comment of comments) {
    if (commentMatchesSubject(comment, subject)) {
      participatedThreadIds.add(comment.inReplyToId ?? comment.id);
    }
  }
  return comments.filter((comment) => participatedThreadIds.has(comment.inReplyToId ?? comment.id));
}

function commentMatchesSubject(
  comment: PrGitHubComment,
  subject: Exclude<ReviewCommentFilterSubject, { kind: "all" }>,
): boolean {
  return subject.kind === "viewer"
    ? comment.viewerCanEdit
    : normalizeLogin(comment.author) === normalizeLogin(subject.login);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}
