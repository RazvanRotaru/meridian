/**
 * PR review comments as `/api/comments` serves them: grouped by extraction-root-relative file
 * path — the same path a node's `location.file` carries, which is the whole join. The server has
 * already whitelisted every field (only https://github.com survives as a url).
 */

export interface PullComment {
  file: string;
  author: string;
  body: string;
  /** The commented line, or null when GitHub reported none (an outdated diff anchor). */
  line: number | null;
  prNumber: number | null;
  url: string | null;
  createdAt: string | null;
}

export type CommentsByFile = Record<string, PullComment[]>;
