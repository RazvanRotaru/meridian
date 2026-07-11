import type { ChangedLineSpan, LineRange } from "@meridian/core";

export type PrsTab = "open" | "closed";

/** One unified-diff hunk's old/new line spans — maps a node's base line to its PR-head line. */
export interface LineEdit {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type PrFileStatus = "added" | "modified" | "removed" | "renamed";

export interface PrSummary {
  number: number;
  title: string;
  body: string | null;
  author: string;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  state: PrsTab;
  url: string;
}

export interface PrChangedFile {
  path: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /** New-side changed line ranges parsed from the file's unified-diff patch; absent ⇒ the whole
   * file is treated as changed. Lets the PR-review graph name the exact touched code blocks. */
  hunks?: LineRange[];
  /** Base-side (old) tight changed ranges — base-graph node marking (avoids spill onto the next unit). */
  oldHunks?: LineRange[];
  /** Per-hunk old/new spans, for mapping a node's base span to its position in the PR head file. */
  edits?: LineEdit[];
  /** Head-relative added/modified line spans (from the patch body) — the code panel's exact green/gold. */
  kinds?: ChangedLineSpan[];
  /** Text removed by the patch, grouped by consecutive deletion run and anchored after a HEAD line. */
  removed?: Array<{ afterNewLine: number; lines: string[] }>;
  /** The patch carried more than the per-file cap of removed-line text. */
  removedTruncated?: boolean;
  /** Renames only: the pre-image path (display-only — never matched against nodes). */
  previousPath?: string;
}

/** GitHub source identity exposed by the web session for a safe same-repository re-extract. */
export interface PrSessionSource {
  repository: string;
  subdir: string;
}

export interface PrListResponse {
  prs: PrSummary[];
  hasMore: boolean;
}

export interface PrFilesResponse {
  files: PrChangedFile[];
  truncated: boolean;
  totalFiles: number;
  outsideCount: number;
  suggestedSubdir: string;
}

export interface PrOneResponse {
  pr: PrSummary;
}

export interface PrGitHubComment {
  path: string;
  line: number | null;
  body: string;
  author: string;
  updatedAt: string;
  url: string;
}

export interface PrReviewRollup {
  approved: string[];
  changesRequested: string[];
  commented: number;
}

export interface PrDiscussionResult {
  comments: PrGitHubComment[];
  reviews: PrReviewRollup;
  hasMore: boolean;
}

export interface PrChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  url: string | null;
}

export const PRS_UNAVAILABLE_ERROR = "Pull requests unavailable";
