/**
 * PR review comments for a generated graph. Fetched once per generate — concurrently with the
 * clone + extraction, using the same token precedence — grouped by extraction-root-relative file
 * path, and kept beside the artifact under the same id; `/api/comments` reads the stored map
 * back. Comments are garnish on the graph: any fetch failure degrades to "none" and must never
 * fail or slow a generate's error path.
 */

import type { ServerResponse } from "node:http";
import { classifyQuery } from "./github-parse";
import { groupCommentsByFile } from "./github-comments";
import type { CommentsByFile } from "./github-comments";
import { sendJson } from "./http-response";
import type { GitHubClient } from "./github";
import type { SourceRequest } from "./clone";
import type { Context } from "./web-server";

/** Resolves to {} for local paths, foreign hosts, or any API failure — never rejects. */
export async function fetchCommentsFor(
  github: GitHubClient | null,
  token: string | undefined,
  source: SourceRequest,
): Promise<CommentsByFile> {
  const repo = repoSlugOf(source);
  if (!github || !repo) {
    return {};
  }
  try {
    return groupCommentsByFile(await github.listPullComments(token, repo), source.subdir);
  } catch {
    return {};
  }
}

/** A github.com source (owner/repo or URL-shaped) → "owner/repo"; anything else → null. */
function repoSlugOf(source: SourceRequest): string | null {
  if (source.kind !== "github") {
    return null;
  }
  const classified = classifyQuery(source.value);
  return classified?.kind === "exact" ? `${classified.owner}/${classified.repo}` : null;
}

export function sendComments(ctx: Context, response: ServerResponse, id: string | null): void {
  const comments = id ? ctx.comments.get(id) : undefined;
  if (!comments) {
    sendJson(response, 404, { error: "unknown graph id" });
    return;
  }
  sendJson(response, 200, { comments });
}
