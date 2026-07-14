/**
 * Changed-code detection: mapping a set of changed source lines (a PR's diff) onto graph nodes.
 *
 * The verdict rides the schema's existing open `tags` vocabulary (`"changed"`), so the contract
 * is unchanged (ADR 0001 untouched) — exactly the `"test"` tag's pattern. The CLI computes the
 * changed line ranges from git and tags nodes after extraction; extractors stay pure and the
 * renderer just reads the tag back via `collectChangedIds`.
 */

import type { GraphNode } from "./types";

export const CHANGED_TAG = "changed";

/** An inclusive 1-based line span inside one file. */
export interface LineRange {
  start: number;
  end: number;
}

/** Changed spans per file, keyed by the same root-relative path `node.location.file` uses. */
export type ChangedRanges = Record<string, LineRange[]>;

/** Added/deleted line counts per changed file (new-side path), from unified-diff hunk totals. */
export interface ChangedLineDelta {
  added: number;
  deleted: number;
}

export type ChangedLineStats = Record<string, ChangedLineDelta>;
export type ChangedLineKind = "added" | "modified" | "deleted";

export interface ChangedLineSpan extends LineRange {
  kind: ChangedLineKind;
}

/** Changed-line kinds per file, keyed by root-relative path. */
export type ChangedLineKinds = Record<string, ChangedLineSpan[]>;

/**
 * One exact changed row from a unified diff, in patch order.
 *
 * Unlike `ChangedLineSpan`, this is lossless enough to render: additions carry their HEAD line,
 * deletions carry their base line and the HEAD insertion cursor they appear immediately before.
 * `beforeNewLine` is always 1-based; deletions at the top use 1 and deletions at EOF use
 * `newFileLength + 1`.
 */
export interface ChangedDiffLine {
  kind: "added" | "deleted";
  oldLine: number | null;
  newLine: number | null;
  beforeNewLine: number;
  text: string;
  /** Git's marker immediately followed this changed row. */
  noNewline?: boolean;
}

/** Exact ordered diff rows per file, keyed by the same root-relative path as node locations. */
export type ChangedDiffLines = Record<string, ChangedDiffLine[]>;

/** The normalized file-level vocabulary persisted from `git diff --name-status`. */
export type ChangedFileManifestStatus = "added" | "modified" | "deleted" | "renamed";

/**
 * One entry in the exact changed-file manifest persisted by `--changed-since` analysis.
 *
 * This deliberately does not derive from line hunks: binary files, mode-only edits, pure renames,
 * and fully deleted files can all have no new-side hunk while still being part of the change.
 */
export interface ChangedFileManifestEntry {
  /** POSIX path relative to the extraction root; for a rename this is the new/HEAD path. */
  path: string;
  status: ChangedFileManifestStatus;
  /** Renames only: the old/base path relative to the same extraction root. */
  previousPath?: string;
}

/**
 * Return nodes with changed code tagged `"changed"`; untouched nodes pass through by reference.
 *
 * Two passes keep the tag MEANINGFUL rather than merely correct: declarations (functions, methods,
 * classes…) are tagged by span overlap, but whole-file containers (module/package) are skipped —
 * their span covers every line, so overlap would tag the entire file for a one-line edit. A module
 * is tagged only as the FALLBACK, when a file's changes touched none of its declarations (e.g. an
 * import or top-level constant edit — which is exactly the module's own load-time code).
 */
export function tagChangedNodes(nodes: GraphNode[], changed: ChangedRanges): GraphNode[] {
  const filesNeedingFallback = new Set(Object.keys(changed));
  const tagged = nodes.map((node) => {
    if (isFileContainer(node) || !overlapsChange(node, changed)) {
      return node;
    }
    filesNeedingFallback.delete(normalizePath(node.location.file));
    return withChangedTag(node);
  });
  if (filesNeedingFallback.size === 0) {
    return tagged;
  }
  return tagged.map((node) =>
    node.kind === "module" && filesNeedingFallback.has(normalizePath(node.location.file)) ? withChangedTag(node) : node,
  );
}

export function isChangedNode(node: GraphNode): boolean {
  return node.tags?.includes(CHANGED_TAG) ?? false;
}

/** The ids of every node tagged `"changed"` — no containment closure: only actual edits count. */
export function collectChangedIds(nodes: GraphNode[]): Set<string> {
  return new Set(nodes.filter(isChangedNode).map((node) => node.id));
}

/**
 * Read the changed ranges back out of `artifact.extensions.changedSince.files` — the CLI persists
 * them there so a viewer can mark the exact lines, not just the tagged nodes. Extensions are
 * free-form JSON, so this narrows defensively: a malformed shape yields null and junk entries are
 * skipped, never thrown on (lenient viewers must not trust a foreign generator's output).
 */
export function changedRangesFromExtensions(extensions: unknown): ChangedRanges | null {
  const files = (extensions as { changedSince?: { files?: unknown } } | undefined)?.changedSince?.files;
  if (files === null || files === undefined || typeof files !== "object" || Array.isArray(files)) {
    return null;
  }
  const ranges: ChangedRanges = {};
  for (const [file, spans] of Object.entries(files)) {
    if (Array.isArray(spans)) {
      ranges[file] = spans.filter(isLineRange);
    }
  }
  return ranges;
}

/**
 * Read `extensions.changedSince.stats` (`{ [file]: { added, deleted } }`) back out defensively.
 * Missing/malformed payloads yield null; malformed entries are skipped, never thrown on.
 */
export function changedLineStatsFromExtensions(extensions: unknown): ChangedLineStats | null {
  const raw = (extensions as { changedSince?: { stats?: unknown } } | undefined)?.changedSince?.stats;
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const stats: ChangedLineStats = {};
  for (const [file, value] of Object.entries(raw)) {
    if (isChangedLineDelta(value)) {
      stats[normalizePath(file)] = value;
    }
  }
  return stats;
}

/** Read `extensions.changedSince.kinds` (`{ [file]: [{start,end,kind}] }`) back out defensively. */
export function changedLineKindsFromExtensions(extensions: unknown): ChangedLineKinds | null {
  const raw = (extensions as { changedSince?: { kinds?: unknown } } | undefined)?.changedSince?.kinds;
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const kinds: ChangedLineKinds = {};
  for (const [file, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const spans = value.filter(isChangedLineSpan);
    if (spans.length > 0) {
      kinds[normalizePath(file)] = spans;
    }
  }
  return kinds;
}

/**
 * Read the lossless changed rows from `extensions.changedSince.diffLines` defensively.
 * Malformed rows are skipped; malformed/missing top-level payloads yield null.
 */
export function changedDiffLinesFromExtensions(extensions: unknown): ChangedDiffLines | null {
  const raw = (extensions as { changedSince?: { diffLines?: unknown } } | undefined)?.changedSince?.diffLines;
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const diffLines: ChangedDiffLines = {};
  for (const [file, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const rows = value.filter(isChangedDiffLine);
    if (rows.length > 0) {
      diffLines[normalizePath(file)] = rows;
    }
  }
  return diffLines;
}

/**
 * Read `extensions.changedSince.manifest` as one all-or-nothing, exact changed-file transaction.
 *
 * A partial manifest would be worse than no manifest for review completeness, so unlike the
 * best-effort line-marking readers above, any malformed/duplicate entry invalidates the full list.
 */
export function changedFileManifestFromExtensions(extensions: unknown): ChangedFileManifestEntry[] | null {
  const raw = (extensions as { changedSince?: { manifest?: unknown } } | undefined)?.changedSince?.manifest;
  if (!Array.isArray(raw)) {
    return null;
  }
  const manifest: ChangedFileManifestEntry[] = [];
  const seenPaths = new Set<string>();
  for (const value of raw) {
    const entry = changedFileManifestEntry(value);
    if (entry === null || seenPaths.has(entry.path)) {
      return null;
    }
    seenPaths.add(entry.path);
    manifest.push(entry);
  }
  return manifest;
}

/** The line delta for one node's file, normalized against windows/posix separators. */
export function changedLineDeltaForNode(
  stats: ChangedLineStats,
  node: Pick<GraphNode, "location">,
): ChangedLineDelta | null {
  const file = node.location?.file;
  if (!file) {
    return null;
  }
  return stats[normalizePath(file)] ?? null;
}

/** The changed line numbers inside one node's span — what a code panel's gutter marks amber. */
export function changedLinesWithin(
  ranges: ChangedRanges,
  file: string,
  startLine: number,
  endLine: number | undefined,
): Set<number> {
  const lines = new Set<number>();
  const spans = ranges[normalizePath(file)] ?? [];
  const last = endLine ?? startLine;
  for (const span of spans) {
    for (let line = Math.max(span.start, startLine); line <= Math.min(span.end, last); line += 1) {
      lines.add(line);
    }
  }
  return lines;
}

/** Per-line change kind inside one node span; precedence is deleted > modified > added. */
export function changedLineKindsWithin(
  kinds: ChangedLineKinds,
  file: string,
  startLine: number,
  endLine: number | undefined,
): ReadonlyMap<number, ChangedLineKind> {
  const lines = new Map<number, ChangedLineKind>();
  const spans = kinds[normalizePath(file)] ?? [];
  const last = endLine ?? startLine;
  for (const span of spans) {
    for (let line = Math.max(span.start, startLine); line <= Math.min(span.end, last); line += 1) {
      const current = lines.get(line);
      if (current === "deleted") {
        continue;
      }
      if (current === "modified" && span.kind === "added") {
        continue;
      }
      lines.set(line, span.kind);
    }
  }
  return lines;
}

function isLineRange(span: unknown): span is LineRange {
  const candidate = span as { start?: unknown; end?: unknown } | null;
  return typeof candidate?.start === "number" && typeof candidate?.end === "number" && candidate.start <= candidate.end;
}

function isChangedLineDelta(value: unknown): value is ChangedLineDelta {
  const candidate = value as { added?: unknown; deleted?: unknown } | null;
  return (
    typeof candidate?.added === "number" &&
    typeof candidate?.deleted === "number" &&
    candidate.added >= 0 &&
    candidate.deleted >= 0
  );
}

function isChangedLineKind(value: unknown): value is ChangedLineKind {
  return value === "added" || value === "modified" || value === "deleted";
}

function isChangedLineSpan(value: unknown): value is ChangedLineSpan {
  const candidate = value as { start?: unknown; end?: unknown; kind?: unknown } | null;
  return (
    typeof candidate?.start === "number" &&
    typeof candidate?.end === "number" &&
    candidate.start <= candidate.end &&
    isChangedLineKind(candidate.kind)
  );
}

function isChangedDiffLine(value: unknown): value is ChangedDiffLine {
  const candidate = value as {
    kind?: unknown;
    oldLine?: unknown;
    newLine?: unknown;
    beforeNewLine?: unknown;
    text?: unknown;
    noNewline?: unknown;
  } | null;
  if (
    (candidate?.kind !== "added" && candidate?.kind !== "deleted")
    || !isPositiveLine(candidate.beforeNewLine)
    || typeof candidate.text !== "string"
    || (candidate.noNewline !== undefined && typeof candidate.noNewline !== "boolean")
  ) {
    return false;
  }
  return candidate.kind === "added"
    ? candidate.oldLine === null
      && isPositiveLine(candidate.newLine)
      && candidate.beforeNewLine === candidate.newLine
    : isPositiveLine(candidate.oldLine) && candidate.newLine === null;
}

function changedFileManifestEntry(value: unknown): ChangedFileManifestEntry | null {
  const candidate = value as { path?: unknown; status?: unknown; previousPath?: unknown } | null;
  if (!isManifestPath(candidate?.path) || !isChangedFileManifestStatus(candidate.status)) {
    return null;
  }
  if (candidate.status === "renamed") {
    if (!isManifestPath(candidate.previousPath) || candidate.previousPath === candidate.path) {
      return null;
    }
    return { path: candidate.path, status: candidate.status, previousPath: candidate.previousPath };
  }
  if (candidate.previousPath !== undefined) {
    return null;
  }
  return { path: candidate.path, status: candidate.status };
}

function isChangedFileManifestStatus(value: unknown): value is ChangedFileManifestStatus {
  return value === "added" || value === "modified" || value === "deleted" || value === "renamed";
}

function isManifestPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isPositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function overlapsChange(node: GraphNode, changed: ChangedRanges): boolean {
  const ranges = changed[normalizePath(node.location.file)];
  if (!ranges) {
    return false;
  }
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  return ranges.some((range) => range.start <= end && range.end >= start);
}

/** Containers whose span is the whole file (or a directory) — overlap says nothing about them. */
function isFileContainer(node: GraphNode): boolean {
  return node.kind === "module" || node.kind === "package";
}

function withChangedTag(node: GraphNode): GraphNode {
  if (node.tags?.includes(CHANGED_TAG)) {
    return node;
  }
  return { ...node, tags: [...(node.tags ?? []), CHANGED_TAG] };
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/");
}
