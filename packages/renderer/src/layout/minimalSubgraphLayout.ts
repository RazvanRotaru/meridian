/**
 * Lay out a MinimalSubgraphSpec with ELK and map it to React Flow — the PR-review analog of
 * `moduleLevelLayout`, but NESTED: package/collapsed-chain frames recurse as ELK containers with
 * title-bar padding, file cards are leaves at a fixed size. The nesting, the root-only
 * `hierarchyHandling` contract and the parent-relative mapping live in `elkNesting`; this module only
 * supplies the review adapter, layout options and edge styling. Boundary file cards carry an
 * `isBoundary` flag and boundary-touching wires a `toBoundary` flag so the graph pane can render the
 * faded 1-hop context dimmed + dashed. Deterministic — ELK layered is stable, no Math.random/Date.
 */

import type { Edge, Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import { runElkLayout } from "./elkLayout";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";
import type { MinimalSubgraphEdge, MinimalSubgraphNode, MinimalSubgraphSpec } from "../derive/minimalSubgraph";
import type { ModuleCardData } from "../derive/moduleLevel";
import type { ModulePackageData } from "../derive/packageOverview";
import { arrowMarker } from "../theme/edgeColors";
import { REVIEW_COLORS } from "../theme/reviewColors";

/** The React Flow node type keys the graph pane registers (its own review-aware card components). */
export const REVIEW_FILE_NODE = "reviewFile";
export const REVIEW_GROUP_NODE = "reviewGroup";

/** A file card's data: the Module-map file shape plus whether it's a faded boundary neighbour. */
export type ReviewFileNodeData = ModuleCardData & { isBoundary: boolean };
/** A frame's data: the Module-map package shape plus the joined label of a collapsed chain, if any. */
export type ReviewGroupNodeData = ModulePackageData & { collapsedLabel?: string };
export type ReviewNodeData = ReviewFileNodeData | ReviewGroupNodeData;
/** An import wire's data: its multiplicity and whether it touches a boundary node (paint faded). */
export type ReviewEdgeData = { weight: number; toBoundary: boolean };

const FILE_WIDTH = 210;
const FILE_HEIGHT = 54;

// Layered left→right so importers sit left of what they import, with root-only INCLUDE_CHILDREN so a
// wire routes across frame boundaries. Mirrors the composition/logic surfaces so the lenses feel alike.
const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "90",
  "elk.spacing.nodeNode": "40",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// Top padding clears a frame's title bar (React Flow draws nothing there itself).
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=42,left=16,bottom=16,right=16]",
};

const adapter: ElkNestAdapter<MinimalSubgraphNode> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.kind === "group",
  leafSize: () => ({ width: FILE_WIDTH, height: FILE_HEIGHT }),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
};

/** Build the nested ELK graph, run it, and map the placed tree back to React Flow nodes/edges. */
export async function layoutMinimalSubgraph(spec: MinimalSubgraphSpec): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (spec.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }
  const laid = await runElkLayout(buildNestedElkGraph(spec.nodes, spec.edges, adapter, ROOT_LAYOUT_OPTIONS));
  const specById = new Map(spec.nodes.map((node) => [node.id, node]));
  const boundaryIds = new Set(spec.nodes.filter((node) => node.isBoundary).map((node) => node.id));
  const nodes = emitReactFlowNodes(laid, (elkNode, parentId) => {
    const node = specById.get(elkNode.id);
    return node ? toRfNode(elkNode, parentId, node) : null;
  });
  return { nodes, edges: spec.edges.map((edge) => toRfEdge(edge, boundaryIds)) };
}

function toRfNode(elkNode: ElkNode, parentId: string | undefined, node: MinimalSubgraphNode): Node {
  return {
    id: node.id,
    type: node.kind === "group" ? REVIEW_GROUP_NODE : REVIEW_FILE_NODE,
    ...parentRelativePlacement(elkNode, parentId),
    data: node.kind === "group" ? groupData(node) : fileData(node),
  };
}

function groupData(node: MinimalSubgraphNode): ReviewGroupNodeData {
  return { ...(node.data as ModulePackageData), collapsedLabel: node.collapsedLabel };
}

function fileData(node: MinimalSubgraphNode): ReviewFileNodeData {
  return { ...(node.data as ModuleCardData), isBoundary: node.isBoundary };
}

// A boundary-touching wire is the faded context/blast-radius link (thin, dashed, dimmed); an
// affected↔affected wire is the solid signal. The graph pane re-paints emphasis on row selection.
function toRfEdge(edge: MinimalSubgraphEdge, boundaryIds: ReadonlySet<string>): Edge {
  const toBoundary = boundaryIds.has(edge.source) || boundaryIds.has(edge.target);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    style: {
      stroke: REVIEW_COLORS.edge,
      strokeWidth: toBoundary ? 1 : 1.5,
      opacity: toBoundary ? 0.5 : 0.85,
      ...(toBoundary ? { strokeDasharray: "4 3" } : {}),
    },
    markerEnd: arrowMarker(REVIEW_COLORS.edge, 14),
    data: { weight: edge.weight, toBoundary } satisfies ReviewEdgeData,
  };
}
