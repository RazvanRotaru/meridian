import type { LineRange } from "@meridian/core";

export type PrsTab = "open" | "closed";

export type PrFileStatus = "added" | "modified" | "removed" | "renamed";

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
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
  /** Renames only: the pre-image path (display-only — never matched against nodes). */
  previousPath?: string;
}

export interface PrListResponse {
  prs: PrSummary[];
  hasMore: boolean;
}

export interface PrFilesResponse {
  files: PrChangedFile[];
  truncated: boolean;
}

export const PRS_UNAVAILABLE_ERROR = "Pull requests unavailable";
