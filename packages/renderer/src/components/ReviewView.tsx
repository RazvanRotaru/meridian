/**
 * The PR-review page: a minimal graph of the affected CODE BLOCKS on the left, the touched logic
 * flows (grouped, hierarchical) on the right.
 *
 * The graph is laid out in the store (`reviewRfNodes`/`reviewRfEdges`) as file/class frames holding
 * the changed function/method leaves — never a whole file, only the blocks that overlap the diff.
 * The two halves are coupled by artifact node id: hovering a flow (or a changed call inside it) on
 * the right lights the matching blocks on the left; clicking a block selects it and its flow row.
 * Read-only React Flow surface, mirroring the Module map.
 */

import { useEffect, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { reviewNodeTypes } from "./nodes/review/reviewNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { ReviewFlowPanel } from "./review/ReviewFlowPanel";
import { accentForKind } from "../theme/kindColors";
import type { ReviewNodeData } from "../derive/reviewNodeGraph";

export function ReviewView() {
  const nodes = useBlueprint((state) => state.reviewRfNodes);
  const edges = useBlueprint((state) => state.reviewRfEdges);
  const layoutStatus = useBlueprint((state) => state.reviewLayoutStatus);
  const { reviewRelayout, selectReviewNode } = useBlueprintActions();

  // Lay out on first mount (the store boots idle). Re-entry keeps the graph, so this only runs once.
  useEffect(() => {
    if (layoutStatus === "idle" && nodes.length === 0) {
      void reviewRelayout();
    }
  }, [layoutStatus, nodes.length, reviewRelayout]);

  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    if (!rfRef.current || nodes.length === 0 || fitted.current) {
      return;
    }
    fitted.current = true;
    // Reserve ~360px on the left so the fitted graph clears the always-mounted Toolbar overlay
    // (the flow panel is a real sibling on the right, so it needs no reservation).
    requestAnimationFrame(() =>
      rfRef.current?.fitView({ padding: { left: "372px", right: "32px", top: "32px", bottom: "32px" }, duration: 400, minZoom: 0.05 }),
    );
  }, [nodes]);

  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    const nodeId = (node.data as ReviewNodeData).nodeId;
    selectReviewNode(nodeId);
  };

  const isEmpty = nodes.length === 0 && layoutStatus === "ready";

  return (
    <div style={SURFACE}>
      <div style={CANVAS_WRAP}>
        <ReactFlow<Node, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={reviewNodeTypes}
          onInit={(instance) => {
            rfRef.current = instance;
          }}
          onNodeClick={onNodeClick}
          onPaneClick={() => selectReviewNode(null)}
          {...READONLY_CANVAS_PROPS}
        >
          <CanvasChrome nodeColor={miniMapColor} />
        </ReactFlow>
        {isEmpty ? <EmptyGraphCard /> : null}
      </div>
      <ReviewFlowPanel />
    </div>
  );
}

/** No code block overlapped the diff — the change is all imports/comments/deletions. Never a blank canvas. */
function EmptyGraphCard() {
  return (
    <div style={EMPTY_WRAP}>
      <div style={EMPTY_CARD}>
        <span style={EMPTY_MARK}>∅</span>
        <span>No changed code blocks to graph — the diff touches only files with no extracted, overlapping function or method. See the flow panel and "Not in the graph".</span>
      </div>
    </div>
  );
}

function miniMapColor(node: Node): string {
  const data = node.data as ReviewNodeData;
  if (node.type === "reviewFile" || node.type === "reviewGroup") {
    return "#2A313C";
  }
  return accentForKind(data.nodeKind);
}

const SURFACE: React.CSSProperties = { position: "absolute", inset: 0, display: "flex", background: "#0E1116" };
const CANVAS_WRAP: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0, height: "100%" };
const EMPTY_WRAP: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  pointerEvents: "none",
  padding: "0 48px",
};
const EMPTY_CARD: React.CSSProperties = {
  pointerEvents: "auto",
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: 520,
  border: "1px dashed #2A2F37",
  borderRadius: 10,
  background: "#12171E",
  padding: "16px 18px",
  fontSize: 13,
  color: "#7B8695",
};
const EMPTY_MARK: React.CSSProperties = { fontSize: 22, opacity: 0.5 };
