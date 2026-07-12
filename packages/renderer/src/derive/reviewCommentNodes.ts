/**
 * Project PR-review comments onto graph identities. Draft line anchors and GitHub RIGHT-side
 * comments use current/new-side coordinates, so only a graph in that same coordinate space can
 * safely attach them to a code node; the live synchronous base fallback keeps them at file level.
 * Exact owners stay separate from visible representatives so collapsed containers can carry them.
 */

import type { GraphNode } from "@meridian/core";
import type { Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { PrGitHubComment } from "../state/prTypes";
import type { ReviewComment } from "../state/reviewTicksPref";
import type { ReviewFileRow } from "./reviewFiles";
import { isSourceBackedNode } from "./sourceBackedNode";

export interface ReviewCommentNodeEvidence {
  draftCount: number;
  existingCount: number;
}

export interface ReviewCommentNodeInput {
  drafts: readonly ReviewComment[];
  existingComments: readonly PrGitHubComment[];
  existingCommentsVisible: boolean;
  files: readonly ReviewFileRow[];
  index: GraphIndex;
  /** True for prepared PR graphs and artifact-sourced reviews whose nodes already use comment lines. */
  lineCoordinatesMatchGraph: boolean;
}

interface FileTarget {
  moduleId: string;
  graphPath: string;
}

/** Resolve each comment to exactly one canonical graph node. */
export function deriveReviewCommentNodeEvidence(input: ReviewCommentNodeInput): Map<string, ReviewCommentNodeEvidence> {
  const targetsByPath = fileTargets(input.files, input.index);
  let nodesByFile: Map<string, GraphNode[]> | null = null;
  const headLineOwner = (path: string, line: number): string | null => {
    nodesByFile ??= sourceNodesByFile(input.index);
    return lineOwner(path, line, targetsByPath, nodesByFile, input.index);
  };
  const evidence = new Map<string, ReviewCommentNodeEvidence>();

  for (const draft of input.drafts) {
    // Drafts persist against the complete review context while projections (for example, hiding
    // tests) remove their file rows. Never let an exact nodeId bypass that projection and roll a
    // hidden draft up onto a still-visible ancestor.
    if (!targetsByPath.has(draft.path)) continue;
    const target = draft.line !== null
      ? draft.lineStale === true || !input.lineCoordinatesMatchGraph
        ? fileOwner(draft.path, targetsByPath)
        : headLineOwner(draft.path, draft.line)
      : draft.nodeId !== null && input.index.nodesById.has(draft.nodeId)
        ? draft.nodeId
        : fileOwner(draft.path, targetsByPath);
    addEvidence(evidence, target, "draftCount");
  }

  if (input.existingCommentsVisible) {
    for (const comment of input.existingComments) {
      // Only RIGHT-side lines describe the HEAD graph. Old-side or anchorless discussion still
      // belongs to the file, but must never point at unrelated current code.
      const target = input.lineCoordinatesMatchGraph && comment.side === "RIGHT" && comment.line !== null
        ? headLineOwner(comment.path, comment.line)
        : fileOwner(comment.path, targetsByPath);
      addEvidence(evidence, target, "existingCount");
    }
  }
  return evidence;
}

/** Roll exact owners up to one representative in every mounted semantic-depth population. */
export function projectReviewCommentNodeEvidence(
  evidence: ReadonlyMap<string, ReviewCommentNodeEvidence>,
  visibleNodes: readonly Node[],
  index: GraphIndex,
): Map<string, ReviewCommentNodeEvidence> {
  if (evidence.size === 0) return new Map();
  const projected = new Map<string, ReviewCommentNodeEvidence>();
  const populations = visibleNodePopulations(visibleNodes);
  for (const [sourceId, counts] of evidence) {
    const projectedTargets = new Set<string>();
    for (const visibleIds of populations.values()) {
      const target = visibleRepresentative(sourceId, visibleIds, index);
      if (target === null || projectedTargets.has(target)) continue;
      projectedTargets.add(target);
      const current = projected.get(target) ?? { draftCount: 0, existingCount: 0 };
      projected.set(target, {
        draftCount: current.draftCount + counts.draftCount,
        existingCount: current.existingCount + counts.existingCount,
      });
    }
  }
  return projected;
}

function fileTargets(files: readonly ReviewFileRow[], index: GraphIndex): Map<string, FileTarget> {
  const targets = new Map<string, FileTarget>();
  for (const file of files) {
    if (file.moduleId === null) continue;
    const module = index.nodesById.get(file.moduleId);
    if (!module) continue;
    const target = { moduleId: file.moduleId, graphPath: module.location.file };
    targets.set(file.path, target);
    if (!targets.has(target.graphPath)) targets.set(target.graphPath, target);
  }
  return targets;
}

function sourceNodesByFile(index: GraphIndex): Map<string, GraphNode[]> {
  const byFile = new Map<string, GraphNode[]>();
  for (const node of index.nodesById.values()) {
    if (!isSourceBackedNode(node)) continue;
    const peers = byFile.get(node.location.file);
    peers ? peers.push(node) : byFile.set(node.location.file, [node]);
  }
  return byFile;
}

function lineOwner(
  path: string,
  line: number,
  targetsByPath: ReadonlyMap<string, FileTarget>,
  nodesByFile: ReadonlyMap<string, readonly GraphNode[]>,
  index: GraphIndex,
): string | null {
  const file = targetsByPath.get(path);
  if (!file) return null;
  let best: { id: string; depth: number; width: number } | null = null;
  for (const node of nodesByFile.get(file.graphPath) ?? []) {
    const start = node.location.startLine;
    const end = node.location.endLine ?? start;
    if (line < start || line > end) continue;
    const candidate = { id: node.id, depth: index.ancestorsOf(node.id).length, width: end - start };
    if (best === null || candidate.depth > best.depth || (candidate.depth === best.depth && candidate.width < best.width)) {
      best = candidate;
    }
  }
  return best?.id ?? file.moduleId;
}

function fileOwner(path: string, targetsByPath: ReadonlyMap<string, FileTarget>): string | null {
  return targetsByPath.get(path)?.moduleId ?? null;
}

function addEvidence(
  evidence: Map<string, ReviewCommentNodeEvidence>,
  nodeId: string | null,
  kind: keyof ReviewCommentNodeEvidence,
): void {
  if (nodeId === null) return;
  const current = evidence.get(nodeId) ?? { draftCount: 0, existingCount: 0 };
  evidence.set(nodeId, { ...current, [kind]: current[kind] + 1 });
}

function visibleNodePopulations(nodes: readonly Node[]): Map<string, Set<string>> {
  const populations = new Map<string, Set<string>>();
  for (const node of nodes) {
    const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
    const key = typeof depth === "number" && Number.isFinite(depth) ? `depth:${depth}` : "default";
    const ids = populations.get(key) ?? new Set<string>();
    ids.add(node.id);
    populations.set(key, ids);
  }
  return populations;
}

function visibleRepresentative(sourceId: string, visibleIds: ReadonlySet<string>, index: GraphIndex): string | null {
  const seen = new Set<string>();
  let current: string | null = sourceId;
  while (current !== null && !seen.has(current)) {
    if (visibleIds.has(current)) return current;
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return null;
}
