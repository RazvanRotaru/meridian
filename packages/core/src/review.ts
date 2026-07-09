/**
 * The PR-review contract: the `extensions.review` payload and its defensive reader.
 *
 * `meridian review` extracts the working tree, computes the git diff vs a base ref, and stamps the
 * changed-file facts here. Everything downstream (the renderer's review tab, the affected-flow
 * predicate) keys off this bag: no `review` extension ⇒ the renderer is pixel-identical to today.
 *
 * `extensions` is unvalidated JSON at the schema level, so a hand-edited or third-party artifact can
 * carry a malformed `review` blob. `readReviewContext` shape-checks every field and returns null on
 * ANY violation — the tab gates off exactly as if there were no review data at all. Browser-clean.
 */

import type { GraphArtifact } from "./types";

/** Key of the review extension inside GraphArtifact.extensions. */
export const REVIEW_EXTENSION = "review";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * A run of changed lines on the NEW (post-image) side of a file, 1-based and inclusive. These are
 * the diff's `@@ … +start,count @@` hunks, projected to line ranges. They join to `node.location`
 * (which is also post-image, since we extract the same working tree the diff describes) so the
 * renderer can name the exact CODE BLOCKS a PR touched, not just the files. Absent hunks (an
 * untracked add, an explicit `--changed` file, or a diff we couldn't parse) mean "treat the whole
 * file as changed" — the honest, non-lossy fallback.
 */
export interface LineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  /** POSIX path relative to the EXTRACTION root — the same base as node.location.file. */
  path: string;
  status: ChangeStatus;
  /** Renames only: the old extraction-root-relative path. Display-only — never matched. */
  previousPath?: string;
  /** New-side changed line ranges; omitted ⇒ whole-file. Deletion-only hunks are anchored upstream. */
  hunks?: LineRange[];
}

/** The extensions.review payload. JSON-serializable; stamped by `meridian review` only. */
export interface ReviewContext {
  changedFiles: ChangedFile[];
  /** Resolved base ref NAME (e.g. "origin/main"); null in --changed mode. */
  baseRef: string | null;
  /** merge-base(baseRef, HEAD) sha; null in --changed mode. */
  baseSha: string | null;
  /** Current branch name; null when detached HEAD or unknown. */
  headRef: string | null;
  /** Tick scope: `${repoIdentity}|${pr ?? headRef ?? "detached"}|${baseRef ?? "explicit"}`. */
  reviewKey: string;
  /** Human-readable notices (e.g. outside-root drops). Rendered as an amber banner. */
  warnings: string[];
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set<ChangeStatus>([
  "added",
  "modified",
  "deleted",
  "renamed",
]);

/** Defensive reader: shape-checks extensions[REVIEW_EXTENSION]; null on absent/malformed. */
export function readReviewContext(artifact: GraphArtifact): ReviewContext | null {
  const raw = artifact.extensions?.[REVIEW_EXTENSION];
  if (!isRecord(raw)) {
    return null;
  }
  const changedFiles = readChangedFiles(raw.changedFiles);
  if (changedFiles === null) {
    return null;
  }
  if (!isNullableString(raw.baseRef) || !isNullableString(raw.baseSha) || !isNullableString(raw.headRef)) {
    return null;
  }
  if (typeof raw.reviewKey !== "string" || raw.reviewKey.length === 0) {
    return null;
  }
  if (!isStringArray(raw.warnings)) {
    return null;
  }
  return {
    changedFiles,
    baseRef: raw.baseRef,
    baseSha: raw.baseSha,
    headRef: raw.headRef,
    reviewKey: raw.reviewKey,
    warnings: raw.warnings,
  };
}

/** The match set for all joins: `path` values only — previousPath is deliberately excluded. */
export function changedPathSet(files: readonly ChangedFile[]): Set<string> {
  return new Set(files.map((file) => file.path));
}

function readChangedFiles(value: unknown): ChangedFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const files: ChangedFile[] = [];
  for (const entry of value) {
    const file = readChangedFile(entry);
    if (file === null) {
      return null;
    }
    files.push(file);
  }
  return files;
}

function readChangedFile(entry: unknown): ChangedFile | null {
  if (!isRecord(entry) || typeof entry.path !== "string") {
    return null;
  }
  if (typeof entry.status !== "string" || !KNOWN_STATUSES.has(entry.status)) {
    return null;
  }
  if (entry.previousPath !== undefined && typeof entry.previousPath !== "string") {
    return null;
  }
  const hunks = readHunks(entry.hunks);
  if (hunks === null) {
    return null;
  }
  const file: ChangedFile = { path: entry.path, status: entry.status as ChangeStatus };
  if (typeof entry.previousPath === "string") {
    file.previousPath = entry.previousPath;
  }
  if (hunks !== undefined) {
    file.hunks = hunks;
  }
  return file;
}

/** undefined = field absent (whole-file); [] or ranges = present & valid; null = malformed. */
function readHunks(value: unknown): LineRange[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const hunks: LineRange[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isFiniteInteger(entry.start) || !isFiniteInteger(entry.end)) {
      return null;
    }
    // 1-based, non-empty, non-inverted: a hand-edited artifact with `{start:10,end:5}` or a
    // non-positive line is malformed, and the reader nulls out exactly as for any other violation.
    if (entry.start < 1 || entry.end < entry.start) {
      return null;
    }
    hunks.push({ start: entry.start, end: entry.end });
  }
  return hunks;
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
