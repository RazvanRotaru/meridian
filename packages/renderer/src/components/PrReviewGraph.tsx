/**
 * The PR-review GRAPH pane: a read-only React Flow over the store's laid-out minimal containment
 * subgraph (`prReviewRfNodes`/`prReviewRfEdges`), mirroring `ModuleMapView` — never a relayout, only
 * pure PAINT over placed nodes. Selecting a flow row (`reviewSelectedFlowId`) outlines its touched
 * modules, dims the rest, and animated-fits the camera to them; hovering a row outlines only (no dim,
 * no camera). Clicking a non-boundary file card sets the list's file filter (a toggle); clicking the
 * pane clears it. A floating panel carries the Hide-boundary toggle and the changed/boundary legend.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { ReactFlow, type Edge, type Node, type NodeMouseHandler, type ReactFlowInstance } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { reviewNodeTypes } from "./nodes/prreview/ReviewNodeTypes";
import { CanvasChrome, READONLY_CANVAS_PROPS } from "./canvas/flowCanvasProps";
import { REVIEW_FILE_NODE, type ReviewFileNodeData } from "../layout/minimalSubgraphLayout";
import type { RankedReviewFlow } from "../derive/reviewFlows";
import { ReviewGraphPanel } from "./PrReviewGraphPanel";
import {
  paintReviewEdges,
  paintReviewNodes,
  reviewMiniMapColor,
  SURFACE_STYLE,
  touchedIdSet,
} from "./prReviewGraphStyles";

export function PrReviewGraph() {
  const nodes = useBlueprint((state) => state.prReviewRfNodes);
  const edges = useBlueprint((state) => state.prReviewRfEdges);
  const reviewModel = useBlueprint((state) => state.reviewModel);
  const selectedFlowId = useBlueprint((state) => state.reviewSelectedFlowId);
  const hoverFlowId = useBlueprint((state) => state.reviewHoverFlowId);
  const filterFileId = useBlueprint((state) => state.reviewListFilterFileId);
  const hideBoundary = useBlueprint((state) => state.reviewHideBoundary);
  const { selectReviewFlow, setReviewListFilter, toggleReviewHideBoundary } = useBlueprintActions();

  // Clearing the surface: drop the highlighted flow AND the file filter chip in one gesture, so the
  // graph returns to its whole-view unhighlighted state. Shared by the pane click and the Escape key.
  const clearSelection = useCallback(() => {
    selectReviewFlow(null);
    setReviewListFilter(null);
  }, [selectReviewFlow, setReviewListFilter]);
  useClearOnEscape(clearSelection, selectedFlowId !== null || filterFileId !== null);

  // rootId -> flow, so a selection/hover resolves to its touched modules in O(1).
  const flowById = useMemo(() => {
    const map = new Map<string, RankedReviewFlow>();
    reviewModel?.flows.forEach((flow) => map.set(flow.rootId, flow));
    return map;
  }, [reviewModel]);
  const selectedFlow = selectedFlowId ? flowById.get(selectedFlowId) : undefined;
  const selectedIds = useMemo(() => touchedIdSet(selectedFlow), [selectedFlow]);
  const hoverIds = useMemo(() => touchedIdSet(hoverFlowId ? flowById.get(hoverFlowId) : undefined), [flowById, hoverFlowId]);

  // Two pure repaints over the placed graph — positions are untouched (mirrors moduleMapPaint).
  const styledNodes = useMemo(() => paintReviewNodes(nodes, selectedIds, hoverIds), [nodes, selectedIds, hoverIds]);
  const styledEdges = useMemo(() => paintReviewEdges(edges, selectedIds, hoverIds), [edges, selectedIds, hoverIds]);

  // A file card toggles the list filter to its file; a second click (or a pane click) clears it.
  // Boundary/frame nodes never set the filter (they're context, not a reviewable file).
  const onNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type !== REVIEW_FILE_NODE) {
      return;
    }
    const data = node.data as ReviewFileNodeData;
    if (data.isBoundary) {
      return;
    }
    setReviewListFilter(filterFileId === data.fullPath ? null : data.fullPath);
  };

  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useFitGuards(rfRef, nodes, selectedFlowId, selectedFlow);

  return (
    <div style={SURFACE_STYLE}>
      <ReactFlow<Node, Edge>
        nodes={styledNodes}
        edges={styledEdges}
        nodeTypes={reviewNodeTypes}
        onInit={(instance) => {
          rfRef.current = instance;
        }}
        onNodeClick={onNodeClick}
        onPaneClick={clearSelection}
        {...READONLY_CANVAS_PROPS}
      >
        <CanvasChrome nodeColor={reviewMiniMapColor} />
      </ReactFlow>
      <ReviewGraphPanel hideBoundary={hideBoundary} onToggleBoundary={toggleReviewHideBoundary} />
    </div>
  );
}

/**
 * Two camera guards, each keyed on a ref so it fires once per change:
 *   - a fresh LAYOUT (new `nodes` array) fits the whole graph, like ModuleMapView;
 *   - a SELECTION change fits the flow's touched modules (or the whole graph when cleared).
 * The layout guard runs first and adopts the current selection so a relayout doesn't double-fit.
 */
function useFitGuards(
  rfRef: React.MutableRefObject<ReactFlowInstance<Node, Edge> | null>,
  nodes: Node[],
  selectedFlowId: string | null,
  selectedFlow: RankedReviewFlow | undefined,
): void {
  const laidRef = useRef<Node[] | null>(null);
  const fitKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const rf = rfRef.current;
    if (!rf || nodes.length === 0 || laidRef.current === nodes) {
      return;
    }
    laidRef.current = nodes;
    fitKeyRef.current = selectedFlowId;
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 }));
  }, [rfRef, nodes, selectedFlowId]);
  useEffect(() => {
    const rf = rfRef.current;
    if (!rf || nodes.length === 0 || fitKeyRef.current === selectedFlowId) {
      return;
    }
    fitKeyRef.current = selectedFlowId;
    const targets = selectedFlow?.touchedModuleIds ?? [];
    requestAnimationFrame(() => {
      if (targets.length > 0) {
        rf.fitView({ nodes: targets.map((id) => ({ id })), padding: 0.3, duration: 500, minZoom: 0.01 });
      } else {
        rf.fitView({ padding: 0.2, duration: 400, minZoom: 0.01 });
      }
    });
  }, [rfRef, nodes, selectedFlowId, selectedFlow]);
}

/**
 * Clear the review selection/filter on Escape, but only while something IS highlighted — otherwise
 * the listener stays off so the key is free for other handlers. Never preventDefault (a modal's own
 * Escape must still fire); ignore Escape typed into an editable field.
 */
function useClearOnEscape(clear: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        clear();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clear, active]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}
