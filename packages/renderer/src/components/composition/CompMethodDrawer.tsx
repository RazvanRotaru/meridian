/**
 * EXPERIMENT — the composition-tab method-preview drawer. When a scorecard member is clicked
 * (`compMethodId` set), this docks a read-only logic-flow surface on the RIGHT of the composition
 * map so a reader can inspect "how this method works" WITHOUT leaving the UML-like composition view.
 *
 * It mirrors LogicFlowView's surface: the same READONLY_CANVAS_PROPS + CanvasChrome over the store's
 * pre-laid-out `compMethodRf*` nodes/edges, rendered with `logicNodeTypes`. It is READ-ONLY in the
 * strict sense — no drill/expand/select wiring; it's a peek, and double-clicking a member instead
 * navigates to the full interactive Logic tab. Its own ReactFlowProvider isolates its React Flow
 * store from the composition surface's (two <ReactFlow>s under one provider would fight over it).
 */

import { ReactFlow, ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { logicNodeTypes } from "../nodes/logic/logicNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "../canvas/flowCanvasProps";
import type { LogicNodeData } from "../../derive/logicGraph";

export function CompMethodDrawer() {
  const methodId = useBlueprint((state) => state.compMethodId);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const { selectCompMethod } = useBlueprintActions();
  if (methodId === null) {
    return null;
  }
  const label = nodesById.get(methodId)?.displayName ?? methodId;
  return (
    <aside style={DRAWER}>
      <header style={HEADER}>
        <span style={GLYPH}>ƒ</span>
        <span style={TITLE} title={methodId}>{label}</span>
        <button type="button" style={CLOSE} title="Close preview" onClick={() => selectCompMethod(null)}>
          ✕
        </button>
      </header>
      <div style={BODY}>
        {/* A fresh provider per method so re-picking gives a clean React Flow store — and so it never
            shares the composition surface's store. */}
        <ReactFlowProvider key={methodId}>
          <DrawerSurface />
        </ReactFlowProvider>
      </div>
    </aside>
  );
}

function DrawerSurface() {
  const nodes = useBlueprint((state) => state.compMethodRfNodes);
  const edges = useBlueprint((state) => state.compMethodRfEdges);
  const status = useBlueprint((state) => state.compMethodLayoutStatus);
  // A callable with no calls/control flow of its own lays out to nothing — say so rather than show a
  // silent blank surface (mirrors LogicFlowView's empty-flow card).
  if (nodes.length === 0 && status === "ready") {
    return (
      <div style={EMPTY}>
        <span style={EMPTY_MARK}>∅</span>
        <span>This method has no charted call flow.</span>
      </div>
    );
  }
  return (
    <ReactFlow<Node, Edge> nodes={nodes} edges={edges} nodeTypes={logicNodeTypes} {...READONLY_CANVAS_PROPS}>
      <CanvasChrome nodeColor={miniMapColor} />
    </ReactFlow>
  );
}

// The drawer minimap tints logic nodes exactly like the full Logic view's minimap, so a previewed
// flow reads the same in both places.
function miniMapColor(node: Node): string {
  const data = node.data as LogicNodeData;
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Docked to the right edge, full height, over the composition canvas. A fixed share of the width so
// the map stays visible beside it; the left border reads as the seam between map and preview.
const DRAWER: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: "42%",
  minWidth: 360,
  maxWidth: 640,
  display: "flex",
  flexDirection: "column",
  background: "#0B0E13",
  borderLeft: "1px solid #222732",
  boxShadow: "-12px 0 32px rgba(0,0,0,0.45)",
  zIndex: 5,
};

const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid #1B2028",
  background: "#0E1116",
};

const GLYPH: React.CSSProperties = { color: "#5E74C6", fontSize: 13, flexShrink: 0 };
const TITLE: React.CSSProperties = {
  flex: 1,
  fontFamily: MONO,
  fontSize: 12.5,
  color: "#D6DEE9",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CLOSE: React.CSSProperties = {
  flexShrink: 0,
  width: 22,
  height: 22,
  border: "1px solid #2A313D",
  borderRadius: 5,
  background: "transparent",
  color: "#9AA4B2",
  cursor: "pointer",
  fontSize: 11,
  lineHeight: 1,
};

const BODY: React.CSSProperties = { position: "relative", flex: 1, minHeight: 0 };

const EMPTY: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "#6B7482",
  fontSize: 12.5,
};
const EMPTY_MARK: React.CSSProperties = { fontSize: 26, color: "#3A414C" };
