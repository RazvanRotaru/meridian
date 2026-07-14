/**
 * Complete the bounded GitHub PR-file response from the prepared artifact's exact local Git
 * transaction. GitHub detail remains useful for commentable U3 ranges and discussion metadata,
 * but the manifest is authoritative for which files changed; it includes entries beyond the API
 * cap as well as binary, mode-only, renamed, and fully deleted paths.
 */

import {
  changedDiffLinesFromExtensions,
  changedFileManifestFromExtensions,
  changedLineKindsFromExtensions,
  changedLineStatsFromExtensions,
  changedRangesFromExtensions,
} from "@meridian/core";
import type { ChangedDiffLine, GraphArtifact, LineRange } from "@meridian/core";
import type { PrChangedFile, PrFileStatus } from "../state/prTypes";
import { normalizePath } from "./matchAffectedFiles";

/**
 * Return `githubFiles` unchanged when paired with an older/malformed artifact. Once a valid
 * manifest exists, return exactly its paths in Git order and join any available GitHub detail onto
 * them. This all-or-nothing boundary prevents a capped response from silently defining review
 * completeness.
 */
export function canonicalPrFiles(
  githubFiles: readonly PrChangedFile[],
  artifact: Pick<GraphArtifact, "extensions">,
): PrChangedFile[] {
  const manifest = changedFileManifestFromExtensions(artifact.extensions);
  if (manifest === null) {
    return [...githubFiles];
  }

  const rawByPath = new Map(githubFiles.map((file) => [normalizePath(file.path), file]));
  const ranges = normalizedRecord(changedRangesFromExtensions(artifact.extensions));
  const stats = changedLineStatsFromExtensions(artifact.extensions);
  const kinds = changedLineKindsFromExtensions(artifact.extensions);
  const diffLines = changedDiffLinesFromExtensions(artifact.extensions);

  return manifest.map((entry) => {
    const path = normalizePath(entry.path);
    const raw = rawByPath.get(path);
    const rows = diffLines?.[path];
    const delta = stats?.[path];
    const exactBody = rows !== undefined && delta !== undefined
      && countRows(rows, "added") === delta.added
      && countRows(rows, "deleted") === delta.deleted;
    const file: PrChangedFile = {
      ...(raw ?? {}),
      path,
      status: prStatus(entry.status),
      additions: delta?.added ?? (rows ? countRows(rows, "added") : raw?.additions ?? 0),
      deletions: delta?.deleted ?? (rows ? countRows(rows, "deleted") : raw?.deletions ?? 0),
    };

    if (entry.status === "renamed") {
      file.previousPath = normalizePath(entry.previousPath!);
    } else {
      delete file.previousPath;
    }
    if (ranges?.[path] !== undefined) file.hunks = ranges[path].map(copyRange);
    if (kinds?.[path] !== undefined) file.kinds = kinds[path].map((span) => ({ ...span }));
    if (rows !== undefined) {
      file.diffLines = rows.map((row) => ({ ...row }));
      file.oldHunks = deletedRanges(rows);
    }
    if (exactBody) {
      file.diffComplete = true;
    } else {
      // The manifest still proves the file transaction, but without exact local rows and totals a
      // GitHub body (even when present) must not silently become the prepared review's authority.
      // This covers binary/mode-only/empty changes, pure renames, and incomplete API patches.
      file.diffComplete = false;
    }
    return file;
  });
}

function prStatus(status: "added" | "modified" | "deleted" | "renamed"): PrFileStatus {
  return status === "deleted" ? "removed" : status;
}

function countRows(rows: readonly ChangedDiffLine[], kind: ChangedDiffLine["kind"]): number {
  return rows.filter((row) => row.kind === kind).length;
}

function deletedRanges(rows: readonly ChangedDiffLine[]): LineRange[] {
  const lines = [...new Set(rows
    .filter((row): row is ChangedDiffLine & { oldLine: number } => row.kind === "deleted" && row.oldLine !== null)
    .map((row) => row.oldLine))].sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

function copyRange(range: LineRange): LineRange {
  return { start: range.start, end: range.end };
}

function normalizedRecord<T>(record: Readonly<Record<string, T>> | null): Record<string, T> | null {
  if (record === null) return null;
  return Object.fromEntries(Object.entries(record).map(([path, value]) => [normalizePath(path), value]));
}
