/**
 * Lay out a LogicGraphSpec with ELK and map it to React Flow — the logic-tab analog of
 * buildElkGraph + toReactFlow. Container nodes (loops / callbacks / expanded calls, plus the
 * conservative try/finally fallback) recurse as ELK children with title-bar padding; leaf/branch
 * nodes carry their measured size. The nesting, the
 * root-only `hierarchyHandling` contract and the parent-relative mapping live in `elkNesting`; this
 * module only supplies the logic adapter, layout options and edge styling.
 */

import { type Edge, type Node } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api";
import type {
  CollapsedEdgeData,
  LogicEdgeSpec,
  LogicGraphSpec,
  LogicNodeData,
  LogicNodeSpec,
  LogicNodeType as ExecNodeType,
  RequestEdgeTraversalEvidence,
  TerminalData,
} from "../derive/logicGraph";
import { logicEdgeCollapseKey } from "../derive/collapseLogicEdges";
import { arrowMarker } from "../theme/edgeColors";
import { buildNestedElkGraph, emitReactFlowNodes, parentRelativePlacement, type ElkNestAdapter } from "./elkNesting";

// Def-group FRAMES are structural groups the layout appends below a module's flow (see
// deriveLogicLayout) — not exec nodes the graph builder ever emits — so the React Flow node type
// widens the builder's exec types with "defgroup".
export type LogicNodeType = ExecNodeType | "defgroup";
export type LogicFlowOrientation = "horizontal" | "vertical";

/**
 * A def-group frame's data. It participates in the same expandable-node contract as executable
 * nodes, while remaining a structural occurrence rather than a call site (`targetId: null`). The
 * shared fields keep Logic's surface controls and BaseNode adapter generic: the frame can fold its
 * definition children without teaching either one about a special node type.
 */
export type DefGroupData = {
  targetId: null;
  label: string;
  kind: string;
  childCount: number;
  expandable: boolean;
  isExpanded: boolean;
  isContainer: boolean;
};

export type LogicRfNode = Node<LogicNodeData | DefGroupData | TerminalData | CollapsedEdgeData, LogicNodeType>;
/**
 * A renderer-only summary of the measurable call targets visible in one branch lane. This is
 * deliberately named "static lane" rather than branch coverage: the core report proves graph
 * reachability of callees, not that a test actually executed this source path.
 */
export type StaticLaneTone = "covered" | "indirect" | "uncovered" | "none";
export interface StaticLaneSignal {
  basis: "visible-callee-reachability";
  laneId: string;
  branchNodeId: string;
  armIndex: number;
  label: string;
  role: NonNullable<LogicEdgeSpec["branchRole"]>;
  tone: StaticLaneTone;
  counts: { direct: number; indirect: number; uncovered: number; unmeasured: number };
}
export type ExecutionLaneTone = "covered" | "uncovered" | "unknown";
export interface ExecutionLaneSignal {
  basis: "istanbul-branch-path";
  laneId: string;
  branchNodeId: string;
  armIndex: number;
  label: string;
  role: NonNullable<LogicEdgeSpec["branchRole"]>;
  tone: ExecutionLaneTone;
  /** Aggregate path-entry count. Null means the report could not prove a match. */
  hits: number | null;
  pathIndex?: number;
  reason?: "unsupported-branch-kind" | "missing-source" | "no-file-evidence" | "no-branch-match" | "no-path-match";
}
export type LogicRfEdgeData = {
  kind: "seq" | "branch" | "async";
  sourcePort?: string;
  targetPort?: string;
  taskId?: string;
  branchRole?: LogicEdgeSpec["branchRole"];
  requestFlowDisposition?: "observed" | "context";
  requestFlowEvidence?: RequestEdgeTraversalEvidence | null;
  requestTraceId?: string;
  /** Static callee-reachability context for a branch lane; never runtime branch-hit evidence. */
  staticLane?: StaticLaneSignal;
  /** Imported runtime branch-path evidence. When present it always supersedes `staticLane`. */
  executionLane?: ExecutionLaneSignal;
  orientation?: LogicFlowOrientation;
  /** Stable semantic identity used by per-edge disclosure. Never use the sequential RF edge id. */
  collapseKey?: string;
  collapsible?: boolean;
};
export type LogicRfEdge = Edge<LogicRfEdgeData>;
export const LOGIC_ASYNC_EDGE_TYPE = "logicAsync";
export interface LogicReactFlowGraph {
  nodes: LogicRfNode[];
  edges: LogicRfEdge[];
}

const ROOT_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  // Logic is structured control flow, so an orthogonal left->right thread reads more like code than
  // a generic network. React Flow mirrors this with smooth-step edges below.
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  // Horizontal cadence: leave enough air to read each step before the next branch/call lands.
  "elk.layered.spacing.nodeNodeBetweenLayers": "112",
  // Vertical lanes need to look like branches, not a slightly staggered list. Direct branch targets
  // receive additional individual clearance in `applyBranchGeometry`.
  // This is primarily an arm-to-arm gap: a linear exec chain has one node per layer, while branch
  // paths share layers. 120px makes the split unmistakable without stretching ordinary sequences.
  "elk.spacing.nodeNode": "120",
  "elk.spacing.edgeNode": "38",
  "elk.spacing.edgeEdge": "22",
  "elk.layered.spacing.edgeNodeBetweenLayers": "32",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": "[top=40,left=36,bottom=40,right=36]",
};

function rootLayoutOptions(orientation: LogicFlowOrientation): Record<string, string> {
  if (orientation === "horizontal") return ROOT_LAYOUT_OPTIONS;
  return {
    ...ROOT_LAYOUT_OPTIONS,
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "76",
    "elk.spacing.nodeNode": "96",
    "elk.padding": "[top=32,left=40,bottom=32,right=40]",
  };
}

// Top padding clears the container's title bar (React Flow draws nothing there itself).
const CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=42,left=16,bottom=16,right=16]",
};
const TARGET_CHANGED_CONTAINER_MIN_WIDTH = 260;

const SNAPSHOT_CONTAINER_LAYOUT_OPTIONS: Record<string, string> = {
  "elk.padding": "[top=84,left=16,bottom=16,right=16]",
};

const EXEC_COLOR = "#C8D3E0";
const BRANCH_COLOR = "#E6B84D";
const EXCEPTION_COLOR = "#D98A5B";
const ASYNC_COLOR = "#48D7E8";

// Added above/below the first node (or direct merge) in each branch arm. Combined with the root
// node gap this yields a deliberately roomy lane break without inflating ordinary linear sequences.
const BRANCH_LANE_CLEARANCE = 48;

const adapter: ElkNestAdapter<LogicNodeSpec> = {
  id: (node) => node.id,
  parentId: (node) => node.parentId,
  isContainer: (node) => node.data.isContainer,
  leafSize: (node) => ({ width: node.width ?? 200, height: node.height ?? 60 }),
  // Every expanded node keeps the same paint-aware header floor as its collapsed card. Preserve
  // the legacy target-change minimum as a lower bound for older specs that lack measured chrome.
  containerMinSize: (node) => {
    const targetChanged = "targetChangedStatus" in node.data && node.data.targetChangedStatus !== undefined;
    return {
      width: Math.max(node.width ?? 200, targetChanged ? TARGET_CHANGED_CONTAINER_MIN_WIDTH : 0),
      height: Math.max(node.height ?? 60, targetChanged ? 58 : 0),
    };
  },
  containerOptions: CONTAINER_LAYOUT_OPTIONS,
  containerOptionsFor: (node) => (
    "runtime" in node.data && node.data.runtime?.snapshot !== undefined
      ? SNAPSHOT_CONTAINER_LAYOUT_OPTIONS
      : null
  ),
};

export function buildLogicElkGraph(
  spec: LogicGraphSpec,
  orientation: LogicFlowOrientation = "horizontal",
): ElkNode {
  const graph = buildNestedElkGraph(spec.nodes, spec.edges, adapter, rootLayoutOptions(orientation));
  applyFlowGeometry(graph, spec, orientation);
  return graph;
}

/** Give every decision one ordered EAST-side ELK port per arm, and route the corresponding ELK edge
 * from that exact port. The same ids are passed to React Flow as sourceHandle below, so layout and
 * rendering share a single branch-pin contract. Direct arm targets get branch-only vertical margin;
 * ordinary seq nodes keep the tighter linear rhythm. */
function applyFlowGeometry(
  graph: ElkNode,
  spec: LogicGraphSpec,
  orientation: LogicFlowOrientation,
): void {
  const elkById = new Map<string, ElkNode>();
  collectElkNodes(graph.children ?? [], elkById);

  for (const node of spec.nodes) {
    const elkNode = elkById.get(node.id);
    // Folded structural summaries keep their semantic arm metadata for coverage/tooltips, but they
    // expose one ordinary exec output. Hidden case/catch pins must not survive into ELK geometry.
    const branchPorts = "branchPorts" in node.data && node.data.isExpanded
      ? node.data.branchPorts ?? []
      : [];
    const asyncPorts = "asyncPorts" in node.data ? node.data.asyncPorts ?? [] : [];
    if (!elkNode || (branchPorts.length === 0 && asyncPorts.length === 0)) {
      continue;
    }
    elkNode.layoutOptions = { ...(elkNode.layoutOptions ?? {}), "elk.portConstraints": "FIXED_ORDER" };
    elkNode.ports = [
      ...branchPorts.map((port, index) => ({
        id: port.id,
        width: 2,
        height: 2,
        layoutOptions: {
          "elk.port.side": orientation === "horizontal" ? "EAST" : "SOUTH",
          "elk.port.index": String(index),
        },
      })),
      ...asyncPorts.map((port, index) => ({
        id: port.id,
        width: 2,
        height: 2,
        // Async task lifetime is a parallel rail below the white exec thread. Both launch and wait
        // endpoints therefore live on SOUTH; direction remains a React Flow handle concern.
        layoutOptions: {
          "elk.port.side": orientation === "horizontal" ? "SOUTH" : "EAST",
          "elk.port.index": String(index),
        },
      })),
    ];
  }

  const elkEdges = new Map((graph.edges ?? []).map((edge) => [edge.id, edge]));
  for (const edge of spec.edges) {
    if (edge.sourcePort) {
      const elkEdge = elkEdges.get(edge.id);
      if (elkEdge) {
        elkEdge.sources = [edge.sourcePort];
      }
    }
    if (edge.targetPort) {
      const elkEdge = elkEdges.get(edge.id);
      if (elkEdge) {
        elkEdge.targets = [edge.targetPort];
      }
    }
    if (edge.kind === "branch") {
      const target = elkById.get(edge.target);
      if (target) {
        target.layoutOptions = {
          ...(target.layoutOptions ?? {}),
          "elk.spacing.individual": orientation === "horizontal"
            ? `[top=${BRANCH_LANE_CLEARANCE},left=0,bottom=${BRANCH_LANE_CLEARANCE},right=0]`
            : `[top=0,left=${BRANCH_LANE_CLEARANCE},bottom=0,right=${BRANCH_LANE_CLEARANCE}]`,
        };
      }
    }
  }
}

function collectElkNodes(nodes: ElkNode[], out: Map<string, ElkNode>): void {
  for (const node of nodes) {
    out.set(node.id, node);
    collectElkNodes(node.children ?? [], out);
  }
}

export function toReactFlowLogic(
  laidOut: ElkNode,
  specById: Map<string, LogicNodeSpec>,
  edges: LogicEdgeSpec[],
  orientation: LogicFlowOrientation = "horizontal",
): LogicReactFlowGraph {
  const nodes = emitReactFlowNodes(laidOut, (elkNode, parentId) => {
    const spec = specById.get(elkNode.id);
    return spec ? toReactFlowNode(elkNode, parentId, spec) : null;
  });
  return { nodes, edges: edges.map((edge) => toReactFlowEdge(edge, orientation)) };
}

function toReactFlowNode(elkNode: ElkNode, parentId: string | undefined, spec: LogicNodeSpec): LogicRfNode {
  const fold = spec.type === "fold" ? spec.data as CollapsedEdgeData : null;
  return {
    id: elkNode.id,
    type: spec.type,
    ...parentRelativePlacement(elkNode, parentId),
    data: spec.data,
    ...(fold ? {
      focusable: false,
      ariaLabel: fold.hiddenStepCount > 0
        ? `Collapsed path, ${fold.hiddenStepCount} hidden step${fold.hiddenStepCount === 1 ? "" : "s"}`
        : "Collapsed path connection",
    } : {}),
  };
}

// Exec wires (seq) are the white-ish Blueprint execution thread; branch pins carry a colored,
// labeled wire (then/else/case).
function toReactFlowEdge(edge: LogicEdgeSpec, orientation: LogicFlowOrientation): LogicRfEdge {
  const branch = edge.kind === "branch";
  const async = edge.kind === "async";
  const exceptional = edge.branchRole === "catch";
  // A try's normal route stays on the ivory exec vocabulary; the catch route is a dashed orange
  // exception wire on both its split hop and final hop into the join. Other branch arms retain the
  // established branch colour.
  const color = exceptional ? EXCEPTION_COLOR : edge.branchRole === "try" ? EXEC_COLOR : branch ? BRANCH_COLOR : async ? ASYNC_COLOR : EXEC_COLOR;
  const collapsible = edge.collapsible !== false;
  const collapseKey = collapsible ? logicEdgeCollapseKey(edge) : undefined;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourcePort ? { sourceHandle: edge.sourcePort } : {}),
    ...(edge.targetPort ? { targetHandle: edge.targetPort } : {}),
    type: async ? LOGIC_ASYNC_EDGE_TYPE : "logicCollapsible",
    animated: !branch && !async && !exceptional,
    // Promise identity is carried by the rail/socket pairing; repeating variable labels over the
    // canvas made multi-task barriers noisy. The endpoint hover still exposes each input label.
    label: branch ? edge.label : undefined,
    labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: "#12171E", fillOpacity: 0.9 },
    labelBgPadding: [4, 2],
    style: { stroke: color, strokeWidth: async ? 2.25 : 2, ...(exceptional ? { strokeDasharray: "7 5" } : {}) },
    markerEnd: async ? undefined : arrowMarker(color, 16),
    interactionWidth: 22,
    // The native disclosure button owns keyboard focus. Keeping the React Flow edge wrapper out of
    // the tab order avoids two stops for one action.
    focusable: false,
    ariaLabel: collapsible ? `Collapse ${edge.label ? `${edge.label} path` : async ? "async rail" : "flow path"}` : undefined,
    data: {
      kind: edge.kind,
      ...(edge.sourcePort ? { sourcePort: edge.sourcePort } : {}),
      ...(edge.targetPort ? { targetPort: edge.targetPort } : {}),
      ...(edge.taskId ? { taskId: edge.taskId } : {}),
      ...(edge.branchRole ? { branchRole: edge.branchRole } : {}),
      ...(collapseKey ? { collapseKey, collapsible: true } : { collapsible: false }),
      orientation,
    },
  };
}
