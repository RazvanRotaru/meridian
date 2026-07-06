/**
 * Lay out a LogicGraphSpec with ELK and map it to React Flow — the logic-tab analog of
 * buildElkGraph + toReactFlow. Container nodes (loops / try / expanded calls) recurse as ELK
 * children with title-bar padding; leaf/branch nodes carry their measured size. The nesting, the
 * root-only `hierarchyHandling` contract and the parent-relative mapping live in `elkNesting`; this
 * module only supplies the logic adapter, layout options and edge styling.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { LogicEdgeSpec, LogicGraphSpec, LogicNodeData, LogicNodeSpec, LogicNodeType as ExecNodeType, TerminalData } from "../derive/logicGraph";
import { arrowMarker } from "../theme/edgeColors";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";

// Def-group FRAMES are structural groups the layout appends below a module's flow (see
// deriveLogicLayout) — not exec nodes the graph builder ever emits — so the React Flow node type
// widens the builder's exec types with "defgroup".
export type LogicNodeType = ExecNodeType | "defgroup";

/**
 * A def-group frame's data: presentation only (the owner label/kind and the count of methods it
 * frames). `targetId: null` is shared with `LogicNodeData` on purpose — it keeps `LogicRfNode` a
 * SINGLE `Node` type (data is the union below, and every member carries `targetId`), so the view's
 * `node.data.targetId` accessors keep typechecking with no discriminated-union narrowing. A frame is
 * never a call site, so the null target also makes clicking one a harmless no-op.
 */
export type DefGroupData = {
  targetId: null;
  label: string;
  kind: string;
  childCount: number;
};

export type LogicRfNode = Node<LogicNodeData | DefGroupData | TerminalData, LogicNodeType>;
export type LogicRfEdgeData = { kind: "seq" | "branch" };
export type LogicRfEdge = Edge<LogicRfEdgeData>;
export interface LogicReactFlowGraph {
  nodes: LogicRfNode[];
  edges: LogicRfEdge[];
}

const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "72",
  "elk.spacing.nodeNode": "36",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
};

// Top padding clears the container's title bar (React Flow draws nothing there itself).
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=42,left=16,bottom=16,right=16]",
};

const EXEC_COLOR = "#C8D3E0";
const BRANCH_COLOR = "#E6B84D";

const adapter: ElkNestAdapter<LogicNodeSpec> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.data.isContainer,
  leafSize: (node) => ({ width: node.width ?? 200, height: node.height ?? 60 }),
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
};

export function buildLogicElkGraph(spec: LogicGraphSpec): ElkNode {
  return buildNestedElkGraph(spec.nodes, spec.edges, adapter, ROOT_LAYOUT_OPTIONS);
}

export function toReactFlowLogic(laidOut: ElkNode, specById: Map<string, LogicNodeSpec>, edges: LogicEdgeSpec[]): LogicReactFlowGraph {
  const nodes = emitReactFlowNodes(laidOut, (elkNode, parentId) => {
    const spec = specById.get(elkNode.id);
    return spec ? toReactFlowNode(elkNode, parentId, spec) : null;
  });
  return { nodes, edges: edges.map(toReactFlowEdge) };
}

function toReactFlowNode(elkNode: ElkNode, parentId: string | undefined, spec: LogicNodeSpec): LogicRfNode {
  return {
    id: elkNode.id,
    type: spec.type,
    ...parentRelativePlacement(elkNode, parentId),
    data: spec.data,
  };
}

// Exec wires (seq) are the white-ish Blueprint execution thread; branch pins carry a colored,
// labeled wire (then/else/case).
function toReactFlowEdge(edge: LogicEdgeSpec): LogicRfEdge {
  const branch = edge.kind === "branch";
  const color = branch ? BRANCH_COLOR : EXEC_COLOR;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: !branch,
    label: branch ? edge.label : undefined,
    labelStyle: { fill: BRANCH_COLOR, fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: "#12171E", fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    style: { stroke: color, strokeWidth: 2 },
    markerEnd: arrowMarker(color, 16),
    data: { kind: edge.kind },
  };
}
