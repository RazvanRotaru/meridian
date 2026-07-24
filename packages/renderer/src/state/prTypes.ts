import type { ChangedDiffLine, ChangedLineSpan, LineRange } from "@meridian/core";

export type PrsTab = "open" | "closed";
export type PrReviewSubmissionEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type PrReviewCommentSide = "LEFT" | "RIGHT";

/** One exact edit run's old/new spans; an empty side starts at its 1-based next-row cursor. */
export interface LineEdit {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type PrFileStatus = "added" | "modified" | "removed" | "renamed";
export type PrFileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

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
  /** Per-edit-run old/new spans, for mapping a node's base span to its position in the PR head file. */
  edits?: LineEdit[];
  /** GitHub's context-padded U3 header ranges, retained only for review-comment validation. */
  contextHunks?: LineRange[];
  /** Head-relative added/modified line spans (from the patch body) — the code panel's exact green/gold. */
  kinds?: ChangedLineSpan[];
  /** Exact ordered +/- rows from the canonical local/GitHub unified-diff parser. */
  diffLines?: ChangedDiffLine[];
  /** Whether the patch body is complete and agrees with GitHub's file-level +/- totals. */
  diffComplete?: boolean;
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

/** Viewer-specific GitHub state for every changed file at one immutable PR head. */
export interface PrViewedFilesResponse {
  files: Array<{ path: string; state: PrFileViewedState }>;
  headSha: string;
  viewerId: string;
  viewerLogin: string;
}

export interface PrViewedFileMutationResponse {
  path: string;
  state: PrFileViewedState;
  headSha: string;
  viewerId: string;
  viewerLogin: string;
}

export interface PrViewedFilesMutationResponse {
  files: Array<{ path: string; state: PrFileViewedState }>;
  headSha: string;
  viewerId: string;
  viewerLogin: string;
}

export interface PrOneResponse {
  pr: PrSummary;
}

/** Open PR returned by the bounded related-path scan. */
export interface RelatedPr {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  draft: boolean;
  matchCount: number;
  matchedPaths: string[];
}

export interface RelatedPrsResponse {
  results: RelatedPr[];
  scanned: number;
  hasMore: boolean;
  skipped: number;
}

export interface RelatedPrsState {
  paths: string[];
  results: RelatedPr[];
  scanned: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
}

export interface PrGitHubComment {
  /** Stable GitHub pull-request review comment id; mutation actions address this value. */
  id: number;
  /** The top-level review comment this replies to; null identifies a thread root. */
  inReplyToId: number | null;
  path: string;
  line: number | null;
  side: PrReviewCommentSide | null;
  body: string;
  author: string;
  /** GitHub's viewer-specific permission for editing this exact comment. */
  viewerCanEdit: boolean;
  updatedAt: string;
  url: string;
}

/** Which existing GitHub review comments the PR-review workspace projects. Local pending
 * comments are authored by the viewer and remain visible in every mode. */
export type ReviewCommentFilter = "all" | "mine" | "participated";

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
