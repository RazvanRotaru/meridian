/**
 * The minimal PR-review graph, at CODE-BLOCK granularity (not files).
 *
 * `computeAffectedNodes` (core) names every node whose source range overlaps the PR's changed lines.
 * This module turns that flat set into a nested containment graph the way the rest of the renderer
 * models structure — by `parentId`: a changed method nests inside its (also-overlapping) class frame,
 * which nests inside a synthetic file frame. Frames are NOT "changed blocks" themselves — they exist
 * only to group the leaves — so a class never lights up merely because one of its methods was edited;
 * it shows a "N changed" count instead. The leaves ARE the affected code blocks the user asked to see.
 *
 * Edges are the resolved call/reference relations that run directly BETWEEN two affected leaves, so
 * the graph shows how the changed pieces relate. Everything is pure (no React, no ELK).
 */

import { computeAffectedNodes, unmappedChangedFiles } from "@meridian/core";
import type { ChangedFile, ChangeStatus, GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

/** Behavioural relations worth drawing between two changed blocks (class-hierarchy edges excluded). */
const CALL_EDGE_KINDS: ReadonlySet<string> = new Set(["calls", "instantiates", "references", "sends", "handles"]);

export type ReviewNodeKind = "reviewFile" | "reviewGroup" | "reviewBlock";

// `type` (not interface) so it carries @xyflow/react's implicit index signature on Node<T>.
export type ReviewNodeData = {
  /** The artifact node id (frames use their synthetic id); the graph/panel coupling key for leaves. */
  nodeId: string | null;
  label: string;
  /** file:line for a leaf; the path for a file frame; the enclosing kind for a group. */
  sublabel: string;
  /** Artifact node kind (function/method/class…) for the accent; file/group frames use their own. */
  nodeKind: string;
  file: string;
  status: ChangeStatus | null;
  isTest: boolean;
  /** Frames only: how many affected leaf blocks nest inside. */
  changedCount: number;
};

export interface ReviewGraphNode {
  id: string;
  parentId: string | null;
  kind: ReviewNodeKind;
  isContainer: boolean;
  data: ReviewNodeData;
}

export interface ReviewNodeEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
}

export interface ReviewNodeGraph {
  nodes: ReviewGraphNode[];
  edges: ReviewNodeEdge[];
  /** Artifact node ids that are affected — the coupling set the side panel highlights against. */
  affectedIds: Set<string>;
  /** Changed files that produced no block (deleted, not-extracted, or edits outside any block). */
  unmapped: ChangedFile[];
}

const FILE_FRAME_PREFIX = "revfile:";

export function deriveReviewNodeGraph(index: GraphIndex, changedFiles: readonly ChangedFile[]): ReviewNodeGraph {
  const allNodes = [...index.nodesById.values()];
  const affected = computeAffectedNodes(allNodes, changedFiles);
  const affectedIds = new Set(affected.map((a) => a.nodeId));
  const statusByFile = new Map(changedFiles.map((file) => [file.path, file.status]));

  const leafIds = new Set(affected.filter((a) => !hasAffectedChild(a.nodeId, index, affectedIds)).map((a) => a.nodeId));
  const nodes = buildNodes(affected, leafIds, index, affectedIds, statusByFile);
  const edges = buildEdges(index, leafIds);
  return { nodes, edges, affectedIds, unmapped: unmappedChangedFiles(affected, changedFiles) };
}

/** A node is a FRAME (container) when at least one of its children is itself affected. */
function hasAffectedChild(nodeId: string, index: GraphIndex, affectedIds: ReadonlySet<string>): boolean {
  return index.childrenOf(nodeId).some((child) => affectedIds.has(child.id));
}

function buildNodes(
  affected: ReturnType<typeof computeAffectedNodes>,
  leafIds: ReadonlySet<string>,
  index: GraphIndex,
  affectedIds: ReadonlySet<string>,
  statusByFile: Map<string, ChangeStatus>,
): ReviewGraphNode[] {
  const fileFrames = new Map<string, ReviewGraphNode>();
  const blocks: ReviewGraphNode[] = [];
  for (const item of affected) {
    const node = index.nodesById.get(item.nodeId);
    if (!node) {
      continue;
    }
    ensureFileFrame(fileFrames, node.location.file, statusByFile);
    blocks.push(blockNode(node, leafIds.has(node.id), index, affectedIds, item.status));
  }
  stampFrameCounts(fileFrames, blocks, leafIds);
  // File frames first so React Flow always sees a parent before its children.
  return [...fileFrames.values(), ...blocks];
}

function ensureFileFrame(frames: Map<string, ReviewGraphNode>, file: string, statusByFile: Map<string, ChangeStatus>): void {
  if (frames.has(file)) {
    return;
  }
  frames.set(file, {
    id: FILE_FRAME_PREFIX + file,
    parentId: null,
    kind: "reviewFile",
    isContainer: true,
    data: {
      nodeId: null,
      label: basename(file),
      sublabel: dirname(file),
      nodeKind: "file",
      file,
      status: statusByFile.get(file) ?? null,
      isTest: false,
      changedCount: 0,
    },
  });
}

/** A leaf block, or a group frame (its parent is the nearest affected ancestor, else the file frame). */
function blockNode(
  node: GraphNode,
  isLeaf: boolean,
  index: GraphIndex,
  affectedIds: ReadonlySet<string>,
  status: ChangeStatus,
): ReviewGraphNode {
  const parentId = reviewParentId(node, index, affectedIds);
  return {
    id: node.id,
    parentId,
    kind: isLeaf ? "reviewBlock" : "reviewGroup",
    isContainer: !isLeaf,
    data: {
      nodeId: node.id,
      label: node.displayName,
      sublabel: `${basename(node.location.file)}:${node.location.startLine}`,
      nodeKind: node.kind,
      file: node.location.file,
      // A frame is not itself "changed" — only leaves carry a status badge.
      status: isLeaf ? status : null,
      isTest: index.testIds.has(node.id),
      changedCount: 0,
    },
  };
}

/** Nearest ancestor that is itself affected; failing that, the file frame. Guards a parentId cycle. */
function reviewParentId(node: GraphNode, index: GraphIndex, affectedIds: ReadonlySet<string>): string {
  const seen = new Set<string>([node.id]);
  let current = index.parentOf.get(node.id) ?? null;
  while (current && !seen.has(current)) {
    if (affectedIds.has(current)) {
      return current;
    }
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return FILE_FRAME_PREFIX + node.location.file;
}

/** Each frame counts the affected LEAF blocks anywhere beneath it (its own file, transitively). */
function stampFrameCounts(frames: Map<string, ReviewGraphNode>, blocks: ReviewGraphNode[], leafIds: ReadonlySet<string>): void {
  const groupById = new Map(blocks.filter((b) => b.isContainer).map((b) => [b.id, b]));
  for (const block of blocks) {
    if (!leafIds.has(block.id)) {
      continue;
    }
    const frame = frames.get(block.data.file);
    if (frame) {
      frame.data.changedCount++;
    }
    // Walk group ancestors to bump their counts too.
    let parent = block.parentId;
    while (parent) {
      const group = groupById.get(parent);
      if (!group) {
        break;
      }
      group.data.changedCount++;
      parent = group.parentId;
    }
  }
}

/** Resolved behavioural edges that run directly between two affected LEAF blocks; deduped. */
function buildEdges(index: GraphIndex, leafIds: ReadonlySet<string>): ReviewNodeEdge[] {
  const seen = new Set<string>();
  const edges: ReviewNodeEdge[] = [];
  for (const edge of index.edges) {
    if (edge.resolution !== "resolved" || !CALL_EDGE_KINDS.has(edge.kind)) {
      continue;
    }
    if (!leafIds.has(edge.source) || !leafIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push({ id: `rev:${key}`, source: edge.source, target: edge.target, kind: edge.kind });
  }
  return edges;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
