import type { LineRange } from "@meridian/core";

export type PrsTab = "open" | "closed";

export type PrFileStatus = "added" | "modified" | "removed" | "renamed";

export interface PrSummary {
  number: number;
  title: string;
  author: string;
  headRef: string;
  updatedAt: string;
  draft: boolean;
  state: PrsTab;
}

export interface PrChangedFile {
  path: string;
  status: PrFileStatus;
  /** Renames only: the pre-image path (display-only — never matched against nodes). */
  previousPath?: string;
  /** New-side changed line ranges from the PR file's patch; omitted ⇒ treat the whole file as
   * changed. Feeds the PR-review deep-dive (reviewPrInGraph → the affected-code-block graph). */
  hunks?: LineRange[];
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
