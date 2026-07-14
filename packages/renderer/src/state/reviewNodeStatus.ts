/**
 * Derive a review graph node's display colour from the changed lines inside that node, rather than
 * inheriting the containing file's coarse status. A modified file can contain a wholly new function;
 * that function is added (green), while a node with replacements or mixed edit kinds stays modified
 * (gold). The file status remains the honest fallback when exact line kinds are unavailable.
 */

import type {
  AffectedNode,
  ChangedDiffLines,
  ChangedLineKind,
  ChangedLineKinds,
  ChangedLineSpan,
  ChangeStatus,
  FlowSourceAnchor,
  GraphNode,
} from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { headSpanFor, mapBaseLineToHead } from "./headSpan";
import type { LineEdit } from "./prTypes";

export interface ReviewNodeStatusSource {
  /** Head-relative exact changed-line kinds for this file. */
  kinds: readonly ChangedLineSpan[];
  /** Present when graph nodes still use base coordinates and must be mapped to the PR head. */
  edits?: readonly LineEdit[];
}

export type ReviewNodeStatusSources = Readonly<Record<string, ReviewNodeStatusSource>>;

/** Adapt an artifact's own, same-coordinate `changedSince.kinds` into node-status sources. */
export function reviewNodeStatusSourcesFromKinds(kinds: ChangedLineKinds | null): ReviewNodeStatusSources {
  if (kinds === null) {
    return {};
  }
  return Object.fromEntries(Object.entries(kinds).map(([file, spans]) => [normalizePath(file), { kinds: spans }]));
}

/** Adapt display-accurate diff rows into graph-only status seams. Deleted rows have no HEAD line,
 * so their `beforeNewLine` cursor is used only here for node/flow colour attribution; source
 * rendering consumes the old-side row itself and never paints that surviving HEAD row red. */
export function reviewNodeStatusSourcesFromDiff(
  kinds: ChangedLineKinds | null,
  diffLines: ChangedDiffLines | null,
  editsByFile: Readonly<Record<string, readonly LineEdit[]>> = {},
): ReviewNodeStatusSources {
  const files = new Set([...Object.keys(kinds ?? {}), ...Object.keys(diffLines ?? {})]);
  return Object.fromEntries([...files].map((file) => {
    const spans = [...(kinds?.[file] ?? [])];
    for (const row of diffLines?.[file] ?? []) {
      if (row.kind === "deleted") {
        spans.push({ start: row.beforeNewLine, end: row.beforeNewLine, kind: "deleted" });
      } else if (!(kinds?.[file] ?? []).some((span) => span.start <= row.newLine! && span.end >= row.newLine!)) {
        spans.push({ start: row.newLine!, end: row.newLine!, kind: "added" });
      }
    }
    return [normalizePath(file), { kinds: spans, ...(editsByFile[file] ? { edits: editsByFile[file] } : {}) }];
  }));
}

/** Resolve the exact PR status at one flow-step source anchor. */
export function reviewSourceChangeStatus(
  source: FlowSourceAnchor | undefined,
  sources: ReviewNodeStatusSources,
): ChangeStatus | undefined {
  if (source === undefined) {
    return undefined;
  }
  const detail = sources[source.file] ?? sources[normalizePath(source.file)];
  if (detail === undefined) {
    return undefined;
  }
  const line = detail.edits === undefined ? source.line : mapBaseLineToHead(source.line, detail.edits);
  const observed = new Set<ChangedLineKind>();
  for (const span of detail.kinds) {
    if (span.start <= line && span.end >= line) {
      observed.add(span.kind);
    }
  }
  if (observed.size === 0) {
    return undefined;
  }
  if (observed.size > 1 || observed.has("modified")) {
    return "modified";
  }
  return observed.has("added") ? "added" : "deleted";
}

/** Produce the entries consumed by `applyChangedStatus`, preserving affected-node order. */
export function reviewNodeStatusEntries(
  index: GraphIndex,
  affected: readonly AffectedNode[],
  sources: ReviewNodeStatusSources,
): Array<[string, ChangeStatus]> {
  return affected.map((entry) => {
    const node = index.nodesById.get(entry.nodeId);
    const source = node === undefined
      ? undefined
      : sources[node.location.file] ?? sources[normalizePath(node.location.file)];
    return [
      entry.nodeId,
      reviewNodeChangeStatus(node, node === undefined ? [] : index.childrenOf(node.id), entry.status, source),
    ];
  });
}

/**
 * Classify one directly affected node. Only line kinds belonging to the node itself count: direct
 * child spans are masked so a class declaration added above a modified method can still read green.
 */
export function reviewNodeChangeStatus(
  node: GraphNode | undefined,
  children: readonly GraphNode[],
  fallback: ChangeStatus,
  source: ReviewNodeStatusSource | undefined,
): ChangeStatus {
  if (node === undefined || source === undefined || source.kinds.length === 0) {
    return fallback;
  }
  const nodeSpan = mappedSpan(node, source.edits);
  const childSpans = children
    .filter((child) => child.location.file === node.location.file)
    .map((child) => mappedSpan(child, source.edits))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const observed = new Set<ChangedLineKind>();
  for (const span of source.kinds) {
    const start = Math.max(span.start, nodeSpan.start);
    const end = Math.min(span.end, nodeSpan.end);
    if (start <= end && !coveredBySpans(start, end, childSpans)) {
      observed.add(span.kind);
    }
  }
  if (observed.size === 0) {
    return fallback;
  }
  if (observed.size > 1 || observed.has("modified")) {
    return "modified";
  }
  return observed.has("added") ? "added" : "deleted";
}

function mappedSpan(node: GraphNode, edits: readonly LineEdit[] | undefined): { start: number; end: number } {
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  return edits === undefined ? { start, end } : headSpanFor(start, end, edits);
}

/** Whether the sorted span union fully covers [start, end]. */
function coveredBySpans(start: number, end: number, spans: readonly { start: number; end: number }[]): boolean {
  let cursor = start;
  for (const span of spans) {
    if (span.start > cursor) {
      return false;
    }
    if (span.end >= cursor) {
      cursor = span.end + 1;
    }
    if (cursor > end) {
      return true;
    }
  }
  return cursor > end;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
