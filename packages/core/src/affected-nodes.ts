/**
 * "Which CODE BLOCKS did this PR touch?" — the pure predicate behind the minimal review graph.
 *
 * A changed file names a set of nodes, but showing every node in a 500-line file is not "minimal".
 * The unit is the LEAF block: a childless node is affected when its source range overlaps one of the
 * file's changed line ranges (`ChangedFile.hunks`). Containers (class/interface/…) are NOT marked
 * off their whole-body span — a one-method edit would ring every sibling — their ring and "Δ n"
 * come from upward aggregation on the read side. A container still marks itself when a hunk touches
 * its OWN lines (inside its span but outside every child's, e.g. only the declaration line changed),
 * else that edit would vanish. Overlap uses the post-image line numbers on both sides (the diff's
 * `+` hunks and `node.location`, since we extract the very tree the diff describes).
 *
 * When a file carries no hunks — an untracked add, an explicit `--changed` entry, or a diff GitHub
 * omitted (binary/oversized) — the honest fallback is the file's MODULE node only, mirroring
 * `tagChangedNodes`' module fallback: blanket-marking every block would over-mark code the PR never
 * touched. Otherwise `package`/`module` nodes never qualify — they are the file/directory containers
 * the user explicitly does NOT want as the unit — and `ext:`/`unresolved:` pseudo-nodes have no repo
 * file. Lives in core so the renderer graph and any future CLI report share one tested implementation.
 */

import { parseNodeId } from "./ids";
import type { ChangedFile, ChangeStatus, LineRange } from "./review";
import type { GraphNode, NodeId } from "./types";

export interface AffectedNode {
  nodeId: NodeId;
  /** Status of the file the node lives in. */
  status: ChangeStatus;
  file: string;
  /** True when the file carried hunks and this node overlapped one (vs. a whole-file fallback). */
  overlapsHunk: boolean;
}

/** Node kinds that are never a "code block": file/directory containers and boundary pseudo-nodes.
 * Exported so downstream views (e.g. the renderer's files checklist) share ONE container vocabulary. */
export const NON_BLOCK_KINDS: ReadonlySet<string> = new Set(["package", "module"]);

/** THE inclusive line-range overlap predicate — every hunk∩span decision must go through this one
 * implementation (graph highlight, checklist fingerprints, comment anchors), so they never drift. */
export function rangesOverlap(start: number, end: number, range: LineRange): boolean {
  return start <= range.end && end >= range.start;
}

/**
 * The changed code blocks, sorted file asc → id asc (a stable, readable order for both the graph
 * and any list). A node with no `location.file` in the changed set is skipped.
 */
export function computeAffectedNodes(
  nodes: readonly GraphNode[],
  changedFiles: readonly ChangedFile[],
): AffectedNode[] {
  const statusByFile = new Map(changedFiles.map((file) => [file.path, file.status]));
  const hunksByFile = new Map(changedFiles.map((file) => [file.path, file.hunks]));
  const childSpans = childSpansByParent(nodes);
  const affected: AffectedNode[] = [];
  for (const node of nodes) {
    const file = node.location.file;
    const status = statusByFile.get(file);
    if (status === undefined) {
      continue;
    }
    const hunks = hunksByFile.get(file);
    if (hunks === undefined) {
      // Hunk-less fallback: the module node ALONE carries the "this file changed" signal, so it must
      // slip past NON_BLOCK_KINDS here — without it a hunk-less file's card would never ring.
      if (node.kind === "module") {
        affected.push({ nodeId: node.id, status, file, overlapsHunk: false });
      }
      continue;
    }
    if (isBlockKind(node) && marksFromHunks(node, hunks, childSpans.get(node.id))) {
      affected.push({ nodeId: node.id, status, file, overlapsHunk: true });
    }
  }
  return sortAffected(affected);
}

/**
 * Files that changed but contributed NO affected code block: a deletion (its nodes are gone from the
 * freshly-extracted tree), a file the extractor didn't cover, or edits that fell entirely outside any
 * extracted block (e.g. import lines, comments). The renderer lists these so a reviewer never assumes
 * a changed file was silently dropped.
 */
export function unmappedChangedFiles(
  affected: readonly AffectedNode[],
  changedFiles: readonly ChangedFile[],
): ChangedFile[] {
  const covered = new Set(affected.map((node) => node.file));
  return changedFiles.filter((file) => !covered.has(file.path));
}

function isBlockKind(node: GraphNode): boolean {
  if (NON_BLOCK_KINDS.has(node.kind)) {
    return false;
  }
  const lang = parseNodeId(node.id).lang;
  return lang !== "ext" && lang !== "unresolved";
}

/** A leaf marks on plain span overlap; a container only when a hunk touches its OWN (non-child) lines. */
function marksFromHunks(
  node: GraphNode,
  hunks: readonly LineRange[],
  childSpans: readonly LineRange[] | undefined,
): boolean {
  const start = node.location.startLine;
  const end = node.location.endLine ?? start;
  if (childSpans === undefined) {
    return hunks.some((hunk) => rangesOverlap(start, end, hunk));
  }
  return hunks.some((hunk) => touchesOwnLines(hunk, start, end, childSpans));
}

/** True when hunk ∩ [start, end] is non-empty and at least one of its lines escapes every child span. */
function touchesOwnLines(hunk: LineRange, start: number, end: number, childSpans: readonly LineRange[]): boolean {
  const from = Math.max(hunk.start, start);
  const to = Math.min(hunk.end, end);
  return from <= to && !coveredBySpans(from, to, childSpans);
}

/** Interval cover over spans sorted by start: does their union contain every line of [from, to]? */
function coveredBySpans(from: number, to: number, spans: readonly LineRange[]): boolean {
  let cursor = from;
  for (const span of spans) {
    if (span.start > cursor) {
      return false; // sorted by start, so nothing later can cover the gap at `cursor`
    }
    if (span.end >= cursor) {
      cursor = span.end + 1;
    }
    if (cursor > to) {
      return true;
    }
  }
  return cursor > to;
}

/** Direct-child source spans per parent id, sorted by start — the "not my own lines" mask. */
function childSpansByParent(nodes: readonly GraphNode[]): Map<string, LineRange[]> {
  const spans = new Map<string, LineRange[]>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const list = spans.get(node.parentId) ?? [];
    list.push({ start: node.location.startLine, end: node.location.endLine ?? node.location.startLine });
    spans.set(node.parentId, list);
  }
  for (const list of spans.values()) {
    list.sort((a, b) => a.start - b.start);
  }
  return spans;
}

function sortAffected(affected: AffectedNode[]): AffectedNode[] {
  return affected.sort((a, b) => {
    if (a.file !== b.file) {
      return a.file < b.file ? -1 : 1;
    }
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}
