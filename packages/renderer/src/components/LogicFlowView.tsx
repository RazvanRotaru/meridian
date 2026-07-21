/**
 * The Logic-flow view: one callable's intra-procedural control-flow as an Unreal-Blueprints-style
 * React Flow graph. Nodes/edges are laid out by ELK in the store (`logicRfNodes`/`logicRfEdges`);
 * this component only mounts the read-only <ReactFlow> surface, an overlay header (breadcrumb +
 * "hide leaf blocks" toggle) that clears the floating Toolbar, and the empty/entry states.
 *
 * Entity-node interactions use the shared BaseNode contract: a trailing disclosure expands a
 * call/control/definition in place, while `</>` remains a decoration. This surface supplies the
 * Logic-specific action adapter, including double-click drill into a resolved callee.
 *
 * While nothing is opened (`logicRoot === null`) it shows the entry picker instead of the graph.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Edge,
  type EdgeMarker,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { CoverageReport, GraphArtifact, GraphNode, LogicFlows, NodeId } from "@meridian/core";
import { isSourceBackedNode } from "../derive/sourceBackedNode";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { GHOST_DEPTH_ALL } from "../state/store";
import { logicNodeTypes, SELECT_ACCENT, type JumpFlowNodeData } from "./nodes/logic/logicNodeTypes";
import { ReadonlyGraphCanvas } from "./canvas/ReadonlyGraphCanvas";
import { arrowMarker } from "../theme/edgeColors";
import { COVERAGE_COLORS } from "../theme/coverageColors";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import type { LogicNodeData, TerminalData } from "../derive/logicGraph";
import type { GraphIndex } from "../graph/graphIndex";
import { buildFlowContainmentIndex, transitiveCallers } from "../derive/flowInspect";
import { FLOW_COLORS } from "../derive/flowViewModel";
import { visibleCallReachabilityTone, withInferredLaneReachability } from "../derive/logicLaneCoverage";
import {
  executionCoverageIndex,
  executionEvidenceForCallTarget,
  executionEvidenceForNode,
  inferExecutionLaneCoverage,
  paintExecutionLaneCoverage,
  tallySelectedExecutionBranchCoverage,
  tallyVisibleExecutionCoverage,
  type ExecutionBranchPathTally,
  type ExecutionFlowTally,
  type IndexedExecutionCoverage,
} from "../derive/logicExecutionCoverage";
import { AltLogicSurface } from "./logicviews/AltLogicSurface";
import { LogicViewTabs } from "./logicviews/LogicViewTabs";
import { GraphLayoutIndicator } from "./canvas/GraphLayoutIndicator";
import { logicEdgeTypes } from "./edges/AsyncRailEdge";
import { BaseNodeActionScope, type BaseNodeModel } from "./nodes/BaseNode";
import { LogicActionBar } from "./controlpanel/LogicActionBar";
import { changedColor } from "./ChangedBadge";
import { LogicEdgeActionScope } from "./edges/LogicEdgeActionScope";
import { expandedSelectionByOneHop, selectionExpansionCount } from "../derive/selectionExpansion";
import { LogicOccurrenceSelectionScope } from "./nodes/logic/LogicOccurrenceSelectionContext";

export function LogicFlowView() {
  const logicRoot = useBlueprint((state) => state.logicRoot);
  const logicView = useBlueprint((state) => state.logicView);
  const logicFocus = useBlueprint((state) => state.logicFocus);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const logicNodes = useBlueprint((state) => state.logicRfNodes);
  const logicEdges = useBlueprint((state) => state.logicRfEdges);
  const layoutStatus = useBlueprint((state) => state.logicLayoutStatus);
  const layoutActivity = useBlueprint((state) => state.logicLayoutActivity);
  const selectionKey = `${logicRoot ?? ""}|${logicFocus.map((entry) => entry.id).join(">")}|${logicSelected ?? ""}`;
  const [expandedOccurrences, setExpandedOccurrences] = useState<{
    key: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  const exactOccurrenceIds = expandedOccurrences?.key === selectionKey
    ? expandedOccurrences.ids
    : null;
  const selectedOccurrenceIds = useMemo(() => {
    const visibleIds = new Set(logicNodes.map((node) => node.id));
    if (exactOccurrenceIds !== null) {
      return new Set([...exactOccurrenceIds].filter((id) => visibleIds.has(id)));
    }
    return logicSelected === null
      ? new Set<string>()
      : callSiteNodeIds(logicNodes, logicSelected);
  }, [exactOccurrenceIds, logicNodes, logicSelected]);
  const neighbourCount = selectionExpansionCount(selectedOccurrenceIds, logicNodes, logicEdges);
  const expandOccurrenceSelection = useCallback(() => {
    const expanded = expandedSelectionByOneHop(selectedOccurrenceIds, logicNodes, logicEdges);
    if (expanded.size > selectedOccurrenceIds.size) {
      setExpandedOccurrences({ key: selectionKey, ids: expanded });
    }
  }, [logicEdges, logicNodes, selectedOccurrenceIds, selectionKey]);
  if (logicRoot === null) {
    return <LogicFlowPicker />;
  }
  // Four projections of the SAME flow: the exec-pins graph is the default; metro/blocks/timeline
  // mount over the same root/trail/selection. The sub-tab strip floats above whichever is on screen.
  return (
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      aria-busy={layoutStatus === "laying-out" ? "true" : undefined}
    >
      {logicView === "graph" ? (
        <LogicFlowGraph
          rootId={logicRoot}
          selectedOccurrenceIds={selectedOccurrenceIds}
          exactOccurrenceIds={exactOccurrenceIds}
          neighbourCount={neighbourCount}
          onExpandOccurrenceSelection={expandOccurrenceSelection}
        />
      ) : <AltLogicSurface rootId={logicRoot} mode={logicView} />}
      <LogicViewTabs rootId={logicRoot} />
      {layoutStatus === "laying-out" && layoutActivity ? <GraphLayoutIndicator {...layoutActivity} /> : null}
    </div>
  );
}

/**
 * The graph surface for the opened flow: a full-bleed, read-only React Flow (mirroring the call
 * graph's canvas props) with the overlay header floating above it, and a centered card when the
 * charted callable has no calls or control flow of its own.
 */
function LogicFlowGraph(props: {
  rootId: NodeId;
  selectedOccurrenceIds: ReadonlySet<string>;
  exactOccurrenceIds: ReadonlySet<string> | null;
  neighbourCount: number;
  onExpandOccurrenceSelection: () => void;
}) {
  const logicRoot = props.rootId;
  const logicStack = useBlueprint((state) => state.logicStack);
  const logicFocus = useBlueprint((state) => state.logicFocus);
  const nodes = useBlueprint((state) => state.logicRfNodes);
  const edges = useBlueprint((state) => state.logicRfEdges);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const layoutStatus = useBlueprint((state) => state.logicLayoutStatus);
  const hideGreyed = useBlueprint((state) => state.hideGreyed);
  const nestByService = useBlueprint((state) => state.nestByService);
  const ghostDepth = useBlueprint((state) => state.ghostDepth);
  const index = useBlueprint((state) => state.index);
  const artifact = useBlueprint((state) => state.artifact);
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const execution = useMemo(
    () => (coverageMode ? executionCoverageIndex(artifact) : null),
    [artifact, coverageMode],
  );
  const showLogicTests = useBlueprint((state) => state.showLogicTests);
  const { drillLogicFlow, logicFlowTo, diveLogicContainer, logicFocusTo, toggleLogicExpand, toggleLogicEdgeCollapse, toggleHideGreyed, toggleNestByService, setGhostDepth, selectLogicTarget, openComposition, toggleLogicTests, expandAll, collapseAll, expandLogicOccurrences, collapseLogicOccurrences } =
    useBlueprintActions();

  // The two gestures the node components don't own, mutually exclusive by node kind: a control
  // container (loop/callback, plus the conservative try/finally fallback) DIVES into its bodies as a
  // focused sub-view; an expandable call drills into its callee's own flow. Ordinary try/catch is an
  // explicit branch and needs no dive. Fires for every node, so a jump satellite is skipped.
  const navigateLogicNode = (node: Pick<Node, "id" | "type" | "data">) => {
    const data = logicDataOf(node);
    if (!data) {
      return;
    }
    // A service frame carries no exec target — double-click opens its unit in the Service-composition
    // view (single click is a no-op, so navigation is never accidental).
    if (node.type === "servicegroup") {
      if (data.owner) {
        openComposition(data.owner.unitId);
      }
      return;
    }
    if (node.type === "control" && data.bodies?.length) {
      diveLogicContainer(node.id, data.label, data.bodies);
      return;
    }
    if ((data.navigable ?? data.expandable) && data.targetId !== null) {
      drillLogicFlow(data.targetId);
    }
  };
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => navigateLogicNode(node);
  const navigateBaseNode = (model: BaseNodeModel) => navigateLogicNode({
    id: model.instanceId,
    type: model.nodeType,
    data: model.data,
  });

  // Single-click a building block to trace its call target: selection is BY TARGET, so every call
  // site of the same target lights up. Re-clicking the selected target clears it; container/branch
  // nodes (no target) do nothing; jump satellites open their flow themselves. A cheap repaint.
  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    const target = logicDataOf(node)?.targetId;
    if (target) {
      selectLogicTarget(target === logicSelected ? null : target);
    }
  };

  // Emphasize the exec wires touching the selected target's call sites; dim the rest. Recomputed
  // only when the layout edges/nodes or the selection change — never mutating the store arrays.
  // Coverage is the base presentation layer; selection is the temporary interaction layer above it.
  // This preserves green/amber/red lane context when selection clears, while selected wires still
  // get the established bright focus accent and unrelated wires dim in place.
  const executionLaneModel = useMemo(
    () => execution ? inferExecutionLaneCoverage(nodes, edges, execution) : null,
    [edges, execution, nodes],
  );
  const coverageEdges = useMemo(
    () => executionLaneModel
      ? paintExecutionLaneCoverage(edges, executionLaneModel)
      : withInferredLaneReachability(edges, nodes, coverage),
    [coverage, edges, executionLaneModel, nodes],
  );
  const styledEdges = useMemo(
    () => emphasizeSelectedEdges(coverageEdges, props.selectedOccurrenceIds),
    [coverageEdges, props.selectedOccurrenceIds],
  );
  const hasStaticLaneSignals = coverageEdges.some((edge) => edge.data?.staticLane !== undefined);
  const hasExecutionLaneSignals = coverageEdges.some((edge) => edge.data?.executionLane !== undefined);

  // Reverse index (call target → the flow-roots that call it), rebuilt only when the artifact does:
  // it walks every flow once, so it must not run per selection/render.
  const containment = useMemo(
    () => buildFlowContainmentIndex((artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows),
    [artifact],
  );

  // Caller-ghosts, appended (RELAYOUT-FREE) above the graph: the observed callable's OWN callers hang
  // over the entry end-cap BY DEFAULT, and a selected block's callers hang over its call site — two
  // clusters, either possibly empty. `moreCount` is the active cluster's honest 24-cap shortfall,
  // surfaced as a "+N more" on the depth dial so the truncation is never silent. Cheap repaints.
  const { jumpNodes, jumpEdges, moreCount } = useMemo(
    () => buildJumpSatellites(nodes, logicSelected, logicRoot, containment, index, ghostDepth),
    [nodes, logicSelected, logicRoot, containment, index, ghostDepth],
  );

  // Coverage lens (repaint-only, like selection): the charted method's own verdict, a tally of how
  // much of its VISIBLE call flow tests reach, and — when Show tests is on — ghost nodes for the
  // tests that directly exercise it, wired into the entry.
  const flowCoverage = useMemo(
    () => (coverage && !execution ? tallyFlowCoverage(nodes, coverage) : null),
    [coverage, execution, nodes],
  );
  const executionFlowCoverage = useMemo(
    () => (execution ? tallyVisibleExecutionCoverage(nodes, index, execution) : null),
    [execution, index, nodes],
  );
  const executionBranchCoverage = useMemo(
    () => executionLaneModel ? tallySelectedExecutionBranchCoverage(nodes, executionLaneModel) : null,
    [executionLaneModel, nodes],
  );
  const rootCoverage = useMemo(
    () => execution
      ? executionRootVerdict(logicRoot, index, execution)
      : coverage ? rootVerdict(logicRoot, coverage) : null,
    [coverage, execution, index, logicRoot],
  );
  const { testNodes, testEdges } = useMemo(
    () => (coverage && !execution && showLogicTests ? buildTestGhosts(nodes, logicRoot, coverage, index) : EMPTY_GHOSTS),
    [coverage, execution, showLogicTests, nodes, logicRoot, index],
  );
  const directTestCount = execution ? 0 : coverage?.leaves[logicRoot]?.directTestCallers.length ?? 0;

  // A handle on the React Flow surface: the `fitView` prop only fits on mount, so navigation needs
  // this to recentre the viewport imperatively.
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance<Node, Edge> | null>(null);
  const selectedActionScope = useMemo(
    () => logicSelectionActionScope(nodes, logicSelected, props.exactOccurrenceIds),
    [logicSelected, nodes, props.exactOccurrenceIds],
  );
  const focusSelection = useCallback(() => {
    const hasSelection = props.selectedOccurrenceIds.size > 0;
    if (rfInstance === null || (hasSelection && selectedActionScope.nodeIds.length === 0)) {
      return;
    }
    void rfInstance.fitView({
      ...(!hasSelection
        ? {}
        : { nodes: selectedActionScope.nodeIds.map((id) => ({ id })) }),
      padding: 0.28,
      duration: 400,
      minZoom: 0.01,
      maxZoom: 1.05,
    });
  }, [props.selectedOccurrenceIds, rfInstance, selectedActionScope.nodeIds]);

  // The navigation identity: the callable drill trail plus the container-dive focus stack. It changes
  // on EVERY navigation — open/drill/dive/jump/pick, and breadcrumb-BACK too (the trail then differs
  // from the last-fitted one) — and stays CONSTANT across expand/collapse, the hide-leaf toggle, and
  // selection, none of which touch the trail or the focus stack.
  const navKey = `${logicStack.join(">")}||${logicFocus.map((entry) => entry.id).join(">")}`;

  // Recentre only when NAVIGATION lands a fresh graph, not on the expand/collapse or hide-leaf
  // relayouts that also produce new `nodes` for the SAME flow. Keyed on `[nodes]` ALONE, never on
  // `navKey`: navKey flips a render BEFORE the async `nodes` relayout, so keying on it would fit the
  // STALE graph then skip the real one. Firing when the new nodes actually arrive — and guarding by
  // navKey — fits exactly once per navigation and skips same-flow relayouts.
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!rfInstance || nodes.length === 0) return;
    if (lastFitKey.current === navKey) return;
    lastFitKey.current = navKey;
    // A long left-to-right execution flow becomes unreadable if its entire width is squeezed into
    // one viewport. Land at reading zoom on the entry + first structural beat; the minimap/pan keeps
    // the rest discoverable, while the explicit Fit control still offers a whole-flow overview.
    const target = logicEntryReadingTarget(nodes);
    requestAnimationFrame(() => {
      if (target) void rfInstance.setCenter(target.x, target.y, { zoom: ENTRY_READING_ZOOM, duration: 400 });
    });
  }, [nodes, rfInstance]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  return (
    <div style={SURFACE_STYLE}>
      <BaseNodeActionScope
        toggleExpand={(model) => toggleLogicExpand(model.instanceId)}
        navigateInto={navigateBaseNode}
      >
        <LogicEdgeActionScope toggleCollapse={toggleLogicEdgeCollapse}>
          <LogicOccurrenceSelectionScope selectedIds={props.exactOccurrenceIds}>
            <ReadonlyGraphCanvas<Node, Edge>
              nodes={[...nodes, ...jumpNodes, ...testNodes]}
              edges={[...styledEdges, ...jumpEdges, ...testEdges]}
              nodeTypes={logicNodeTypes}
              edgeTypes={logicEdgeTypes}
              onInit={(instance) => {
                setRfInstance(instance);
              }}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={() => selectLogicTarget(null)}
              miniMapColor={(node) => miniMapColor(node, coverage, logicRoot, execution, index)}
            >
              <LogicActionBar
                selectedCount={selectedActionScope.nodeIds.length}
                canFocus={rfInstance !== null && (props.selectedOccurrenceIds.size === 0
                  ? nodes.length + jumpNodes.length + testNodes.length > 0
                  : selectedActionScope.nodeIds.length > 0)}
                neighbourCount={props.neighbourCount}
                canExpand={selectedActionScope.canExpand}
                canCollapse={selectedActionScope.canCollapse}
                onFocusSelection={focusSelection}
                onExpandSelectionByOneLevel={props.onExpandOccurrenceSelection}
                onExpandSelection={() => props.exactOccurrenceIds === null
                  ? expandAll()
                  : expandLogicOccurrences(selectedActionScope.nodeIds)}
                onCollapseSelection={() => props.exactOccurrenceIds === null
                  ? collapseAll()
                  : collapseLogicOccurrences(selectedActionScope.nodeIds)}
              />
            </ReadonlyGraphCanvas>
          </LogicOccurrenceSelectionScope>
        </LogicEdgeActionScope>
      </BaseNodeActionScope>
      <LogicOverlayHeader
        stack={logicStack}
        focus={logicFocus}
        nodesById={index.nodesById}
        onJump={logicFlowTo}
        onFocusJump={logicFocusTo}
        hideGreyed={hideGreyed}
        onToggleHide={toggleHideGreyed}
        nestByService={nestByService}
        onToggleNest={toggleNestByService}
        ghostDepth={ghostDepth}
        onSetGhostDepth={setGhostDepth}
        moreCount={moreCount}
        coverageActive={coverageMode}
        rootCoverage={rootCoverage}
        flowCoverage={flowCoverage}
        executionFlowCoverage={executionFlowCoverage}
        executionBranchCoverage={executionBranchCoverage}
        executionCoverageActive={execution !== null}
        hasStaticLaneSignals={hasStaticLaneSignals}
        hasExecutionLaneSignals={hasExecutionLaneSignals}
        showTests={showLogicTests}
        directTestCount={directTestCount}
        onToggleTests={toggleLogicTests}
      />
      {isEmpty ? <EmptyFlowCard rootId={props.rootId} /> : null}
    </div>
  );
}

export interface LogicSelectionActionScope {
  /** Every visible call-site occurrence carrying the selected target. */
  nodeIds: string[];
  /** Whether the active selection scope, or the whole flow, contains a collapsed/open disclosure. */
  canExpand: boolean;
  canCollapse: boolean;
}

/** Resolve Logic's target-based selection to React Flow occurrences plus its visible subtrees.
 * With no selection, availability covers the whole visible flow while an empty `nodeIds` list
 * tells focus to fit every rendered node. Availability mirrors the store's scoped expand/collapse
 * walk, which includes each selected root and every currently visible descendant. */
export function logicSelectionActionScope(
  nodes: readonly LogicRfNode[],
  selectedTarget: NodeId | null,
  exactOccurrenceIds: ReadonlySet<string> | null = null,
): LogicSelectionActionScope {
  const nodeIds = exactOccurrenceIds === null
    ? selectedTarget === null
      ? []
      : nodes
        .filter((node) => node.data.targetId === selectedTarget)
        .map((node) => node.id)
    : nodes.filter((node) => exactOccurrenceIds.has(node.id)).map((node) => node.id);
  const hasSelection = exactOccurrenceIds !== null || selectedTarget !== null;
  if (hasSelection && nodeIds.length === 0) {
    return { nodeIds, canExpand: false, canCollapse: false };
  }

  const inScope = new Set(hasSelection ? nodeIds : nodes.map((node) => node.id));
  // Layouts normally order parents before children, but repeat until stable so availability is
  // independent of array order and stays in lockstep with scopedExpansion's tree walk.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId !== undefined && inScope.has(node.parentId) && !inScope.has(node.id)) {
        inScope.add(node.id);
        changed = true;
      }
    }
  }

  let canExpand = false;
  let canCollapse = false;
  for (const node of nodes) {
    const disclosure = node.data as { expandable?: boolean; isExpanded?: boolean };
    if (!inScope.has(node.id) || disclosure.expandable !== true) {
      continue;
    }
    if (disclosure.isExpanded === true) {
      canCollapse = true;
    } else {
      canExpand = true;
    }
  }
  return { nodeIds, canExpand, canCollapse };
}

const ENTRY_READING_SPAN = 1500;
// Land at a true reading scale. The graph is intentionally horizontal and pannable; squeezing even
// its first few beats into an overview made the redesigned nodes look like the old minimap.
const ENTRY_READING_ZOOM = 0.85;
// The persistent control panel owns ~300px on the left. Bias the camera toward the flow's entry so
// its first card lands just to the right of that panel instead of underneath it.
const ENTRY_CAMERA_LEFT_BIAS = 190;

/** Top-level nodes in the first horizontal reading window. Nested children travel with their parent;
 * caller/test satellites are context above the flow and must not shrink the initial execution view. */
function logicEntryReadingWindow(nodes: LogicRfNode[]): Array<{ id: string }> {
  const flowNodes = nodes.filter((node) => node.parentId === undefined);
  if (flowNodes.length === 0) return [];
  const entry = flowNodes.find((node) => node.type === "terminal" && (node.data as TerminalData).terminal === "entry")
    ?? flowNodes.reduce((left, node) => node.position.x < left.position.x ? node : left);
  const limit = entry.position.x + ENTRY_READING_SPAN;
  const window = flowNodes.filter((node) => node.position.x <= limit);
  return (window.length > 0 ? window : [entry]).map((node) => ({ id: node.id }));
}

function logicEntryReadingTarget(nodes: LogicRfNode[]): { x: number; y: number } | null {
  const ids = new Set(logicEntryReadingWindow(nodes).map((node) => node.id));
  const window = nodes.filter((node) => ids.has(node.id));
  if (window.length === 0) return null;
  const left = Math.min(...window.map((node) => node.position.x));
  const right = Math.max(...window.map((node) => node.position.x + (node.width ?? 0)));
  const top = Math.min(...window.map((node) => node.position.y));
  const bottom = Math.max(...window.map((node) => node.position.y + (node.height ?? 0)));
  return { x: (left + right) / 2 - ENTRY_CAMERA_LEFT_BIAS, y: (top + bottom) / 2 };
}

// SELECT_ACCENT (the green shared with the selected node ring) is imported from logicNodeTypes so the
// emphasized wires and the node ring can't drift: they read as one highlight.
const DIM_OPACITY = 0.25;
const EMPHASIS_WIDTH = 3;

/**
 * Style the exec wires for the current selection: wires whose source OR target is a call site of the
 * selected target glow (green, thicker); the rest dim so one target's threads trace clearly through
 * the spaghetti. No selection → the layout edges pass through untouched (same array, no new objects).
 */
function emphasizeSelectedEdges(
  edges: LogicRfEdge[],
  selectedOccurrenceIds: ReadonlySet<string>,
): LogicRfEdge[] {
  if (selectedOccurrenceIds.size === 0) {
    return edges;
  }
  return edges.map((edge) =>
    selectedOccurrenceIds.has(edge.source) || selectedOccurrenceIds.has(edge.target)
      ? emphasizeEdge(edge)
      : dimEdge(edge),
  );
}

// A target can be called many times; collect every node that calls THIS target so all its wires light up.
function callSiteNodeIds(nodes: LogicRfNode[], logicSelected: NodeId): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.data.targetId === logicSelected) {
      ids.add(node.id);
    }
  }
  return ids;
}

function emphasizeEdge(edge: LogicRfEdge): LogicRfEdge {
  return {
    ...edge,
    style: { ...edge.style, stroke: SELECT_ACCENT, strokeWidth: EMPHASIS_WIDTH, opacity: 1 },
    labelStyle: { ...edge.labelStyle, fill: SELECT_ACCENT },
    markerEnd: tintMarker(edge.markerEnd, SELECT_ACCENT),
  };
}

function dimEdge(edge: LogicRfEdge): LogicRfEdge {
  return { ...edge, style: { ...edge.style, opacity: DIM_OPACITY } };
}

// Keep the arrowhead in step with the recoloured wire; a string marker (rare) can't be tinted, so pass it through.
function tintMarker(marker: LogicRfEdge["markerEnd"], color: string): LogicRfEdge["markerEnd"] {
  return marker && typeof marker === "object" ? { ...(marker as EdgeMarker), color } : marker;
}

// At most this many satellites TOTAL across all depth rows — a heavily-shared callable can be
// reachable from dozens of flows, and pulling in indirect callers only widens that. Nearest callers
// (lowest depth) are kept first; the rest are dropped, so the cap never buries the selected node.
const MAX_JUMPS_TOTAL = 24;
const JUMP_WIDTH = 180;
const JUMP_HEIGHT = 44;
// Ghosts sit in horizontal ROWS clear ABOVE the whole graph so they never overlap a laid-out node,
// one row per hop of indirect caller: ROW_GAP is the vertical clearance BETWEEN rows (and between
// row 1 and the graph's top edge); COL_GAP is the gap between neighbouring ghosts within a row.
const JUMP_ROW_GAP = 90;
const JUMP_COL_GAP = 40;
// The vertical gap between stacked ghosts in the entry cluster's single-column layout — tighter than
// the depth-row gap since it's a compact list, but clear enough for the chain wire + arrow between them.
const JUMP_STACK_GAP = 34;
// The horizontal clearance between that left-hand column and the entry end-cap it feeds into.
const JUMP_COL_HGAP = 96;
const JUMP_MUTED = "#4B535F";

/**
 * The caller-ghost clusters appended (RELAYOUT-FREE) above the graph. TWO clusters, either possibly
 * empty: the observed callable's OWN callers hang over the flow's entry end-cap BY DEFAULT (so you
 * see where the flow is entered from just by observing it), and — exactly as before — a selected
 * block's callers hang over its call site. Each ghost is a dashed satellite; rows stack by hop depth
 * clear above the graph, wired as the reverse-call CHAIN (see buildChainEdges). Purely additive: it
 * reads the store's laid-out nodes but never mutates them, so selection and the depth dial stay repaints.
 */
function buildJumpSatellites(
  nodes: LogicRfNode[],
  logicSelected: NodeId | null,
  logicRoot: NodeId,
  containment: Map<string, string[]>,
  index: GraphIndex,
  ghostDepth: number,
): { jumpNodes: Node[]; jumpEdges: Edge[]; moreCount: number } {
  if (nodes.length === 0) {
    return { jumpNodes: [], jumpEdges: [], moreCount: 0 };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const top = graphTop(nodes, byId);
  const args: GhostClusterArgs = { byId, top, containment, index, ghostDepth, logicRoot };

  // The entry cluster: callers of the observed callable, anchored on its entry end-cap. Independent
  // of selection — this is the "when observing a flow, show where it's called from" default.
  const entryNode = byId.get(`${logicRoot}::entry`);
  // The entry's related flows stack in a single vertical COLUMN above the end-cap (they read as a
  // "called from" list); the selection cluster keeps the depth-row fan.
  const entry = entryNode ? buildGhostCluster(logicRoot, entryNode, "jump:entry:", args, "column") : null;

  // The selection cluster: callers of the selected call target, anchored on its call site (today's
  // click-to-reveal behavior). Skipped when nothing is selected or the target isn't drawn.
  const callSite = logicSelected !== null ? nodes.find((node) => node.data.targetId === logicSelected) : undefined;
  const selection = logicSelected !== null && callSite ? buildGhostCluster(logicSelected, callSite, "jump:sel:", args, "rows") : null;

  const clusters = [entry, selection].filter((c): c is GhostCluster => c !== null);
  // "+N more" reports the cluster the user is acting on: the selection when one's active, else the
  // entry's own callers — never the sum, so it stays a meaningful count for the focused set.
  const active = selection ?? entry;
  const moreCount = active ? Math.max(0, active.total - active.jumpNodes.length) : 0;
  return {
    jumpNodes: clusters.flatMap((c) => c.jumpNodes),
    jumpEdges: clusters.flatMap((c) => c.jumpEdges),
    moreCount,
  };
}

interface GhostCluster {
  jumpNodes: Node[];
  jumpEdges: Edge[];
  total: number;
}

// The shared inputs a cluster needs: the laid-out nodes indexed by id, the graph's top edge to hang
// rows above, and the reverse-call map + depth to walk. `logicRoot` is the flow we're in, walked as a
// TRANSPARENT (free, non-emitted) hop so it never shows as its own ghost and a direct caller of the
// flow reads at depth 1, not stranded at 2 behind the root you're already viewing.
interface GhostClusterArgs {
  byId: Map<string, LogicRfNode>;
  top: number;
  containment: Map<string, string[]>;
  index: GraphIndex;
  ghostDepth: number;
  logicRoot: NodeId;
}

/**
 * One caller-ghost cluster: the flows that TRANSITIVELY reach `target` (a direct caller at depth 1,
 * its caller at depth 2, …, up to `ghostDepth`), drawn as dashed satellites in rows clear ABOVE the
 * graph and centred on `anchor` (the entry end-cap, or a selected call site). `idPrefix` namespaces
 * the ghost node ids so the entry and selection clusters can't collide on a shared caller's React
 * key. `total` is the countable caller set BEFORE the 24-ghost cap, so the dial can surface the shortfall.
 *
 * `layout` picks the arrangement above the anchor: "rows" fans each hop-depth into its own centred
 * horizontal row (deeper == higher); "column" stacks EVERY ghost in one vertical column, nearest
 * caller at the bottom — a compact "called from" list. Either way the chain wiring is unchanged: the
 * edges follow the containment graph, not the coordinates (see buildChainEdges).
 */
function buildGhostCluster(target: NodeId, anchor: LogicRfNode, idPrefix: string, a: GhostClusterArgs, layout: "rows" | "column"): GhostCluster {
  // Walk the reverse call graph back `ghostDepth` hops (GHOST_DEPTH_ALL == the whole closure); the
  // flow we're already looking at is a TRANSPARENT passthrough (never emitted, costs no hop), then
  // keep the NEAREST callers when over the cap (BFS keys depth-ascending, so the sort makes it explicit).
  const callers = transitiveCallers(a.containment, target, a.ghostDepth, new Set([a.logicRoot]));
  const total = callers.size;
  const ranked = [...callers.entries()].sort((x, y) => x[1] - y[1]).slice(0, MAX_JUMPS_TOTAL);
  if (ranked.length === 0) {
    return { jumpNodes: [], jumpEdges: [], total };
  }
  const anchorPos = absolutePos(anchor, a.byId);
  const anchorCenterX = anchorPos.x + (anchor.width ?? JUMP_WIDTH) / 2;
  const makeGhost = (root: string, depth: number, x: number, y: number): Node => {
    const node = a.index.nodesById.get(root);
    return {
      id: `${idPrefix}${root}`,
      type: "jumpflow",
      position: { x, y },
      width: JUMP_WIDTH,
      height: JUMP_HEIGHT,
      selectable: false,
      draggable: false,
      data: { rootId: root, label: node?.displayName ?? root, file: node?.location?.file, depth } satisfies JumpFlowNodeData,
    };
  };
  const jumpNodes: Node[] = layout === "column" ? stackLeft() : fanRows();
  const jumpEdges = buildChainEdges(ranked, target, anchor.id, idPrefix, a.containment);
  return { jumpNodes, jumpEdges, total };

  // A single column to the LEFT of the entry end-cap, vertically CENTRED on it so the entry sits at
  // the column's mid-height. ranked is depth-ascending, so nearest callers lead the column top-down.
  function stackLeft(): Node[] {
    const centerY = anchorPos.y + (anchor.height ?? JUMP_HEIGHT) / 2;
    const columnHeight = ranked.length * JUMP_HEIGHT + (ranked.length - 1) * JUMP_STACK_GAP;
    const startY = centerY - columnHeight / 2;
    const x = anchorPos.x - JUMP_COL_HGAP - JUMP_WIDTH;
    return ranked.map(([root, depth], i) => makeGhost(root, depth, x, startY + i * (JUMP_HEIGHT + JUMP_STACK_GAP)));
  }

  // Each hop-depth fanned into its own centred horizontal row clear ABOVE the graph (deeper == higher).
  function fanRows(): Node[] {
    return [...groupByDepth(ranked)].flatMap(([depth, roots]) => {
      const rowY = a.top - depth * (JUMP_HEIGHT + JUMP_ROW_GAP);
      const rowWidth = roots.length * JUMP_WIDTH + (roots.length - 1) * JUMP_COL_GAP;
      const startX = anchorCenterX - rowWidth / 2;
      return roots.map((root, i) => makeGhost(root, depth, startX + i * (JUMP_WIDTH + JUMP_COL_GAP), rowY));
    });
  }
}

/**
 * The satellite wires, drawn as the reverse-call CHAIN AMONG the rendered ghosts — NOT a fan pointing
 * every ghost straight at the anchor. For A→B→C with C the target, this yields A→B and B→C.
 *
 * The containment map is read as a reverse call graph: `X ∈ containment.get(N)` means "X calls N", so
 * X's ghost points at N — the node ONE HOP CLOSER to the anchor. So for each node N in {target} ∪
 * {rendered ghosts}, every rendered caller X of N gets an edge `<prefix>X` → (N is the target ? the
 * anchor node : `<prefix>N`). Depth-1 ghosts thus land on the anchor; a depth-2 ghost lands on the
 * depth-1 ghost it calls; and so on up the tree. `idPrefix` matches the cluster's ghost node ids.
 *
 * ORPHAN FALLBACK: near the 24-cap a ghost's own callee may be undrawn, leaving it with no outgoing
 * edge; it's then wired straight to the anchor so it never dangles. Edges dedupe on their
 * source→target pair. The "contains" label rides ONLY the genuine direct-caller edges into the
 * anchor; ghost→ghost and fallback edges stay unlabeled (the vertical chain is self-evident).
 */
function buildChainEdges(
  ranked: Array<[string, number]>,
  target: NodeId,
  anchorNodeId: string,
  idPrefix: string,
  containment: Map<string, string[]>,
): Edge[] {
  const rendered = new Set(ranked.map(([root]) => root));
  const edges: Edge[] = [];
  const seenPairs = new Set<string>();
  const emitted = new Set<string>();
  const ghostId = (root: string) => `${idPrefix}${root}`;

  // Link each rendered caller X of `at` to `at`'s rendered node (`X ∈ containment.get(at)` ⇒ edge
  // X→at). Skips a self-call (a recursive root is its own caller) and any caller not rendered.
  const linkCallers = (at: string, atNodeId: string, labeled: boolean) => {
    for (const caller of containment.get(at) ?? []) {
      if (caller === at || !rendered.has(caller)) {
        continue;
      }
      const source = ghostId(caller);
      const pair = `${source}->${atNodeId}`;
      if (seenPairs.has(pair)) {
        continue;
      }
      seenPairs.add(pair);
      emitted.add(caller);
      edges.push(jumpEdge(source, atNodeId, pair, labeled));
    }
  };

  // The target's direct callers point at the anchor (labeled "contains"); every rendered ghost's
  // direct callers point at that ghost (unlabeled — a link in the chain, not a container).
  linkCallers(target, anchorNodeId, true);
  for (const root of rendered) {
    linkCallers(root, ghostId(root), false);
  }

  // A ghost whose callee fell outside the cap has no outgoing edge yet; wire it to the anchor so it
  // never dangles. Unlabeled: it isn't a direct caller of the target.
  for (const root of rendered) {
    if (emitted.has(root)) {
      continue;
    }
    const source = ghostId(root);
    const pair = `${source}->${anchorNodeId}`;
    seenPairs.add(pair);
    emitted.add(root);
    edges.push(jumpEdge(source, anchorNodeId, pair, false));
  }
  return edges;
}

// Bucket the ranked (root, depth) pairs into one list per depth, preserving the ranked order within
// each — so each depth becomes its own centred row of ghosts.
function groupByDepth(ranked: Array<[string, number]>): Map<number, string[]> {
  const byDepth = new Map<number, string[]>();
  for (const [root, depth] of ranked) {
    const roots = byDepth.get(depth);
    if (roots) {
      roots.push(root);
    } else {
      byDepth.set(depth, [root]);
    }
  }
  return byDepth;
}

// The top edge (minimum absolute y) of the whole laid-out graph. Every node's ELK position is
// parent-relative, so its true canvas y is summed up the parent chain; the ghost row anchors above this.
function graphTop(nodes: LogicRfNode[], byId: Map<string, LogicRfNode>): number {
  let top = Infinity;
  for (const node of nodes) {
    top = Math.min(top, absolutePos(node, byId).y);
  }
  return top;
}

/**
 * A logic node's ELK position is PARENT-RELATIVE (React Flow `parentId`), so sum the offsets up the
 * containment chain to get the call site's true canvas coordinate — where the satellites anchor.
 * A `seen` guard terminates on the (tolerated) malformed parentId cycle.
 */
function absolutePos(node: LogicRfNode, byId: Map<string, LogicRfNode>): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  const seen = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

// The satellite wire: dashed, muted grey, no animation — it must not compete with the emphasized
// exec thread. It runs FROM a caller ghost (in the row above) DOWN INTO the node one hop closer to
// the selection (a deeper ghost, or the selected call site). Only a genuine DIRECT caller of the
// selection wears the "contains" label; ghost→ghost links stay unlabeled — the chain speaks for
// itself. The id is the source→target pair, which the caller has already deduped, so it's unique.
function jumpEdge(source: string, target: string, pair: string, labeled: boolean): Edge {
  return {
    id: `jumpedge:${pair}`,
    source,
    target,
    label: labeled ? "contains" : undefined,
    animated: false,
    style: { stroke: JUMP_MUTED, strokeWidth: 1.5, strokeDasharray: "4 3" },
    labelStyle: { fill: "#7B8695", fontSize: 9 },
    labelBgStyle: { fill: "#12171E", fillOpacity: 0.9 },
    labelBgPadding: [3, 1],
    markerEnd: arrowMarker(JUMP_MUTED, 12),
  };
}

// The click handlers run for every node on the surface, including the appended jump satellites and
// the entry/exit end-caps. Those carry no call data (a satellite owns its own click; a terminal is
// no call site), so hand back logic data only for real exec nodes.
function logicDataOf(node: Pick<Node, "type" | "data">): LogicNodeData | null {
  return node.type === "jumpflow" || node.type === "terminal" || node.type === "fold"
    ? null
    : (node.data as LogicNodeData);
}

// ---- coverage lens over the logic flow --------------------------------------------------------
export interface FlowCoverageTally {
  direct: number;
  reached: number;
  untested: number;
  total: number;
}
export interface RootCoverage {
  status: "covered" | "indirect" | "uncovered" | "none";
  label: string;
  sub: string;
}
const EMPTY_GHOSTS: { testNodes: Node[]; testEdges: Edge[] } = { testNodes: [], testEdges: [] };
const MAX_TEST_GHOSTS = 12;

/** Static fallback for the charted method: whether a resolved graph path leads to it from test code. */
function rootVerdict(rootId: NodeId, coverage: CoverageReport): RootCoverage | null {
  const leaf = coverage.leaves[rootId];
  if (leaf) {
    if (leaf.status === "covered") {
      const n = leaf.directTestCallers.length;
      return { status: "covered", label: "Linked directly from tests", sub: `${n} static test call${n === 1 ? "" : "s"}` };
    }
    if (leaf.status === "indirect") {
      return { status: "indirect", label: "Reachable from tests", sub: leaf.distance ? `${leaf.distance} static call hops` : "static path found" };
    }
    const why = leaf.reason?.kind === "only-uncovered-callers" ? "only callers lack a test path" : "no resolved production caller";
    return { status: "uncovered", label: "No resolved test path", sub: why };
  }
  // A module/class root (the def-grid case): fall back to its members' roll-up percentage.
  const container = coverage.containers[rootId];
  if (container && container.status !== "no-callables") {
    return { status: container.status === "partial" ? "indirect" : container.status, label: `${container.percent}% of members reachable`, sub: `${container.covered}/${container.total} callables` };
  }
  return null;
}

/** Runtime execution verdict for the charted callable; aggregate hits never imply test identity. */
function executionRootVerdict(
  rootId: NodeId,
  index: GraphIndex,
  execution: IndexedExecutionCoverage,
): RootCoverage | null {
  const evidence = executionEvidenceForNode(index.nodesById.get(rootId), execution);
  if (!evidence) return null;
  return evidence.hits > 0
    ? {
        status: "covered",
        label: "Executed",
        sub: `${evidence.hits} aggregate hit${evidence.hits === 1 ? "" : "s"}`,
      }
    : {
        status: "uncovered",
        label: "Not executed",
        sub: "instrumented with 0 hits",
      };
}

/** Bucket the VISIBLE call chips by their callee's verdict — the "how much of this flow is covered"
 * meter. Deduped by target so a callee invoked twice counts once; external/unresolved calls (not a
 * measured callable) are skipped. Re-scopes automatically as inline depth changes the node set. */
function tallyFlowCoverage(nodes: LogicRfNode[], coverage: CoverageReport): FlowCoverageTally {
  const seen = new Set<string>();
  let direct = 0;
  let reached = 0;
  let untested = 0;
  for (const node of nodes) {
    const d = node.data as LogicNodeData;
    if (d?.logicKind !== "call" || d.resolution !== "resolved" || !d.targetId || d.definition || seen.has(d.targetId)) {
      continue;
    }
    const tone = visibleCallReachabilityTone(node, coverage);
    if (!tone || tone === "none" || tone === "test") continue; // not a production callable/container represented in the static coverage report.
    seen.add(d.targetId);
    if (tone === "covered") direct += 1;
    else if (tone === "indirect") reached += 1;
    else untested += 1;
  }
  return { direct, reached, untested, total: direct + reached + untested };
}

/**
 * The tests that DIRECTLY exercise the charted method, as violet ghost nodes in a row above the
 * flow's entry, each wired down into it — the coverage-lens analog of the related-flows caller
 * ghosts, reading straight off `directTestCallers`. Purely additive (no relayout), like the jump
 * satellites; empty when nothing directly tests the method (an indirect/untested root has none).
 */
function buildTestGhosts(
  nodes: LogicRfNode[],
  rootId: NodeId,
  coverage: CoverageReport,
  index: GraphIndex,
): { testNodes: Node[]; testEdges: Edge[] } {
  const testers = coverage.leaves[rootId]?.directTestCallers ?? [];
  const topLevel = nodes.filter((node) => node.parentId === undefined && node.type !== "defgroup");
  if (testers.length === 0 || topLevel.length === 0) {
    return EMPTY_GHOSTS;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const entry = topLevel.reduce((lowest, node) => (node.position.y < lowest.position.y ? node : lowest));
  const entryPos = absolutePos(entry, byId);
  const capped = testers.slice(0, MAX_TEST_GHOSTS);
  const rowWidth = capped.length * JUMP_WIDTH + (capped.length - 1) * JUMP_COL_GAP;
  const startX = entryPos.x + (entry.width ?? JUMP_WIDTH) / 2 - rowWidth / 2;
  const rowY = graphTop(nodes, byId) - (JUMP_HEIGHT + JUMP_ROW_GAP);
  const testNodes: Node[] = capped.map((testId, i) => {
    const node = index.nodesById.get(testId);
    return {
      id: `test:${testId}`,
      type: "jumpflow",
      position: { x: startX + i * (JUMP_WIDTH + JUMP_COL_GAP), y: rowY },
      width: JUMP_WIDTH,
      height: JUMP_HEIGHT,
      selectable: false,
      draggable: false,
      data: { rootId: testId, label: node?.displayName ?? testId, file: node?.location?.file, depth: 1, test: true } satisfies JumpFlowNodeData,
    };
  });
  const testEdges: Edge[] = capped.map((testId) => ({
    id: `testedge:${testId}`,
    source: `test:${testId}`,
    target: entry.id,
    animated: false,
    style: { stroke: COVERAGE_COLORS.test, strokeWidth: 1.5, strokeDasharray: "5 4", opacity: 0.85 },
    markerEnd: arrowMarker(COVERAGE_COLORS.test, 13),
  }));
  return { testNodes, testEdges };
}

// The MiniMap gets untyped `Node`s; narrow to our logic data and mirror each node type's accent.
function miniMapColor(
  node: Node,
  coverage: CoverageReport | null,
  rootId: NodeId,
  execution: IndexedExecutionCoverage | null,
  index: GraphIndex,
): string {
  if (execution) {
    const data = node.data as Partial<LogicNodeData>;
    const evidence = data.logicKind === "call"
      ? executionEvidenceForCallTarget(data.targetId ?? null, data.resolution, index, execution)
      : node.type === "terminal" && (node.data as TerminalData).terminal === "entry"
        ? executionEvidenceForNode(index.nodesById.get(rootId), execution)
        : null;
    if (evidence) return COVERAGE_COLORS[evidence.verdict];
  } else if (coverage) {
    if (node.type === "jumpflow" && (node.data as JumpFlowNodeData).test) return COVERAGE_COLORS.test;
    const tone = visibleCallReachabilityTone(node as LogicRfNode, coverage);
    if (tone) return COVERAGE_COLORS[tone];
    if (node.type === "terminal" && (node.data as TerminalData).terminal === "entry") {
      const root = rootVerdict(rootId, coverage);
      if (root) return VERDICT_COLOR[root.status];
    }
  }
  // Runtime/coverage colors are the minimap's primary diagnostic contract. PR status takes over
  // only when no active evidence lens has a verdict for this node.
  const reviewData = node.data as Partial<LogicNodeData>;
  if (reviewData.changedStatus !== undefined) return changedColor(reviewData.changedStatus);
  if (reviewData.targetChangedStatus !== undefined) return changedColor(reviewData.targetChangedStatus);
  if (node.type === "terminal") {
    const terminal = (node.data as TerminalData).terminal;
    if (terminal === "entry") return "#4FB477";
    // A return/throw cap reads hot in the minimap too — same fact, same colour as on canvas.
    return terminal === "exit" ? "#8A93A0" : "#E06C6C";
  }
  const data = node.data as LogicNodeData;
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "finally") return "#D98A5B";
  if (data.logicKind === "callback") return "#5FA8A0";
  if (data.logicKind === "if" || data.logicKind === "switch" || data.logicKind === "join" || data.logicKind === "await") return "#5FC1CE";
  if ((data.semantics?.nestedNotAwaited ?? 0) > 0) return FLOW_COLORS.detached;
  if (data.callScope === "external") return "#92A1B4";
  if (data.callScope === "unresolved") return "#E06C6C";
  return data.callKind === "method" ? "#5E74C6" : "#3B7AC0";
}

/**
 * The floating overlay header, offset to clear the Toolbar's top-left column: the drill breadcrumb
 * on the left, and on the right the related-flow depth dial beside compact-call density controls.
 * Its own container ignores pointer events so the gap between them still pans the canvas; each
 * control re-enables them for itself.
 */
function LogicOverlayHeader(props: {
  stack: NodeId[];
  focus: readonly { id: string; label: string }[];
  nodesById: ReadonlyMap<string, GraphNode>;
  onJump: (id: NodeId) => void;
  onFocusJump: (index: number) => void;
  hideGreyed: boolean;
  onToggleHide: () => void;
  nestByService: boolean;
  onToggleNest: () => void;
  ghostDepth: number;
  onSetGhostDepth: (depth: number) => void;
  moreCount: number;
  coverageActive: boolean;
  rootCoverage: RootCoverage | null;
  flowCoverage: FlowCoverageTally | null;
  executionFlowCoverage: ExecutionFlowTally | null;
  executionBranchCoverage: ExecutionBranchPathTally | null;
  executionCoverageActive: boolean;
  hasStaticLaneSignals: boolean;
  hasExecutionLaneSignals: boolean;
  showTests: boolean;
  directTestCount: number;
  onToggleTests: () => void;
}) {
  return (
    <div style={OVERLAY_HEADER_STYLE}>
      <div style={HEADER_PANEL_STYLE}>
        <LogicBreadcrumb
          stack={props.stack}
          focus={props.focus}
          nodesById={props.nodesById}
          onJump={props.onJump}
          onFocusJump={props.onFocusJump}
        />
        {props.coverageActive && props.executionCoverageActive ? (
          <ExecutionCoverageHeadline
            root={props.rootCoverage}
            flow={props.executionFlowCoverage}
            branches={props.executionBranchCoverage}
            hasLaneSignals={props.hasExecutionLaneSignals}
          />
        ) : props.coverageActive && (props.rootCoverage || props.flowCoverage?.total || props.hasStaticLaneSignals) ? (
          <CoverageHeadline root={props.rootCoverage} flow={props.flowCoverage} hasStaticLaneSignals={props.hasStaticLaneSignals} />
        ) : null}
      </div>
      <div style={HEADER_CONTROLS_STYLE}>
        {props.coverageActive && !props.executionCoverageActive ? (
          <button
            type="button"
            style={testsToggleStyle(props.showTests, props.directTestCount === 0)}
            aria-pressed={props.showTests}
            disabled={props.directTestCount === 0}
            title={props.directTestCount === 0 ? "No resolved direct call from detected test code" : props.showTests ? "Hide tests with direct static calls" : "Show tests with direct static calls"}
            onClick={props.onToggleTests}
          >
            🧪 Tests with direct calls{props.directTestCount > 0 ? ` (${props.directTestCount})` : ""}
          </button>
        ) : null}
        <GhostDepthDial depth={props.ghostDepth} moreCount={props.moreCount} onSet={props.onSetGhostDepth} />
        <button
          type="button"
          style={hideToggleStyle(props.nestByService)}
          aria-pressed={props.nestByService}
          onClick={props.onToggleNest}
        >
          Group by service
        </button>
        <button
          type="button"
          style={hideToggleStyle(props.hideGreyed)}
          aria-pressed={props.hideGreyed}
          onClick={props.onToggleHide}
        >
          {props.hideGreyed ? "Show compact calls" : "Hide compact calls"}
        </button>
      </div>
    </div>
  );
}

/** The method's coverage headline + a meter of how much of its visible call flow tests reach. */
function CoverageHeadline(props: { root: RootCoverage | null; flow: FlowCoverageTally | null; hasStaticLaneSignals: boolean }) {
  const flow = props.flow;
  const covered = flow ? flow.direct + flow.reached : 0;
  const percent = flow && flow.total ? Math.round((100 * covered) / flow.total) : 0;
  const bandColor = percent >= 75 ? COVERAGE_COLORS.covered : percent >= 40 ? COVERAGE_COLORS.indirect : COVERAGE_COLORS.uncovered;
  const width = (n: number) => (flow && flow.total ? `${(100 * n) / flow.total}%` : "0%");
  return (
    <div style={HEADLINE_STYLE} data-coverage-source="estimated-static-reachability">
      <span style={EVIDENCE_LABEL}>Estimated test reachability · no execution report</span>
      {props.root ? (
        <div style={HEADLINE_ROW}>
          <span style={{ ...HEADLINE_DOT, background: VERDICT_COLOR[props.root.status] }} />
          <span style={{ ...HEADLINE_TXT, color: VERDICT_COLOR[props.root.status] }}>{props.root.label}</span>
          <span style={HEADLINE_SUB}>{props.root.sub}</span>
        </div>
      ) : null}
      {flow && flow.total > 0 ? (
        <div style={METER_WRAP}>
          <div style={METER_ROW}>
            <span style={METER_LAB}>Visible call reachability</span>
            <span style={METER_VAL}>
              <span style={{ color: bandColor, fontSize: 14 }}>{percent}%</span>
              <span style={METER_FRAC}> · {covered}/{flow.total} calls</span>
            </span>
          </div>
          <div style={METER_BAR}>
            <span style={{ background: COVERAGE_COLORS.covered, width: width(flow.direct) }} />
            <span style={{ background: COVERAGE_COLORS.indirect, width: width(flow.reached) }} />
            <span style={{ background: COVERAGE_COLORS.uncovered, width: width(flow.untested) }} />
          </div>
        </div>
      ) : null}
      {props.hasStaticLaneSignals ? <StaticLaneLegend /> : null}
    </div>
  );
}

/** Imported, aggregate runtime evidence. Green/red are explicit counters; gray means no safe join. */
export function ExecutionCoverageHeadline(props: {
  root: RootCoverage | null;
  flow: ExecutionFlowTally | null;
  branches: ExecutionBranchPathTally | null;
  hasLaneSignals: boolean;
}) {
  const flow = props.flow;
  const percent = flow && flow.total ? Math.round((100 * flow.covered) / flow.total) : 0;
  const bandColor = percent >= 75 ? COVERAGE_COLORS.covered : percent >= 40 ? COVERAGE_COLORS.indirect : COVERAGE_COLORS.uncovered;
  const width = (n: number) => (flow && flow.total ? `${(100 * n) / flow.total}%` : "0%");
  const branchColor = props.branches
    ? props.branches.percent >= 75
      ? COVERAGE_COLORS.covered
      : props.branches.percent >= 40
        ? COVERAGE_COLORS.indirect
        : COVERAGE_COLORS.uncovered
    : COVERAGE_COLORS.none;
  const branchWidth = (n: number) => props.branches && props.branches.total
    ? `${(100 * n) / props.branches.total}%`
    : "0%";
  return (
    <div style={HEADLINE_STYLE} data-coverage-source="istanbul">
      {props.root ? (
        <div style={HEADLINE_ROW}>
          <span style={{ ...HEADLINE_DOT, background: VERDICT_COLOR[props.root.status] }} />
          <span style={{ ...HEADLINE_TXT, color: VERDICT_COLOR[props.root.status] }}>{props.root.label}</span>
          <span style={HEADLINE_SUB}>{props.root.sub}</span>
        </div>
      ) : null}
      {flow && flow.total > 0 ? (
        <div style={METER_WRAP}>
          <div style={METER_ROW}>
            <span style={METER_LAB}>Visible callees executed</span>
            <span style={METER_VAL}>
              <span style={{ color: bandColor, fontSize: 14 }}>{percent}%</span>
              <span style={METER_FRAC}> · {flow.covered}/{flow.total} functions</span>
            </span>
          </div>
          <div style={METER_BAR}>
            <span style={{ background: COVERAGE_COLORS.covered, width: width(flow.covered) }} />
            <span style={{ background: COVERAGE_COLORS.uncovered, width: width(flow.uncovered) }} />
          </div>
        </div>
      ) : null}
      {props.branches ? (
        <div
          style={METER_WRAP}
          title="Measured Istanbul branch paths owned by this Logic flow; unknown and ignored paths are excluded."
        >
          <div style={METER_ROW}>
            <span style={METER_LAB}>Selected branch paths</span>
            <span
              style={METER_VAL}
              aria-label={`Selected Logic branch coverage: ${props.branches.percent}%, ${props.branches.hit} of ${props.branches.total} measured paths hit`}
            >
              <span style={{ color: branchColor, fontSize: 14 }}>{props.branches.percent}%</span>
              <span style={METER_FRAC}> · {props.branches.hit}/{props.branches.total} paths</span>
            </span>
          </div>
          <div style={METER_BAR}>
            <span style={{ background: COVERAGE_COLORS.covered, width: branchWidth(props.branches.hit) }} />
            <span style={{ background: COVERAGE_COLORS.uncovered, width: branchWidth(props.branches.total - props.branches.hit) }} />
          </div>
        </div>
      ) : null}
      {props.hasLaneSignals ? <ExecutionLaneLegend /> : null}
    </div>
  );
}

function ExecutionLaneLegend() {
  const items: Array<[string, "covered" | "uncovered" | "none"]> = [
    ["hit", "covered"],
    ["0 hits", "uncovered"],
    ["unknown", "none"],
  ];
  return (
    <div
      style={LANE_LEGEND}
      aria-label="Logic lane colors show aggregate Istanbul branch-path execution"
      title="Aggregate Istanbul counters; gray means unsupported, ignored, missing, or not safely matched."
    >
      <span style={LANE_LEGEND_LABEL}>Branch paths</span>
      {items.map(([label, tone]) => (
        <span key={tone} style={LANE_LEGEND_ITEM}>
          <span style={{ ...LANE_LEGEND_SWATCH, background: COVERAGE_COLORS[tone] }} />
          {label}
        </span>
      ))}
      <span style={LANE_LEGEND_CAVEAT}>Istanbul aggregate · not per-test attribution</span>
    </div>
  );
}

/**
 * The lane palette is intentionally explicit about its evidence. These colors summarize the
 * callables visible inside each arm; they do not claim that an instrumented test took that path.
 */
function StaticLaneLegend() {
  const items: Array<[string, keyof typeof COVERAGE_COLORS]> = [
    ["direct", "covered"],
    ["indirect / mixed", "indirect"],
    ["not test-reached", "uncovered"],
    ["unmeasured", "none"],
  ];
  return (
    <div
      style={LANE_LEGEND}
      aria-label="Logic lane colors show static callee reachability, not branch execution data"
      title="Inferred from visible call targets; these colors do not show which branch a test executed."
    >
      <span style={LANE_LEGEND_LABEL}>Lane callees</span>
      {items.map(([label, tone]) => (
        <span key={tone} style={LANE_LEGEND_ITEM}>
          <span style={{ ...LANE_LEGEND_SWATCH, background: COVERAGE_COLORS[tone] }} />
          {label}
        </span>
      ))}
      <span style={LANE_LEGEND_CAVEAT}>not branch execution</span>
    </div>
  );
}


// The finite hop steps the related-flows dial offers as numbered pills; "All" (GHOST_DEPTH_ALL) is a
// fourth pill handled separately since it's a sentinel, not a hop count.
const GHOST_DEPTHS = [1, 2, 3] as const;

/**
 * The "related flows" depth dial: pills 1 · 2 · 3 · All that set how many hops of INDIRECT callers
 * the ghosts reach back — 1 == direct callers only, All == the whole transitive-caller closure. The
 * active pill reads pressed (a numbered pill on exact match, "All" whenever the depth is beyond 3);
 * it governs the ghosts shown for the current/next selection (a repaint, no relayout). When the 24-
 * ghost cap hides some, a muted "+N more" trails the pills so the truncation isn't silent.
 */
function GhostDepthDial(props: { depth: number; moreCount: number; onSet: (depth: number) => void }) {
  // "All" is selected for any depth past the numbered pills, so a stored GHOST_DEPTH_ALL lights it.
  const allActive = props.depth >= 4;
  return (
    <div style={DIAL_STYLE}>
      <span style={DIAL_LABEL_STYLE}>Related</span>
      {GHOST_DEPTHS.map((n) => (
        <button
          key={n}
          type="button"
          style={dialPillStyle(props.depth === n)}
          aria-pressed={props.depth === n}
          aria-label={`Related flows depth: ${n} ${n === 1 ? "hop" : "hops"}`}
          title={`Show callers up to ${n} ${n === 1 ? "hop" : "hops"} away`}
          onClick={() => props.onSet(n)}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        style={dialPillStyle(allActive)}
        aria-pressed={allActive}
        aria-label="Related flows depth: all callers"
        title="Show every transitive caller (no depth limit)"
        onClick={() => props.onSet(GHOST_DEPTH_ALL)}
      >
        All
      </button>
      {props.moreCount > 0 ? <span style={DIAL_MORE_STYLE}>+{props.moreCount} more</span> : null}
    </div>
  );
}

/** Shown when a charted callable ships a flow with no drawable steps: a centered note + a way into
 * its source (the modal CodePanel is the only code surface the logic view has). */
function EmptyFlowCard(props: { rootId: NodeId }) {
  const index = useBlueprint((state) => state.index);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const { showCode } = useBlueprintActions();
  const rootNode = index.nodesById.get(props.rootId);
  const rootName = rootNode?.displayName ?? props.rootId;
  const canShowCode = isSourceBackedNode(rootNode) && Boolean(sourceUrl);
  return (
    <div style={EMPTY_WRAP_STYLE}>
      <div style={EMPTY_CARD_STYLE}>
        <span style={EMPTY_MARK_STYLE}>∅</span>
        <span>No calls or control flow in {rootName}.</span>
        {canShowCode && rootNode ? (
          <button
            type="button"
            style={SHOW_CODE_STYLE}
            onClick={() => {
              void showCode(rootNode, { mode: "modal" });
            }}
          >
            Show code
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The empty-state entry picker (shown only while nothing is opened): search any callable/module
 * that ships a logic flow, or pick from the ranked entry points — with the CLI-declared app entries
 * (`extensions.entryModules`) pinned on top — to open its flow directly, without hunting for a node
 * in the Call-flow graph.
 */
function LogicFlowPicker() {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const { openLogicFlow } = useBlueprintActions();
  const [query, setQuery] = useState("");

  // Thousands of flow keys are possible, so rank once per artifact — not on every keystroke/render.
  const entries = useMemo(() => rankedFlowEntries(artifact, index.nodesById), [artifact, index.nodesById]);
  const needle = query.trim().toLowerCase();
  const rows = needle ? searchFlows(entries, needle) : entries.slice(0, 20);

  return (
    <div style={PICKER_CONTAINER_STYLE}>
      <div style={PICKER_PANEL_STYLE}>
        <div style={PICKER_HINT_STYLE}>
          Pick an entry point, search a method, or double-click one in Service composition.
        </div>
        <input
          style={PICKER_SEARCH_STYLE}
          placeholder="Search a method or module…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div style={PICKER_LIST_STYLE}>
          {rows.length > 0 ? (
            rows.map((pick) => <PickRow key={pick.id} pick={pick} onOpen={openLogicFlow} />)
          ) : (
            <div style={PICKER_EMPTY_STYLE}>
              {needle ? `No method or module matches “${query.trim()}”.` : "No logic flows in this artifact."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One clickable entry row: name over a faint file path, with a kind tag (module is accented). */
function PickRow(props: { pick: FlowPick; onOpen: (id: NodeId) => void }) {
  const { pick } = props;
  return (
    <button type="button" style={ROW_STYLE} title={pick.id} onClick={() => props.onOpen(pick.id)}>
      <span style={ROW_MAIN_STYLE}>
        <span style={ROW_NAME_STYLE}>{pick.displayName}</span>
        {pick.file ? <span style={ROW_FILE_STYLE}>{pick.file}</span> : null}
      </span>
      <span style={kindTagStyle(pick.kind)}>{pick.kind}</span>
    </button>
  );
}

interface FlowPick {
  id: NodeId;
  displayName: string;
  qualifiedName: string;
  file: string;
  kind: string;
}

// A name that *starts with* an entry/boot word — matched against the basename `displayName`
// (`main.ts`, `app.tsx`), NOT the full id: the app lives under `src/aria/app/…`, so a path match
// would boost every file and let test names sort to the top. Anchored, so `AboutSection…` misses.
const ENTRY_NAME = /^(main|index|bootstrap|app|entry|boot|server|root)\b/i;
const ENTRY_NAME_BOOST = 1000;
// A module's top-level flow is the file's own init/boot sequence, so it outranks a plain callable.
const MODULE_BOOST = 100;
// Test/story fixtures are never an app entry, so they're dropped from the default list entirely.
const TEST_FILE = /(__tests?__|\.test\.|\.spec\.|\.stories\.)/i;

/**
 * Every node that ships a logic flow, ordered for the picker: the CLI-declared app entries
 * (`extensions.entryModules`) are pinned on top in their declared order, then the rest follow a
 * name/kind heuristic — an entry-ish name (main/boot/…) outweighs everything, and a module (a
 * file's top-level init flow) outranks a callable. Test/story files are excluded. The caller slices.
 */
function rankedFlowEntries(artifact: GraphArtifact, nodesById: ReadonlyMap<string, GraphNode>): FlowPick[] {
  const flows = artifact.extensions?.logicFlow as unknown as LogicFlows | undefined;
  if (!flows) {
    return [];
  }
  const flowKeys = new Set(Object.keys(flows));
  const pinned = declaredEntryPicks(artifact, flowKeys, nodesById);
  const pinnedIds = new Set(pinned.map((pick) => pick.id));

  const ranked: Array<{ pick: FlowPick; score: number }> = [];
  for (const id of flowKeys) {
    const node = nodesById.get(id);
    if (pinnedIds.has(id) || !node || TEST_FILE.test(id)) {
      continue;
    }
    const nameBoost = ENTRY_NAME.test(node.displayName) ? ENTRY_NAME_BOOST : 0;
    const score = nameBoost + (node.kind === "module" ? MODULE_BOOST : 0);
    ranked.push({ score, pick: pickFor(id, node) });
  }
  ranked.sort((a, b) => b.score - a.score || a.pick.displayName.localeCompare(b.pick.displayName));
  return [...pinned, ...ranked.map((entry) => entry.pick)];
}

/**
 * The CLI-declared app entries (`extensions.entryModules`) that actually belong in the picker: kept
 * only when they ship a logic flow (the picker lists flow-bearing nodes) and aren't test fixtures,
 * in declared order, deduped. Absent/empty on older artifacts → no pins (behavior unchanged), so
 * it's read defensively from the loose extensions record with the same cast as `logicFlow`.
 */
function declaredEntryPicks(
  artifact: GraphArtifact,
  flowKeys: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, GraphNode>,
): FlowPick[] {
  const declared = artifact.extensions?.entryModules as unknown as NodeId[] | undefined;
  if (!Array.isArray(declared)) {
    return [];
  }
  const picks: FlowPick[] = [];
  const seen = new Set<NodeId>();
  for (const id of declared) {
    const node = nodesById.get(id);
    if (seen.has(id) || !flowKeys.has(id) || !node || TEST_FILE.test(id)) {
      continue;
    }
    seen.add(id);
    picks.push(pickFor(id, node));
  }
  return picks;
}

function pickFor(id: NodeId, node: GraphNode): FlowPick {
  return {
    id,
    displayName: node.displayName,
    qualifiedName: node.qualifiedName,
    file: node.location?.file ?? "",
    kind: node.kind,
  };
}

/** First ~15 ranked entries whose display or qualified name contains the (lowercased) needle. */
function searchFlows(entries: FlowPick[], needle: string): FlowPick[] {
  const found: FlowPick[] = [];
  for (const entry of entries) {
    if (entry.displayName.toLowerCase().includes(needle) || entry.qualifiedName.toLowerCase().includes(needle)) {
      found.push(entry);
      if (found.length >= 15) {
        break;
      }
    }
  }
  return found;
}

/**
 * The navigation trail: the callable drill crumbs (root..current) first, then one crumb per active
 * container DIVE. A callable crumb jumps back to that flow (clearing any dive via `logicFlowTo`); a
 * focus crumb jumps back along the dive trail. The deepest crumb overall is "current" — that's the
 * last focus crumb while diving, otherwise the last callable crumb (so a callable crumb stays
 * clickable-to-exit whenever a dive is active).
 */
function LogicBreadcrumb(props: {
  stack: NodeId[];
  focus: readonly { id: string; label: string }[];
  nodesById: ReadonlyMap<string, GraphNode>;
  onJump: (id: NodeId) => void;
  onFocusJump: (index: number) => void;
}) {
  const diving = props.focus.length > 0;
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Logic flow trail">
      {props.stack.map((id, position) => (
        <Crumb
          key={`s:${id}:${position}`}
          label={props.nodesById.get(id)?.displayName ?? id}
          title={id}
          separator={position > 0}
          current={!diving && position === props.stack.length - 1}
          onClick={() => props.onJump(id)}
        />
      ))}
      {props.focus.map((entry, i) => (
        <Crumb
          key={`f:${entry.id}:${i}`}
          label={entry.label}
          title={entry.label}
          separator
          current={i === props.focus.length - 1}
          onClick={() => props.onFocusJump(i)}
        />
      ))}
    </nav>
  );
}

/** One breadcrumb segment: an optional leading separator, then the (styled) crumb button. */
function Crumb(props: { label: string; title: string; separator: boolean; current: boolean; onClick: () => void }) {
  return (
    <Fragment>
      {props.separator ? <span style={CRUMB_SEP_STYLE} aria-hidden>›</span> : null}
      <button
        type="button"
        style={props.current ? CRUMB_CURRENT_STYLE : CRUMB_STYLE}
        onClick={props.onClick}
        aria-current={props.current ? "page" : undefined}
        title={props.title}
      >
        {props.label}
      </button>
    </Fragment>
  );
}

// The toolbar floats over roughly the top-left ~320px column, so the picker and the overlay header
// keep a left inset that clears it.
const TOOLBAR_CLEARANCE = 336;

// The graph fills the canvas shell; the header and empty card float above it.
const SURFACE_STYLE: React.CSSProperties = { position: "absolute", inset: 0, background: "#0E1116" };

// Floats above the graph, clearing the Toolbar's column; transparent to pointer events so the gap
// still pans (each control opts back in).
const OVERLAY_HEADER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 340,
  right: 16,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  pointerEvents: "none",
  zIndex: 5,
};
const HEADER_PANEL_STYLE: React.CSSProperties = {
  pointerEvents: "auto",
  // The projection tabs own the top-center band; drop the left panel below them when their
  // horizontal spans meet at laptop widths (the coverage legend makes that overlap conspicuous).
  marginTop: 36,
  minWidth: 0,
  maxWidth: 340,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "6px 8px",
};

// The coverage headline sits under the breadcrumb: a verdict line + a three-band meter of the
// visible flow's coverage. Colours come from the shared coverage palette so it reads as one lens.
const VERDICT_COLOR: Record<RootCoverage["status"], string> = {
  covered: COVERAGE_COLORS.covered,
  indirect: COVERAGE_COLORS.indirect,
  uncovered: COVERAGE_COLORS.uncovered,
  none: COVERAGE_COLORS.none,
};
const HEADLINE_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #232935", paddingTop: 7 };
const EVIDENCE_LABEL: React.CSSProperties = { fontSize: 9.5, color: "#7B8695", textTransform: "uppercase", letterSpacing: 0.35 };
const HEADLINE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7 };
const HEADLINE_DOT: React.CSSProperties = { width: 9, height: 9, borderRadius: "50%", flex: "0 0 auto" };
const HEADLINE_TXT: React.CSSProperties = { fontSize: 12.5, fontWeight: 700 };
const HEADLINE_SUB: React.CSSProperties = { marginLeft: "auto", fontSize: 10.5, color: "#7B8695", whiteSpace: "nowrap" };
const METER_WRAP: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const METER_ROW: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between" };
const METER_LAB: React.CSSProperties = { fontSize: 10.5, color: "#9AA4B2" };
const METER_VAL: React.CSSProperties = { fontSize: 11.5, color: "#E6EDF3", fontWeight: 700, fontVariantNumeric: "tabular-nums" };
const METER_FRAC: React.CSSProperties = { color: "#7B8695", fontWeight: 400 };
const METER_BAR: React.CSSProperties = { display: "flex", height: 6, borderRadius: 4, overflow: "hidden", background: "#0B0E13", border: "1px solid #232935" };
const LANE_LEGEND: React.CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "3px 8px", borderTop: "1px solid #232935", paddingTop: 6, fontSize: 10.5, color: "#8994A3" };
const LANE_LEGEND_LABEL: React.CSSProperties = { color: "#AAB4C1", fontWeight: 600 };
const LANE_LEGEND_ITEM: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" };
const LANE_LEGEND_SWATCH: React.CSSProperties = { width: 8, height: 8, borderRadius: 2, display: "inline-block" };
const LANE_LEGEND_CAVEAT: React.CSSProperties = { width: "100%", color: "#7B8695", fontStyle: "italic" };

function testsToggleStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    pointerEvents: "auto",
    flex: "0 0 auto",
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    border: `1px solid ${active ? `${COVERAGE_COLORS.test}88` : "#2A2F37"}`,
    background: active ? "#1c1430" : "rgba(18,23,30,0.92)",
    color: disabled ? "#565E68" : active ? "#C6BCE0" : "#9AA4B2",
    opacity: disabled ? 0.7 : 1,
  };
}

// The right-hand control cluster (depth dial + hide toggle). Transparent to pointer events so the
// gaps still pan the canvas; each control opts back in for itself.
const HEADER_CONTROLS_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: 8,
  pointerEvents: "none",
};

function hideToggleStyle(active: boolean): React.CSSProperties {
  return {
    pointerEvents: "auto",
    flex: "0 0 auto",
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 6,
    cursor: "pointer",
    font: "inherit",
    border: `1px solid ${active ? "#3B7AC0" : "#2A2F37"}`,
    background: active ? "#111A24" : "rgba(18,23,30,0.92)",
    color: active ? "#8FB6E3" : "#9AA4B2",
  };
}

// The related-flows depth dial: a small pill group matching the hide toggle's panel look.
const DIAL_STYLE: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 3,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "rgba(18,23,30,0.92)",
  padding: "3px 6px",
};
const DIAL_LABEL_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695", marginRight: 2 };
// The honest-cap chip trailing the pills: muted and non-interactive, it just states how many related
// flows the 24-ghost render cap left off the canvas.
const DIAL_MORE_STYLE: React.CSSProperties = { fontSize: 10, color: "#7B8695", marginLeft: 4, whiteSpace: "nowrap" };

function dialPillStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 22,
    fontSize: 12,
    padding: "2px 6px",
    borderRadius: 4,
    cursor: "pointer",
    font: "inherit",
    border: `1px solid ${active ? "#3B7AC0" : "transparent"}`,
    background: active ? "#111A24" : "transparent",
    color: active ? "#8FB6E3" : "#9AA4B2",
  };
}

const BREADCRUMB_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 4,
};
const CRUMB_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "2px 4px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
  color: "#9AA4B2",
};
const CRUMB_CURRENT_STYLE: React.CSSProperties = { ...CRUMB_STYLE, color: "#E6EDF3", fontWeight: 600, cursor: "default" };
const CRUMB_SEP_STYLE: React.CSSProperties = { color: "#4B535F", fontSize: 13 };

// The empty card centers over the graph surface; its wrapper passes pointer events through so the
// canvas still pans around it, while the card itself stays interactive.
const EMPTY_WRAP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  padding: `0 48px 0 ${TOOLBAR_CLEARANCE}px`,
};
const EMPTY_CARD_STYLE: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 560,
  border: "1px dashed #2A2F37",
  borderRadius: 10,
  background: "#12171E",
  padding: "16px 18px",
  fontSize: 13,
  color: "#7B8695",
};
const EMPTY_MARK_STYLE: React.CSSProperties = { fontSize: 22, opacity: 0.5 };
const SHOW_CODE_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};

// The empty-state picker centers its panel in the same toolbar-cleared canvas as the graph.
const PICKER_CONTAINER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  boxSizing: "border-box",
  background: "#0E1116",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: `48px 48px 48px ${TOOLBAR_CLEARANCE}px`,
};
const PICKER_PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: "100%",
  maxWidth: 560,
  border: "1px solid #2A2F37",
  borderRadius: 12,
  background: "#12171E",
  padding: 20,
};
const PICKER_HINT_STYLE: React.CSSProperties = { fontSize: 13, color: "#7B8695", lineHeight: 1.5 };
const PICKER_SEARCH_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 13,
  padding: "6px 10px",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  color: "#E6EDF3",
};
const PICKER_LIST_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, maxHeight: 420, overflowY: "auto" };
const PICKER_EMPTY_STYLE: React.CSSProperties = { fontSize: 12, color: "#6C7683", padding: "6px 2px" };

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  textAlign: "left",
  borderRadius: 6,
  border: "1px solid #2A2F37",
  background: "#12171E",
  color: "#9AA4B2",
  padding: "6px 10px",
  cursor: "pointer",
  font: "inherit",
};
const ROW_MAIN_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 };
const ROW_NAME_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_FILE_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const KIND_TAG_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  border: "1px solid #2A2F37",
  borderRadius: 4,
  padding: "1px 6px",
  color: "#7B8695",
};

// Accent the module tag green — a module's top-level flow is the app/boot init, the place to start.
function kindTagStyle(kind: string): React.CSSProperties {
  if (kind !== "module") {
    return KIND_TAG_STYLE;
  }
  return { ...KIND_TAG_STYLE, color: "#56C271", borderColor: "#2C4133" };
}
