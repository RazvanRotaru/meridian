/**
 * The Logic-flow view: one callable's intra-procedural control-flow as an Unreal-Blueprints-style
 * React Flow graph. Nodes/edges are laid out by ELK in the store (`logicRfNodes`/`logicRfEdges`);
 * this component only mounts the read-only <ReactFlow> surface, an overlay header (breadcrumb +
 * "hide leaf blocks" toggle) that clears the floating Toolbar, and the empty/entry states.
 *
 * Node interactions live in the node components themselves — title-click expands a call/loop/try in
 * place, the `</>` button opens source. This adds the ONE gesture they can't: double-clicking a
 * resolved, flow-bearing block dives into that callee's own flow as a new breadcrumb level.
 *
 * While nothing is opened (`logicRoot === null`) it shows the entry picker instead of the graph.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  type Edge,
  type EdgeMarker,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { GraphArtifact, GraphNode, LogicFlows, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { GHOST_DEPTH_ALL } from "../state/store";
import { logicNodeTypes, SELECT_ACCENT, type JumpFlowNodeData } from "./nodes/logic/logicNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { arrowMarker } from "../theme/edgeColors";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import type { LogicNodeData } from "../derive/logicGraph";
import type { GraphIndex } from "../graph/graphIndex";
import { buildFlowContainmentIndex, transitiveCallers } from "../derive/flowInspect";

export function LogicFlowView() {
  const logicRoot = useBlueprint((state) => state.logicRoot);
  if (logicRoot === null) {
    return <LogicFlowPicker />;
  }
  return <LogicFlowGraph rootId={logicRoot} />;
}

/**
 * The graph surface for the opened flow: a full-bleed, read-only React Flow (mirroring the call
 * graph's canvas props) with the overlay header floating above it, and a centered card when the
 * charted callable has no calls or control flow of its own.
 */
function LogicFlowGraph(props: { rootId: NodeId }) {
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
  const { drillLogicFlow, logicFlowTo, diveLogicContainer, logicFocusTo, toggleHideGreyed, toggleNestByService, setGhostDepth, selectLogicTarget, openComposition } =
    useBlueprintActions();

  // The two gestures the node components don't own, mutually exclusive by node kind: a control
  // container (loop/try, no targetId) DIVES into its bodies as a focused sub-view; an expandable
  // call (no bodies) drills into its callee's own flow. Inline expand/collapse stays a title-click
  // inside the node. Fires for every node, so a jump satellite (owns its own click) is skipped.
  const onNodeDoubleClick: NodeMouseHandler<Node> = (_event, node) => {
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
    if (data.expandable && data.targetId !== null) {
      drillLogicFlow(data.targetId);
    }
  };

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
  const styledEdges = useMemo(
    () => emphasizeSelectedEdges(edges, nodes, logicSelected),
    [edges, logicSelected, nodes],
  );

  // Reverse index (call target → the flow-roots that call it), rebuilt only when the artifact does:
  // it walks every flow once, so it must not run per selection/render.
  const containment = useMemo(
    () => buildFlowContainmentIndex((artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows),
    [artifact],
  );

  // The "jump-to-flow" satellites for the current selection, appended (RELAYOUT-FREE) above the
  // selected call site — one row per hop of indirect callers (up to `ghostDepth`). Selection and the
  // depth dial stay cheap repaints: the store's laid-out graph is untouched.
  const { jumpNodes, jumpEdges, total } = useMemo(
    () => buildJumpSatellites(nodes, logicSelected, logicRoot, containment, index, ghostDepth),
    [nodes, logicSelected, logicRoot, containment, index, ghostDepth],
  );

  // HONEST CAP: transitiveCallers can find more related flows than the 24-ghost render cap draws.
  // `total` is the full countable set (closure minus the current root); the shortfall is surfaced as
  // a "+N more" label in the depth dial so the truncation is never silent. 0 when nothing is cut.
  const moreCount = Math.max(0, total - jumpNodes.length);

  // A handle on the React Flow surface: the `fitView` prop only fits on mount, so navigation needs
  // this to recentre the viewport imperatively.
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);

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
    if (!rfRef.current || nodes.length === 0) return;
    if (lastFitKey.current === navKey) return;
    lastFitKey.current = navKey;
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={[...nodes, ...jumpNodes]}
        edges={[...styledEdges, ...jumpEdges]}
        nodeTypes={logicNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => selectLogicTarget(null)}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={miniMapColor} />
      </ReactFlow>
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
      />
      {isEmpty ? <EmptyFlowCard rootId={props.rootId} /> : null}
    </div>
  );
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
  nodes: LogicRfNode[],
  logicSelected: NodeId | null,
): LogicRfEdge[] {
  if (logicSelected === null) {
    return edges;
  }
  const callSites = callSiteNodeIds(nodes, logicSelected);
  return edges.map((edge) =>
    callSites.has(edge.source) || callSites.has(edge.target) ? emphasizeEdge(edge) : dimEdge(edge),
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
const JUMP_MUTED = "#4B535F";

/**
 * The jump-to-flow satellites for the current selection: every flow that TRANSITIVELY reaches the
 * selected target (a direct caller at depth 1, its caller at depth 2, …, up to `ghostDepth`), each
 * a dashed ghost node. Ghosts stack in horizontal ROWS clear ABOVE the graph — depth 1 just above
 * the graph's top edge, each further hop a row higher — every row centred on the selected call site.
 * The wires among them trace the CALL CHAIN (see `buildChainEdges`), not a fan to the selection: a
 * depth-2 ghost points at the depth-1 ghost it actually calls, which in turn points at the selected
 * block. Purely additive: it reads the store's laid-out nodes but never mutates them, so selection
 * and the depth dial stay repaints (no relayout). Empty unless a target is selected and reached elsewhere.
 */
function buildJumpSatellites(
  nodes: LogicRfNode[],
  logicSelected: NodeId | null,
  logicRoot: NodeId,
  containment: Map<string, string[]>,
  index: GraphIndex,
  ghostDepth: number,
): { jumpNodes: Node[]; jumpEdges: Edge[]; total: number } {
  if (logicSelected === null) {
    return { jumpNodes: [], jumpEdges: [], total: 0 };
  }
  // Walk the reverse call graph back `ghostDepth` hops (GHOST_DEPTH_ALL == the whole closure); drop
  // the flow we're already looking at, then keep the NEAREST callers when over the cap (BFS keys
  // depth-ascending, so sort makes it explicit). `total` is the countable set before the cap, so the
  // caller can surface how many the 24-ghost cap left undrawn.
  const callers = transitiveCallers(containment, logicSelected, ghostDepth);
  callers.delete(logicRoot);
  const total = callers.size;
  const ranked = [...callers.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_JUMPS_TOTAL);
  const callSite = nodes.find((node) => node.data.targetId === logicSelected);
  if (ranked.length === 0 || !callSite) {
    return { jumpNodes: [], jumpEdges: [], total };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const top = graphTop(nodes, byId);
  const sel = absolutePos(callSite, byId);
  const selWidth = callSite.width ?? JUMP_WIDTH;
  const byDepth = groupByDepth(ranked);

  const jumpNodes: Node[] = [];
  for (const [depth, roots] of byDepth) {
    // This depth's row sits `depth` clear gaps ABOVE the graph's top edge, so deeper (more indirect)
    // callers stack higher. It's centred on the selected call site so the chain reads top→down into it.
    const rowY = top - depth * (JUMP_HEIGHT + JUMP_ROW_GAP);
    const totalWidth = roots.length * JUMP_WIDTH + (roots.length - 1) * JUMP_COL_GAP;
    const startX = sel.x + selWidth / 2 - totalWidth / 2;
    roots.forEach((root, i) => {
      const node = index.nodesById.get(root);
      jumpNodes.push({
        id: `jump:${root}`,
        type: "jumpflow",
        position: { x: startX + i * (JUMP_WIDTH + JUMP_COL_GAP), y: rowY },
        width: JUMP_WIDTH,
        height: JUMP_HEIGHT,
        selectable: false,
        draggable: false,
        data: { rootId: root, label: node?.displayName ?? root, file: node?.location?.file, depth } satisfies JumpFlowNodeData,
      });
    });
  }
  const jumpEdges = buildChainEdges(ranked, logicSelected, callSite.id, containment);
  return { jumpNodes, jumpEdges, total };
}

/**
 * The satellite wires, drawn as the reverse-call CHAIN AMONG the rendered ghosts — NOT a fan pointing
 * every ghost straight at the selected node. For A→B→C with C selected, this yields A→B and B→C.
 *
 * The containment map is read as a reverse call graph: `X ∈ containment.get(N)` means "X calls N", so
 * X's ghost points at N — the node ONE HOP CLOSER to the selection. So for each node N in {selected}
 * ∪ {rendered ghosts}, every rendered caller X of N gets an edge `jump:X` → (N is the selection ? its
 * call-site node : `jump:N`). Depth-1 ghosts thus land on the selected call site; a depth-2 ghost
 * lands on the depth-1 ghost it calls; and so on up the tree.
 *
 * ORPHAN FALLBACK: near the 24-cap a ghost's own callee may be undrawn, leaving it with no outgoing
 * edge; it's then wired straight to the selected call site so it never dangles. Edges dedupe on their
 * source→target pair. The "contains" label rides ONLY the genuine direct-caller edges into the
 * selected node; ghost→ghost and fallback edges stay unlabeled (the vertical chain is self-evident).
 */
function buildChainEdges(
  ranked: Array<[string, number]>,
  logicSelected: NodeId,
  callSiteNodeId: string,
  containment: Map<string, string[]>,
): Edge[] {
  const rendered = new Set(ranked.map(([root]) => root));
  const edges: Edge[] = [];
  const seenPairs = new Set<string>();
  const emitted = new Set<string>();

  // Link each rendered caller X of `target` to `target`'s rendered node (`X ∈ containment.get(N)` ⇒
  // edge X→N). Skips a self-call (a recursive root is its own caller) and any caller not rendered.
  const linkCallers = (target: string, targetNodeId: string, labeled: boolean) => {
    for (const caller of containment.get(target) ?? []) {
      if (caller === target || !rendered.has(caller)) {
        continue;
      }
      const source = `jump:${caller}`;
      const pair = `${source}->${targetNodeId}`;
      if (seenPairs.has(pair)) {
        continue;
      }
      seenPairs.add(pair);
      emitted.add(caller);
      edges.push(jumpEdge(source, targetNodeId, pair, labeled));
    }
  };

  // The selected block's direct callers point at its call site (labeled "contains"); every rendered
  // ghost's direct callers point at that ghost (unlabeled — a link in the chain, not a container).
  linkCallers(logicSelected, callSiteNodeId, true);
  for (const root of rendered) {
    linkCallers(root, `jump:${root}`, false);
  }

  // A ghost whose callee fell outside the cap has no outgoing edge yet; wire it to the selected call
  // site so it never dangles. Unlabeled: it isn't a direct caller of the selection.
  for (const root of rendered) {
    if (emitted.has(root)) {
      continue;
    }
    const source = `jump:${root}`;
    const pair = `${source}->${callSiteNodeId}`;
    seenPairs.add(pair);
    emitted.add(root);
    edges.push(jumpEdge(source, callSiteNodeId, pair, false));
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

// The click handlers run for every node on the surface, including the appended jump satellites. A
// satellite carries no logic data and owns its own click, so hand back logic data only for real nodes.
function logicDataOf(node: Node): LogicNodeData | null {
  return node.type === "jumpflow" ? null : (node.data as LogicNodeData);
}

// The MiniMap gets untyped `Node`s; narrow to our logic data and mirror each node type's accent.
function miniMapColor(node: Node): string {
  const data = node.data as LogicNodeData;
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

/**
 * The floating overlay header, offset to clear the Toolbar's top-left column: the drill breadcrumb
 * on the left, and on the right the "related flows" depth dial beside the "hide leaf blocks" toggle.
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
      </div>
      <div style={HEADER_CONTROLS_STYLE}>
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
          {props.hideGreyed ? "Show leaf blocks" : "Hide leaf blocks"}
        </button>
      </div>
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
  const { showCode, expandCode } = useBlueprintActions();
  const rootNode = index.nodesById.get(props.rootId);
  const rootName = rootNode?.displayName ?? props.rootId;
  const canShowCode = Boolean(rootNode?.location) && Boolean(sourceUrl);
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
              void showCode(rootNode);
              expandCode();
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
  minWidth: 0,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "4px 8px",
};

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
