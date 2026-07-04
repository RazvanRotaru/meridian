/**
 * Lay out a LogicGraphSpec with ELK and map it to React Flow — the logic-tab analog of
 * buildElkGraph + toReactFlow. Container nodes (loops / try / expanded calls) recurse as ELK
 * children with title-bar padding; leaf/branch nodes carry their measured size. Like the call
 * graph, `hierarchyHandling: INCLUDE_CHILDREN` sits on the ROOT ONLY and every edge lives on the
 * root graph so the layered algorithm routes exec wires across container boundaries.
 */

import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { LogicEdgeSpec, LogicGraphSpec, LogicNodeData, LogicNodeSpec, LogicNodeType as ExecNodeType } from "../derive/logicGraph";
import { ELK_ROOT_ID } from "./buildElkGraph";

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

export type LogicRfNode = Node<LogicNodeData | DefGroupData, LogicNodeType>;
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

export function buildLogicElkGraph(spec: LogicGraphSpec): ElkNode {
  const elkById = new Map<string, ElkNode>(spec.nodes.map((node) => [node.id, toElkNode(node)]));
  const ids = new Set(spec.nodes.map((node) => node.id));
  const roots: ElkNode[] = [];
  for (const node of spec.nodes) {
    const elkNode = elkById.get(node.id);
    if (!elkNode) {
      continue;
    }
    const parent = node.parentId ? elkById.get(node.parentId) : undefined;
    if (node.parentId && ids.has(node.parentId) && parent) {
      parent.children?.push(elkNode);
    } else {
      roots.push(elkNode);
    }
  }
  return { id: ELK_ROOT_ID, layoutOptions: ROOT_LAYOUT_OPTIONS, children: roots, edges: spec.edges.map(toElkEdge) };
}

function toElkNode(node: LogicNodeSpec): ElkNode {
  if (node.data.isContainer) {
    return { id: node.id, children: [], layoutOptions: CONTAINER_LAYOUT_OPTIONS };
  }
  return { id: node.id, width: node.width ?? 200, height: node.height ?? 60 };
}

function toElkEdge(edge: LogicEdgeSpec): ElkExtendedEdge {
  return { id: edge.id, sources: [edge.source], targets: [edge.target] };
}

export function toReactFlowLogic(laidOut: ElkNode, specById: Map<string, LogicNodeSpec>, edges: LogicEdgeSpec[]): LogicReactFlowGraph {
  const nodes: LogicRfNode[] = [];
  emitChildren(laidOut.children ?? [], undefined, specById, nodes);
  return { nodes, edges: edges.map(toReactFlowEdge) };
}

// DFS preorder: React Flow requires a parent node to appear before its children.
function emitChildren(elkNodes: ElkNode[], parentId: string | undefined, specById: Map<string, LogicNodeSpec>, out: LogicRfNode[]): void {
  for (const elkNode of elkNodes) {
    const spec = specById.get(elkNode.id);
    if (!spec || elkNode.id === ELK_ROOT_ID) {
      continue;
    }
    out.push(toReactFlowNode(elkNode, parentId, spec));
    emitChildren(elkNode.children ?? [], elkNode.id, specById, out);
  }
}

function toReactFlowNode(elkNode: ElkNode, parentId: string | undefined, spec: LogicNodeSpec): LogicRfNode {
  return {
    id: elkNode.id,
    type: spec.type,
    position: { x: elkNode.x ?? 0, y: elkNode.y ?? 0 },
    width: elkNode.width,
    height: elkNode.height,
    ...(parentId ? { parentId, extent: "parent" as const } : {}),
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
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    data: { kind: edge.kind },
  };
}
