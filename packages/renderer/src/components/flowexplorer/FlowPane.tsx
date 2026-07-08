import { useEffect, useRef } from "react";
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { logicNodeTypes } from "../nodes/logic/logicNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "../canvas/flowCanvasProps";
import type { LogicNodeData } from "../../derive/logicGraph";
import { blockBreadcrumbs } from "./flowBlockLabels";
import { ancestorSelection, selectionKey } from "./flowSelection";
import { useLogicFlows } from "./useFlowTree";

export function FlowPane() {
  const selection = useBlueprint((state) => state.flowSelection);
  const nodesById = useBlueprint((state) => state.index.nodesById);
  const flows = useLogicFlows();
  const { selectFlowEntry, openLogicFlow } = useBlueprintActions();
  if (selection === null) {
    return null;
  }
  const rootLabel = nodesById.get(selection.rootId)?.displayName ?? selection.rootId;
  const crumbs = blockBreadcrumbs(flows, selection);
  return (
    <aside style={DRAWER}>
      <header style={HEADER}>
        <div style={TITLE_ROW}>
          <span style={GLYPH}>ƒ</span>
          <span style={TITLE} title={selection.rootId}>{rootLabel}</span>
          <button type="button" style={OPEN_BUTTON} onClick={() => openLogicFlow(selection.rootId)}>
            Open in Logic flow
          </button>
          <button type="button" style={CLOSE} title="Close flow pane" onClick={() => selectFlowEntry(null)}>
            ✕
          </button>
        </div>
        <nav style={BREADCRUMBS} aria-label="Selected flow block">
          <button type="button" style={CRUMB} onClick={() => selectFlowEntry(ancestorSelection(selection, 0))}>
            {rootLabel}
          </button>
          {crumbs.map((crumb) => (
            <span key={selectionKey(crumb.ref)} style={CRUMB_GROUP}>
              <span style={CRUMB_SEP}>›</span>
              <button type="button" style={CRUMB} onClick={() => selectFlowEntry(crumb.ref)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      </header>
      <div style={BODY}>
        <ReactFlowProvider key={selectionKey(selection)}>
          <FlowPaneSurface />
        </ReactFlowProvider>
      </div>
    </aside>
  );
}

function FlowPaneSurface() {
  const nodes = useBlueprint((state) => state.flowPaneRfNodes);
  const edges = useBlueprint((state) => state.flowPaneRfEdges);
  const status = useBlueprint((state) => state.flowPaneLayoutStatus);
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fittedNodes = useRef<readonly Node[] | null>(null);

  const fitReadyNodes = (instance: ReactFlowInstance<Node, Edge>) => {
    if (status !== "ready" || nodes.length === 0 || fittedNodes.current === nodes) {
      return;
    }
    fittedNodes.current = nodes;
    requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.15, maxZoom: 1.25 });
    });
  };

  useEffect(() => {
    if (!rfRef.current) {
      return;
    }
    fitReadyNodes(rfRef.current);
  }, [nodes, status]);

  if (nodes.length === 0 && status === "laying-out") {
    return <PaneMessage mark="…" text="Laying out flow." />;
  }
  if (nodes.length === 0 && status === "ready") {
    return <PaneMessage mark="∅" text="This block has no charted call flow." />;
  }
  if (status === "error") {
    return <PaneMessage mark="!" text="Could not lay out this flow." />;
  }
  return (
    <ReactFlow<Node, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={logicNodeTypes}
      onInit={(instance) => {
        rfRef.current = instance;
        fittedNodes.current = null;
        fitReadyNodes(instance);
      }}
      {...READONLY_CANVAS_PROPS}
    >
      <CanvasChrome nodeColor={miniMapColor} />
    </ReactFlow>
  );
}

function PaneMessage(props: { mark: string; text: string }) {
  return (
    <div style={EMPTY}>
      <span style={EMPTY_MARK}>{props.mark}</span>
      <span>{props.text}</span>
    </div>
  );
}

function miniMapColor(node: Node): string {
  const data = node.data as LogicNodeData;
  if (data.logicKind === "loop") return "#E6B84D";
  if (data.logicKind === "try") return "#D98A5B";
  if (data.logicKind === "if" || data.logicKind === "switch") return "#61DAFB";
  return data.greyed ? "#3A414C" : "#3B7AC0";
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const DRAWER: React.CSSProperties = {
  width: "42%",
  minWidth: 360,
  maxWidth: 640,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#0B0E13",
  borderLeft: "1px solid #222732",
  boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
  color: "#D6DEE9",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  borderBottom: "1px solid #1B2028",
  background: "#0E1116",
};

const TITLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const GLYPH: React.CSSProperties = { color: "#56C271", fontSize: 13, flexShrink: 0 };
const TITLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 12.5,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const OPEN_BUTTON: React.CSSProperties = {
  border: "1px solid #2A313D",
  borderRadius: 5,
  background: "#151B24",
  color: "#C9D3E0",
  padding: "4px 8px",
  fontSize: 12,
  cursor: "pointer",
};
const CLOSE: React.CSSProperties = {
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
const BREADCRUMBS: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const CRUMB_GROUP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, minWidth: 0 };
const CRUMB_SEP: React.CSSProperties = { color: "#4E5867", fontSize: 12 };
const CRUMB: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#98A3B3",
  padding: 0,
  fontSize: 11.5,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
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
