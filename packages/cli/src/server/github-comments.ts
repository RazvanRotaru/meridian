/**
 * Pure parsing and grouping of GitHub pull-request review comments, with the same whitelist
 * discipline as `github-parse`: bodies and logins are attacker-controllable, so only these typed
 * projections — and only https://github.com links — ever leave the server. Comments are garnish
 * on top of the graph, so a malformed item is skipped, never a 502.
 */

import { numberOr, optionalString } from "./json-fields";

const COMMENT_RESULT_LIMIT = 100;

export interface PullComment {
  /** Path of the commented file, relative to the extraction root after grouping. */
  file: string;
  author: string;
  body: string;
  /** The commented line, or null when GitHub reports none (an outdated diff position). */
  line: number | null;
  prNumber: number | null;
  /** The comment's github.com page; anything but https://github.com becomes null. */
  url: string | null;
  createdAt: string | null;
}

export type CommentsByFile = Record<string, PullComment[]>;

/** `GET /repos/{owner}/{repo}/pulls/comments` responds with a bare array of review comments. */
export function parsePullComments(json: unknown): PullComment[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json.slice(0, COMMENT_RESULT_LIMIT).flatMap((item) => {
    const comment = toPullComment(item);
    return comment ? [comment] : [];
  });
}

/**
 * Group comments by file, rebasing repo-relative paths onto the extraction root: with a subdir
 * of `src/app`, a comment on `src/app/x.ts` keys as `x.ts` (matching the artifact's node
 * locations) and a comment outside the subdir is dropped.
 */
export function groupCommentsByFile(comments: PullComment[], subdir?: string): CommentsByFile {
  const prefix = subdirPrefix(subdir);
  const byFile: CommentsByFile = {};
  for (const comment of comments) {
    const file = rebased(comment.file, prefix);
    if (file !== null) {
      (byFile[file] ??= []).push({ ...comment, file });
    }
  }
  return byFile;
}

function toPullComment(item: unknown): PullComment | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const raw = item as Record<string, unknown>;
  const file = optionalString(raw, "path");
  const body = optionalString(raw, "body");
  if (!file || !body) {
    return null;
  }
  const user = typeof raw.user === "object" && raw.user !== null ? (raw.user as Record<string, unknown>) : {};
  return {
    file: toPosix(file),
    author: optionalString(user, "login") ?? "unknown",
    body,
    line: lineOf(raw),
    prNumber: prNumberOf(optionalString(raw, "pull_request_url")),
    url: githubHttpsOrNull(optionalString(raw, "html_url")),
    createdAt: optionalString(raw, "created_at"),
  };
}

// `line` is null on comments whose diff anchor went stale; `original_line` then still names the
// line the reviewer saw, which beats showing nothing.
function lineOf(raw: Record<string, unknown>): number | null {
  const line = numberOr(raw.line, numberOr(raw.original_line, -1));
  return line > 0 ? line : null;
}

function prNumberOf(pullRequestUrl: string | null): number | null {
  const match = pullRequestUrl?.match(/\/pulls\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function githubHttpsOrNull(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === "github.com" ? url : null;
  } catch {
    return null;
  }
}

/** Normalize a subdir to a `posix/prefix/` (empty for none/`.`), tolerant of `\` and edge slashes. */
function subdirPrefix(subdir?: string): string {
  const clean = toPosix((subdir ?? "").trim()).replace(/^\/+|\/+$/g, "");
  return clean === "" || clean === "." ? "" : `${clean}/`;
}

function rebased(file: string, prefix: string): string | null {
  if (prefix === "") {
    return file;
  }
  return file.startsWith(prefix) ? file.slice(prefix.length) : null;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}
