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
