/**
 * Fetch the PR review comments the web server captured at generate time. Comments are garnish
 * on the graph: any failure — no endpoint, a 404, malformed JSON — degrades to null, and every
 * comments control simply doesn't render.
 */

import type { CommentsByFile } from "../comments/types";

export async function loadComments(commentsUrl: string): Promise<CommentsByFile | null> {
  try {
    const response = await fetch(commentsUrl, { credentials: "same-origin" });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { comments?: unknown };
    const comments = data.comments;
    if (typeof comments !== "object" || comments === null || Array.isArray(comments)) {
      return null;
    }
    // An empty map means "web mode, but this repo has no review comments" — normalizing it to
    // null lets one check gate every comments control.
    return Object.keys(comments).length > 0 ? (comments as CommentsByFile) : null;
  } catch {
    return null;
  }
}
