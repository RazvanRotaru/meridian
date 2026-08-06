/** Non-blocking, per-node status markers for progressive nearby-graph hydration. */

import { useMemo } from "react";
import { ViewportPortal, useStore, useViewport, type Node } from "@xyflow/react";
import {
  SEMANTIC_LAYER_CLASS,
  semanticLayerClass,
} from "../../derive/moduleSemanticComposite";
import { CONSTRUCT } from "../../theme/mapPalette";
import {
  ghostPromotionTarget,
  nodeCornerMarkerWrap,
  nodeTopRightCorner,
  NODE_CORNER_MARKER_SIZE,
} from "./GhostPromoteRing";

export interface NearbyGraphLoadingIndicatorsProps {
  /** The exact nodes painted by the active React Flow surface. */
  visibleNodes: readonly Node[];
  /** Canonical operation IDs whose nearby graph is currently loading. */
  pendingNodeIds: ReadonlySet<string>;
  /** Resolve a hidden callable operation to its visible promoted home member. */
  resolvePendingNodeId?: (
    pendingNodeId: string,
    visibleNodeIds: ReadonlySet<string>,
  ) => string | null;
}

/**
 * Replace a pending ghost's `+` with a spinner on the same corner, then move that spinner to the
 * admitted real representative while nearby hydration continues. The marker lives in flow space,
 * scales with its node, and never intercepts graph inspection.
 */
export function NearbyGraphLoadingIndicators({
  visibleNodes,
  pendingNodeIds,
  resolvePendingNodeId,
}: NearbyGraphLoadingIndicatorsProps) {
  const pendingNodes = useMemo(
    () => visiblePendingNodes(visibleNodes, pendingNodeIds, resolvePendingNodeId),
    [pendingNodeIds, resolvePendingNodeId, visibleNodes],
  );
  if (pendingNodes.length === 0) return null;

  return <VisibleNearbyGraphLoadingIndicators visibleNodes={visibleNodes} pendingNodes={pendingNodes} />;
}

function VisibleNearbyGraphLoadingIndicators({
  visibleNodes,
  pendingNodes,
}: {
  visibleNodes: readonly Node[];
  pendingNodes: readonly Node[];
}) {
  const viewport = useViewport();
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const byId = useMemo(() => new Map(visibleNodes.map((node) => [node.id, node])), [visibleNodes]);
  const markers = useMemo(
    () => pendingNodes
      .filter((node) => intersectsViewport(node, byId, viewport, canvasWidth, canvasHeight))
      .map((node) => ({ node, corner: nodeTopRightCorner(node, byId) })),
    [byId, canvasHeight, canvasWidth, pendingNodes, viewport],
  );
  if (markers.length === 0) return null;

  return (
    <>
      <style>{SPINNER_CSS}</style>
      <ViewportPortal>
        {markers.map(({ node, corner }) => (
          <div
            key={node.id}
            className={markerClass(semanticDepthOf(node))}
            style={nodeCornerMarkerWrap(corner, "none")}
          >
            <span
              className="nodrag nopan nowheel"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={STATUS_STYLE}
              data-nearby-graph-loading-node-id={node.id}
            >
              <span
                aria-hidden="true"
                className="nearby-graph-loading-spinner"
                style={SPINNER_STYLE}
              />
              <span style={SCREEN_READER_ONLY}>Loading nearby graph for {nodeLabel(node)}.</span>
            </span>
          </div>
        ))}
      </ViewportPortal>
    </>
  );
}

function visiblePendingNodes(
  visibleNodes: readonly Node[],
  pendingNodeIds: ReadonlySet<string>,
  resolvePendingNodeId: NearbyGraphLoadingIndicatorsProps["resolvePendingNodeId"],
): Node[] {
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  // Prefer a stable admitted representative over the temporary ghost that initiated the same
  // operation. Before admission there is no stable target, so the spinner replaces the suppressed
  // `+` on that ghost instead of leaving the reader without feedback.
  const admittedNodeIds = new Set(
    visibleNodes
      .filter((node) => ghostPromotionTarget(node) === null)
      .map((node) => node.id),
  );
  const loadingNodeIds = new Set<string>();
  pendingNodeIds.forEach((pendingNodeId) => {
    const admittedId = admittedNodeIds.has(pendingNodeId)
      ? pendingNodeId
      : resolvePendingNodeId?.(pendingNodeId, admittedNodeIds) ?? null;
    if (admittedId !== null && admittedNodeIds.has(admittedId)) {
      loadingNodeIds.add(admittedId);
      return;
    }
    const temporaryId = visibleNodeIds.has(pendingNodeId)
      ? pendingNodeId
      : resolvePendingNodeId?.(pendingNodeId, visibleNodeIds) ?? null;
    if (temporaryId !== null && visibleNodeIds.has(temporaryId)) {
      loadingNodeIds.add(temporaryId);
    }
  });
  return visibleNodes.filter((node) => loadingNodeIds.has(node.id));
}

const VIEWPORT_OVERSCAN = NODE_CORNER_MARKER_SIZE;

function intersectsViewport(
  node: Node,
  byId: ReadonlyMap<string, Node>,
  viewport: { x: number; y: number; zoom: number },
  canvasWidth: number,
  canvasHeight: number,
): boolean {
  if (canvasWidth <= 0 || canvasHeight <= 0 || viewport.zoom <= 0) return false;
  const corner = nodeTopRightCorner(node, byId);
  const style = (node.style ?? {}) as { height?: unknown };
  const measuredHeight = node.measured?.height;
  const candidates = [style.height, measuredHeight, node.height, node.initialHeight];
  const height = candidates.find((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0) ?? 0;
  const left = corner.x * viewport.zoom + viewport.x;
  const top = corner.y * viewport.zoom + viewport.y;
  const right = corner.right * viewport.zoom + viewport.x;
  const bottom = top + height * viewport.zoom;
  return right >= -VIEWPORT_OVERSCAN
    && bottom >= -VIEWPORT_OVERSCAN
    && left <= canvasWidth + VIEWPORT_OVERSCAN
    && top <= canvasHeight + VIEWPORT_OVERSCAN;
}

function nodeLabel(node: Node): string {
  const data = node.data as { label?: unknown; displayName?: unknown };
  if (typeof data.label === "string" && data.label.length > 0) return data.label;
  if (typeof data.displayName === "string" && data.displayName.length > 0) return data.displayName;
  return node.id;
}

function semanticDepthOf(node: Node): number | undefined {
  const depth = (node.data as { semanticDepth?: unknown }).semanticDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth >= 0 ? depth : undefined;
}

function markerClass(depth: number | undefined): string {
  return depth === undefined
    ? "nearby-graph-loading-node-marker"
    : `nearby-graph-loading-node-marker ${SEMANTIC_LAYER_CLASS} ${semanticLayerClass(depth)}`;
}

const STATUS_STYLE: React.CSSProperties = {
  width: NODE_CORNER_MARKER_SIZE,
  height: NODE_CORNER_MARKER_SIZE,
  boxSizing: "border-box",
  display: "grid",
  placeItems: "center",
  border: "1px solid #3A4452",
  borderRadius: "50%",
  background: "#1B222C",
  boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
  pointerEvents: "none",
};

const SPINNER_STYLE: React.CSSProperties = {
  width: 11,
  height: 11,
  boxSizing: "border-box",
  border: "1.5px solid rgba(174,184,196,0.28)",
  borderTopColor: CONSTRUCT,
  borderRightColor: CONSTRUCT,
  borderRadius: "50%",
};

const SPINNER_CSS = `
@keyframes nearby-graph-loading-spin {
  to { transform: rotate(360deg); }
}
.nearby-graph-loading-node-marker {
  pointer-events: none !important;
}
.nearby-graph-loading-spinner {
  animation: nearby-graph-loading-spin 1200ms linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .nearby-graph-loading-spinner {
    animation: none;
  }
}
`;

const SCREEN_READER_ONLY: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
