/**
 * "Which logic flows does this PR directly touch?" — the pure predicate behind the review checklist.
 *
 * A flow is affected when either the flow's OWN file changed, or it directly CALLS into a changed
 * file. "Directly" is literal: only `resolution === "resolved"` call targets that point at a real,
 * non-boundary, non-package node count — external/unresolved targets are honest guesses (their
 * `location.file` is an external module name, not a repo path), and transitive closure would explode
 * the list. The walk is iterative (an explicit stack) so a deeply nested flow can never blow the
 * call stack. Lives in core so the renderer and any future CLI report share one tested implementation.
 */

import { parseNodeId } from "./ids";
import type { GraphNode, NodeId } from "./types";
import type { FlowStep, LogicFlows } from "./flow";

export interface AffectedFlow {
  flowId: NodeId;
  /** location.file of the flow's owning node; null for missing/package/boundary owners. */
  ownerFile: string | null;
  ownerChanged: boolean;
  /** Changed files among RESOLVED, non-boundary call targets. Deduped, sorted asc. */
  changedFilesHit: string[];
}

/**
 * A flow is affected iff its owner file changed OR it directly calls (resolution === "resolved",
 * target !== null, !isBoundaryId(target), target not package-kind) into a changed file.
 * Iterative walk over call | loop.body | callback.body | branch.paths[].body.
 * Sorted: ownerChanged desc → ownerFile asc (nulls last) → owner startLine asc → flowId asc.
 */
export function computeAffectedFlows(
  nodes: readonly GraphNode[],
  flows: LogicFlows,
  changedPaths: ReadonlySet<string>,
): AffectedFlow[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const fileOf = (id: NodeId): string | null => repoFileOf(id, nodesById);

  const affected: AffectedFlow[] = [];
  for (const [flowId, steps] of Object.entries(flows)) {
    const ownerFile = fileOf(flowId);
    const ownerChanged = ownerFile !== null && changedPaths.has(ownerFile);
    const hits = collectChangedHits(steps, fileOf, changedPaths);
    if (ownerChanged || hits.size > 0) {
      affected.push({ flowId, ownerFile, ownerChanged, changedFilesHit: [...hits].sort() });
    }
  }
  return sortAffected(affected, nodesById);
}

/** The repo file a node lives in, or null when the id names nothing joinable to a source file. */
function repoFileOf(id: NodeId, nodesById: Map<NodeId, GraphNode>): string | null {
  if (isBoundaryId(id)) {
    return null;
  }
  const node = nodesById.get(id);
  if (!node || node.kind === "package") {
    return null;
  }
  return node.location.file;
}

/** Walk a flow's step tree, collecting the changed files it directly calls into. */
function collectChangedHits(
  steps: readonly FlowStep[],
  fileOf: (id: NodeId) => string | null,
  changedPaths: ReadonlySet<string>,
): Set<string> {
  const hits = new Set<string>();
  const stack: FlowStep[] = [...steps];
  let step: FlowStep | undefined;
  while ((step = stack.pop()) !== undefined) {
    if (step.kind === "call") {
      addCallHit(step, fileOf, changedPaths, hits);
    } else if (step.kind === "loop" || step.kind === "callback") {
      stack.push(...step.body);
    } else if (step.kind === "branch") {
      for (const path of step.paths) {
        stack.push(...path.body);
      }
    }
  }
  return hits;
}

function addCallHit(
  step: Extract<FlowStep, { kind: "call" }>,
  fileOf: (id: NodeId) => string | null,
  changedPaths: ReadonlySet<string>,
  hits: Set<string>,
): void {
  if (step.resolution !== "resolved" || step.target === null || isBoundaryId(step.target)) {
    return;
  }
  const file = fileOf(step.target);
  if (file !== null && changedPaths.has(file)) {
    hits.add(file);
  }
}

/** ext:/unresolved: pseudo-ids point at an external module name, never a repo file. */
function isBoundaryId(id: NodeId): boolean {
  const lang = parseNodeId(id).lang;
  return lang === "ext" || lang === "unresolved";
}

function sortAffected(affected: AffectedFlow[], nodesById: Map<NodeId, GraphNode>): AffectedFlow[] {
  return affected.sort((a, b) => {
    if (a.ownerChanged !== b.ownerChanged) {
      return a.ownerChanged ? -1 : 1;
    }
    const byFile = compareNullableAsc(a.ownerFile, b.ownerFile);
    if (byFile !== 0) {
      return byFile;
    }
    const byLine = startLineOf(a.flowId, nodesById) - startLineOf(b.flowId, nodesById);
    if (byLine !== 0) {
      return byLine;
    }
    return compareStringAsc(a.flowId, b.flowId);
  });
}

/** Ascending, with nulls sorted last. */
function compareNullableAsc(a: string | null, b: string | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return compareStringAsc(a, b);
}

function compareStringAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function startLineOf(id: NodeId, nodesById: Map<NodeId, GraphNode>): number {
  return nodesById.get(id)?.location.startLine ?? 0;
}

/**
 * FNV-1a 32-bit hex over JSON.stringify(steps). Browser-clean; change-detection, not security.
 *
 * `Math.imul` does the 32-bit multiply correctly — a plain `h * prime` overflows Number's 53-bit
 * integer precision (prime ≈ 2^24, h up to 2^32 ⇒ product up to 2^56) and silently corrupts the
 * low bits the hash depends on. Only this function ever produces these values, so the exact
 * algorithm need only be deterministic and change-sensitive.
 */
export function flowFingerprint(steps: readonly FlowStep[]): string {
  const json = JSON.stringify(steps);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
