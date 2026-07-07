/**
 * Lay out a CompositionGraphSpec with ELK and map it to React Flow — the composition-tab analog of
 * `logicElk`. Unit scorecards nest inside their package CLUSTER FRAMES: a frame recurses as an ELK
 * container carrying title-bar padding; each unit is a leaf at its scorecard size. The nesting
 * helper, root-only `hierarchyHandling` contract and parent-relative mapping live in `elkNesting`;
 * this module supplies the composition adapter, layout options and edge styling.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ChannelCompData, ClusterNodeData, CompEdgeSpec, CompNodeData, CompNodeSpec, CompNodeType, CompositionGraphSpec, IpcChannelDetail } from "../derive/compositionGraph";
import type { PackageSummaryData } from "../derive/compositionAggregate";
import { arrowMarker, IPC_WIRE } from "../theme/edgeColors";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";

export type CompRfNode = Node<CompNodeData | ClusterNodeData | ChannelCompData | PackageSummaryData, CompNodeType>;
export type CompRfEdgeData = { inheritanceOnly: boolean; crossBoundary: boolean; ipc?: boolean; ipcChannels?: IpcChannelDetail[] };
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

// The wire treatments, in priority order. Only IPC animates — it's the one "flowing over the wire"
// relationship — so animation alone signals IPC. Coupling that CROSSES a package boundary is the
// packaging signal: gold, SOLID, static (previously animated, which made it read as dashed and thus
// indistinguishable from IPC). Inheritance is dashed violet; same-package coupling a quiet grey.
const INHERITANCE_COLOR = "#A78BFA";
const INTERNAL_COLOR = "#5B6675";
const CROSS_BOUNDARY_COLOR = "#C9A24B";

interface EdgeStroke {
  color: string;
  width: number;
  opacity: number;
  dashed: boolean;
  animated: boolean;
}

function strokeFor(edge: CompEdgeSpec): EdgeStroke {
  // IPC leaves the process: its own magenta, dashed, and the ONLY animated wire — so it can never be
  // mistaken for a code coupling.
  if (edge.ipc) {
    return { color: IPC_WIRE, width: 2, opacity: 1, dashed: true, animated: true };
  }
  if (edge.inheritanceOnly) {
    return { color: INHERITANCE_COLOR, width: 2, opacity: 1, dashed: true, animated: false };
  }
  // Cross-package coupling: gold, SOLID, static (no longer animated → no longer reads as dashes).
  if (edge.crossBoundary) {
    return { color: CROSS_BOUNDARY_COLOR, width: 2, opacity: 1, dashed: false, animated: false };
  }
  return { color: INTERNAL_COLOR, width: 2, opacity: 0.7, dashed: false, animated: false };
}

function toReactFlowEdge(edge: CompEdgeSpec): CompRfEdge {
  const stroke = strokeFor(edge);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: stroke.animated,
    style: {
      stroke: stroke.color,
      strokeWidth: stroke.width,
      opacity: stroke.opacity,
      ...(stroke.dashed ? { strokeDasharray: "5 4" } : {}),
    },
    markerEnd: arrowMarker(stroke.color, 16),
    data: { inheritanceOnly: edge.inheritanceOnly, crossBoundary: edge.crossBoundary, ipc: edge.ipc, ipcChannels: edge.ipcChannels },
  };
}
