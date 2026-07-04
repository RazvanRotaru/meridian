/**
 * Lay out a CompositionGraphSpec with ELK and map it to React Flow — the composition-tab analog of
 * `logicElk`. This PR is a FLAT graph (module cluster frames land in PR3), so nothing is a
 * container: every unit lays out at its scorecard size and no node carries a parentId. The nesting
 * helper, root-only layout contract and parent-relative mapping live in `elkNesting`; this module
 * supplies the composition adapter, layout options and edge styling.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { CompEdgeSpec, CompNodeData, CompNodeSpec, CompNodeType, CompositionGraphSpec } from "../derive/compositionGraph";
import { arrowMarker } from "../theme/edgeColors";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";

export type CompRfNode = Node<CompNodeData, CompNodeType>;
export type CompRfEdgeData = { inheritanceOnly: boolean };
export type CompRfEdge = Edge<CompRfEdgeData>;
export interface CompositionReactFlowGraph {
  nodes: CompRfNode[];
  edges: CompRfEdge[];
}

// Shared with the logic layout: layered left→right so efferent wires read as "depends on the unit
// to my right". Spacing values mirror logic's so the two graph surfaces feel of a piece.
const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "36",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// A flat graph this PR: no unit nests another, so nothing is a container and every node is a leaf
// carrying its spec size. `parentId` is always undefined; `containerOptions` is never consulted.
const adapter: ElkNestAdapter<CompNodeSpec> = {
  id: (node) => node.id,
  parentId: () => undefined,
  isContainer: () => false,
  leafSize: (node) => ({ width: node.width, height: node.height }),
  containerOptions: {},
};

export function buildCompositionElkGraph(spec: CompositionGraphSpec): ElkNode {
  return buildNestedElkGraph(spec.nodes, spec.edges, adapter, ROOT_LAYOUT_OPTIONS);
}

export function toReactFlowComposition(
  laidOut: ElkNode,
  specById: Map<string, CompNodeSpec>,
  edges: CompEdgeSpec[],
): CompositionReactFlowGraph {
  const nodes = emitReactFlowNodes(laidOut, (elkNode, parentId) => {
    const spec = specById.get(elkNode.id);
    return spec ? toReactFlowNode(elkNode, parentId, spec) : null;
  });
  return { nodes, edges: edges.map(toReactFlowEdge) };
}

function toReactFlowNode(elkNode: ElkNode, parentId: string | undefined, spec: CompNodeSpec): CompRfNode {
  return {
    id: elkNode.id,
    type: spec.type,
    ...parentRelativePlacement(elkNode, parentId),
    data: spec.data,
  };
}

// A plain coupling wire is neutral steel with an arrow pointing source→target ("source depends on
// target"). An inheritance-only pair reads DISTINCT — dashed violet — because extends/implements is
// a different relationship from ordinary use. Never animated: this is structure, not a live flow.
const COUPLING_COLOR = "#5B6675";
const INHERITANCE_COLOR = "#A78BFA";

function toReactFlowEdge(edge: CompEdgeSpec): CompRfEdge {
  const color = edge.inheritanceOnly ? INHERITANCE_COLOR : COUPLING_COLOR;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: false,
    style: { stroke: color, strokeWidth: 1.5, ...(edge.inheritanceOnly ? { strokeDasharray: "5 4" } : {}) },
    markerEnd: arrowMarker(color, 14),
    data: { inheritanceOnly: edge.inheritanceOnly },
  };
}
