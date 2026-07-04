/**
 * Lay out a CompositionGraphSpec with ELK and map it to React Flow — the composition-tab analog of
 * `logicElk`. Unit scorecards nest inside their package CLUSTER FRAMES: a frame recurses as an ELK
 * container carrying title-bar padding; each unit is a leaf at its scorecard size. The nesting
 * helper, root-only `hierarchyHandling` contract and parent-relative mapping live in `elkNesting`;
 * this module supplies the composition adapter, layout options and edge styling.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ClusterNodeData, CompEdgeSpec, CompNodeData, CompNodeSpec, CompNodeType, CompositionGraphSpec } from "../derive/compositionGraph";
import { arrowMarker } from "../theme/edgeColors";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";

export type CompRfNode = Node<CompNodeData | ClusterNodeData, CompNodeType>;
export type CompRfEdgeData = { inheritanceOnly: boolean; crossBoundary: boolean; changeCoupling: boolean };
export type CompRfEdge = Edge<CompRfEdgeData>;
export interface CompositionReactFlowGraph {
  nodes: CompRfNode[];
  edges: CompRfEdge[];
}

// Shared with the logic layout: layered left→right so efferent wires read as "depends on the unit
// to my right", with root-only INCLUDE_CHILDREN so wires route across frame boundaries. Spacing
// values mirror logic's so the two graph surfaces feel of a piece.
const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "36",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// Top padding clears the cluster frame's title bar (React Flow draws nothing there itself) — matches
// logic's container padding so the two nested surfaces feel of a piece.
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=42,left=16,bottom=16,right=16]",
};

// A cluster frame is the only container; every unit is a leaf carrying its scorecard size (the
// fallbacks are defensive — a unit spec always sets them).
const adapter: ElkNestAdapter<CompNodeSpec> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.type === "cluster",
  leafSize: (node) => ({ width: node.width ?? 240, height: node.height ?? 104 }),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
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

// The wire treatments, in priority order. A CO-CHANGE ghost is a suggestion, not a structural
// fact: dotted, low-opacity rose — apart from both the violet inheritance dash and the gold
// cross-boundary wire — and arrowless, because "changes together" is symmetric. An inheritance-only
// pair reads DISTINCT — dashed violet — because extends/implements is a different relationship from
// ordinary use. Otherwise a SAME-cluster wire is expected cohesion: muted grey, thin, low opacity,
// it recedes. A wire that CROSSES a frame boundary is the packaging (Common-Closure) signal, so
// it's emphasized in a warm signal colour, thicker, full opacity. Never animated: this is
// structure, not a live flow.
const CHANGE_COUPLING_COLOR = "#D97BB6";
const INHERITANCE_COLOR = "#A78BFA";
const INTERNAL_COLOR = "#4A5261";
const CROSS_BOUNDARY_COLOR = "#C9A24B";
const DOTTED = "2 5";
const DASHED = "5 4";

interface EdgeStroke {
  color: string;
  width: number;
  opacity: number;
  dashArray?: string;
}

function strokeFor(edge: CompEdgeSpec): EdgeStroke {
  if (edge.changeCoupling) {
    return { color: CHANGE_COUPLING_COLOR, width: 1.25, opacity: 0.55, dashArray: DOTTED };
  }
  if (edge.inheritanceOnly) {
    return { color: INHERITANCE_COLOR, width: 1.5, opacity: 1, dashArray: DASHED };
  }
  if (edge.crossBoundary) {
    return { color: CROSS_BOUNDARY_COLOR, width: 1.75, opacity: 1 };
  }
  return { color: INTERNAL_COLOR, width: 1, opacity: 0.45 };
}

function toReactFlowEdge(edge: CompEdgeSpec): CompRfEdge {
  const stroke = strokeFor(edge);
  const changeCoupling = edge.changeCoupling === true;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: false,
    style: {
      stroke: stroke.color,
      strokeWidth: stroke.width,
      opacity: stroke.opacity,
      ...(stroke.dashArray ? { strokeDasharray: stroke.dashArray } : {}),
    },
    // Co-change is symmetric, so a ghost wire carries no arrowhead.
    markerEnd: changeCoupling ? undefined : arrowMarker(stroke.color, 14),
    data: { inheritanceOnly: edge.inheritanceOnly, crossBoundary: edge.crossBoundary, changeCoupling },
  };
}
