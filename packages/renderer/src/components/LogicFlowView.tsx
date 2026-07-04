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

import { Fragment, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type EdgeMarker,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { GraphArtifact, GraphNode, LogicFlows, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { logicNodeTypes } from "./nodes/logic/logicNodeTypes";
import type { LogicRfNode, LogicRfEdge } from "../layout/logicElk";
import type { LogicNodeData } from "../derive/logicGraph";

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
  const logicStack = useBlueprint((state) => state.logicStack);
  const nodes = useBlueprint((state) => state.logicRfNodes);
  const edges = useBlueprint((state) => state.logicRfEdges);
  const logicSelected = useBlueprint((state) => state.logicSelected);
  const layoutStatus = useBlueprint((state) => state.logicLayoutStatus);
  const hideGreyed = useBlueprint((state) => state.hideGreyed);
  const index = useBlueprint((state) => state.index);
  const { drillLogicFlow, logicFlowTo, toggleHideGreyed, selectLogicTarget } = useBlueprintActions();

  // The one gesture the node components don't own: dive into a resolved, flow-bearing block's own
  // flow. Inline expand/collapse is a title-click, handled inside the node — never re-handled here.
  const onNodeDoubleClick: NodeMouseHandler<LogicRfNode> = (_event, node) => {
    if (node.data.expandable && node.data.targetId !== null) {
      drillLogicFlow(node.data.targetId);
    }
  };

  // Single-click a building block to trace its call target: selection is BY TARGET, so every call
  // site of the same target lights up. Re-clicking the selected target clears it; container/branch
  // nodes (no target) do nothing. A cheap repaint — no relayout.
  const onNodeClick: NodeMouseHandler<LogicRfNode> = (_event, node) => {
    const target = node.data.targetId;
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

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<LogicRfNode, LogicRfEdge>
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={logicNodeTypes}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => selectLogicTarget(null)}
        colorMode="dark"
        nodesDraggable={false}
        nodesConnectable={false}
        // Click-drag pans; it must never rubber-band select or text-highlight node labels.
        panOnDrag
        selectionOnDrag={false}
        style={{ userSelect: "none" }}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.01 }}
        // A deep flow can be many nodes; let it zoom far out (default minZoom 0.5 clips) but cap zoom-in.
        minZoom={0.01}
        maxZoom={4}
        // Double-click drills into a callee, so the pane must not also zoom on it.
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#222732" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={miniMapColor} maskColor="rgba(8,10,14,0.7)" />
      </ReactFlow>
      <LogicOverlayHeader
        stack={logicStack}
        nodesById={index.nodesById}
        onJump={logicFlowTo}
        hideGreyed={hideGreyed}
        onToggleHide={toggleHideGreyed}
      />
      {isEmpty ? <EmptyFlowCard rootId={props.rootId} /> : null}
    </div>
  );
}

// The accent green shared with the selected node ring: the emphasized wires glow the same colour so
// a selected target and the threads leaving/entering its call sites read as one highlight.
const SELECT_ACCENT = "#6BE38A";
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
 * on the left, the "hide leaf blocks" toggle on the right. Its own container ignores pointer events
 * so the gap between the two still pans the canvas; each control re-enables them for itself.
 */
function LogicOverlayHeader(props: {
  stack: NodeId[];
  nodesById: ReadonlyMap<string, GraphNode>;
  onJump: (id: NodeId) => void;
  hideGreyed: boolean;
  onToggleHide: () => void;
}) {
  return (
    <div style={OVERLAY_HEADER_STYLE}>
      <div style={HEADER_PANEL_STYLE}>
        <LogicBreadcrumb stack={props.stack} nodesById={props.nodesById} onJump={props.onJump} />
      </div>
      <button
        type="button"
        style={hideToggleStyle(props.hideGreyed)}
        aria-pressed={props.hideGreyed}
        onClick={props.onToggleHide}
      >
        {props.hideGreyed ? "Show leaf blocks" : "Hide leaf blocks"}
      </button>
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
          Pick an entry point, search a method, or double-click one in Call flow.
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

/** The drill trail root..current; each segment jumps back to that callable's flow. */
function LogicBreadcrumb(props: {
  stack: NodeId[];
  nodesById: ReadonlyMap<string, GraphNode>;
  onJump: (id: NodeId) => void;
}) {
  return (
    <nav style={BREADCRUMB_STYLE} aria-label="Logic flow trail">
      {props.stack.map((id, position) => {
        const current = position === props.stack.length - 1;
        return (
          <Fragment key={`${id}:${position}`}>
            {position > 0 ? <span style={CRUMB_SEP_STYLE} aria-hidden>›</span> : null}
            <button
              type="button"
              style={current ? CRUMB_CURRENT_STYLE : CRUMB_STYLE}
              onClick={() => props.onJump(id)}
              aria-current={current ? "page" : undefined}
              title={id}
            >
              {props.nodesById.get(id)?.displayName ?? id}
            </button>
          </Fragment>
        );
      })}
    </nav>
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
