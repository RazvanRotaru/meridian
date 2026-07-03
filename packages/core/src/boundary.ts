/**
 * Boundary-node materialization.
 *
 * When an extractor is asked to include external/unresolved call targets, those targets are
 * pseudo-ids (`ext:` / `unresolved:`) that reference nothing in the tree. This turns each into
 * a real leaf node grouped under a synthetic "External" container, so the renderer can draw
 * the honest boundary edges (dim/dashed) instead of silently dropping them. It runs after
 * depth collapse and is a no-op when no boundary targets are present.
 */

import { parseNodeId, type NodeIdParts } from "./ids";
import type { GraphEdge, GraphNode } from "./types";

export const EXTERNAL_CONTAINER_ID = "ext:__external__";
const EXTERNAL_KIND = "external";
const UNRESOLVED_KIND = "unresolved";

export function materializeBoundaryNodes(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const known = new Set(nodes.map((node) => node.id));
  const targets = boundaryTargets(edges, known);
  if (targets.length === 0) {
    return nodes;
  }
  return [...nodes, externalContainer(), ...targets.map(boundaryLeaf)];
}

function boundaryTargets(edges: GraphEdge[], known: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!known.has(edge.target) && isBoundaryId(edge.target)) {
      seen.add(edge.target);
    }
  }
  return [...seen].sort();
}

function isBoundaryId(id: string): boolean {
  const lang = id.slice(0, id.indexOf(":"));
  return lang === "ext" || lang === "unresolved";
}

function externalContainer(): GraphNode {
  return {
    id: EXTERNAL_CONTAINER_ID,
    kind: EXTERNAL_KIND,
    qualifiedName: "External",
    displayName: "External",
    parentId: null,
    location: { file: "", startLine: 1 },
    summary: "calls that leave the analyzed code — libraries, builtins, dynamic targets",
  };
}

function boundaryLeaf(id: string): GraphNode {
  const parts = parseNodeId(id);
  const unresolved = parts.lang === "unresolved";
  const label = boundaryLabel(parts, unresolved);
  return {
    id,
    kind: unresolved ? UNRESOLVED_KIND : EXTERNAL_KIND,
    qualifiedName: label,
    displayName: label,
    parentId: EXTERNAL_CONTAINER_ID,
    location: { file: parts.modulePath, startLine: 1 },
    summary: unresolved ? "dynamic or unresolved call target" : `external · ${parts.modulePath}`,
  };
}

function boundaryLabel(parts: NodeIdParts, unresolved: boolean): string {
  if (unresolved) {
    return "unresolved";
  }
  return parts.qualname ?? parts.modulePath;
}
