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
