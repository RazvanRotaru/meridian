/**
 * Hover/click-to-preview for every source-backed node on the PR review graph. React Flow owns the
 * node elements (and scales/clips them with the canvas), so this hook listens at the shared surface
 * and portals one fixed, interactive card to document.body. Hover uses a short dwell to avoid
 * fetching source while the pointer merely crosses the graph, plus a leave grace that lets the
 * pointer bridge the gap into the card and scroll it. Click previews stay pinned until another node
 * or the canvas is clicked. Source payload reuse belongs to the store's immutable request cache, so
 * hover and click cannot diverge through a second node-local cache that outlives a review revision.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { Node as FlowNode } from "@xyflow/react";
import type { GraphNode } from "@meridian/core";
import { isSourceBackedNode } from "../../derive/sourceBackedNode";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { ReviewCodePreviewTrigger } from "../../state/reviewPreferences";
import type { CodeView } from "../../state/store";
import { SourceDiffBody, useSourceDiffModel } from "../SourceDiffBody";

const OPEN_DWELL_MS = 220;
const CLOSE_GRACE_MS = 180;
const PANEL_WIDTH = 680;
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_HEIGHT = 430;
const PANEL_GAP = 12;
const PANEL_MARGIN = 12;

export interface PreviewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PreviewBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PreviewPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** Place beside the node, flip to its left when needed, and clamp inside the graph pane. */
export function placeNodeDiffPreview(anchor: PreviewRect, bounds: PreviewBounds): PreviewPlacement {
  const innerLeft = bounds.left + PANEL_MARGIN;
  const innerTop = bounds.top + PANEL_MARGIN;
  const innerRight = bounds.left + bounds.width - PANEL_MARGIN;
  const innerBottom = bounds.top + bounds.height - PANEL_MARGIN;
  const preferredWidth = Math.max(0, Math.min(PANEL_WIDTH, innerRight - innerLeft));
  const maxHeight = Math.max(0, Math.min(PANEL_MAX_HEIGHT, innerBottom - innerTop));
  const rightCandidate = anchor.right + PANEL_GAP;
  const rightRoom = Math.max(0, innerRight - rightCandidate);
  const leftEdge = anchor.left - PANEL_GAP;
  const leftRoom = Math.max(0, leftEdge - innerLeft);
  const usableMinimum = Math.min(PANEL_MIN_WIDTH, preferredWidth);
  let width = preferredWidth;
  let left: number;
  if (rightRoom >= preferredWidth) {
    left = rightCandidate;
  } else if (leftRoom >= preferredWidth) {
    left = leftEdge - preferredWidth;
  } else if (Math.max(rightRoom, leftRoom) >= usableMinimum) {
    // The review rail often makes the graph pane too narrow for 680px. Prefer a narrower card in
    // the larger side gap over covering the hovered node (which would trigger an immediate leave).
    const useRight = rightRoom >= leftRoom;
    width = Math.min(preferredWidth, useRight ? rightRoom : leftRoom);
    left = useRight ? rightCandidate : leftEdge - width;
  } else {
    // Extremely narrow panes have no usable side gap; center as a last resort and remain clamped.
    const maxLeft = Math.max(innerLeft, innerRight - width);
    left = clamp(anchor.left + anchor.width / 2 - width / 2, innerLeft, maxLeft);
  }
  const maxTop = Math.max(innerTop, innerBottom - maxHeight);
  const top = clamp(anchor.top + anchor.height / 2 - maxHeight / 2, innerTop, maxTop);
  return { left, top, width, maxHeight };
}

type LocatedGraphNode = GraphNode & { location: NonNullable<GraphNode["location"]> };

/** Resolve hover source by graph identity alone. PR change membership only decorates the preview;
 * it must never decide whether an otherwise source-backed node can open one. */
export function codePreviewNode(
  nodesById: ReadonlyMap<string, GraphNode>,
  nodeId: string,
): LocatedGraphNode | null {
  const node = nodesById.get(nodeId);
  if (!isSourceBackedNode(node)) {
    return null;
  }
  return node;
}

interface PreviewState {
  node: LocatedGraphNode;
  anchor: PreviewRect;
  bounds: PreviewBounds;
  loading: boolean;
  view: CodeView | null;
  unavailable: boolean;
}

export interface NodeDiffPreviewControls {
  onNodeClick(event: ReactMouseEvent, node: FlowNode): void;
  onNodeMouseEnter(event: ReactMouseEvent, node: FlowNode): void;
  onNodeMouseMove(event: ReactMouseEvent, node: FlowNode): void;
  onNodeMouseLeave(): void;
  onPaneClick(): void;
  onPaneMouseMove(): void;
  layer: ReactNode;
}

export function useNodeDiffPreview(
  enabled: boolean,
  trigger: ReviewCodePreviewTrigger,
): NodeDiffPreviewControls {
  const index = useBlueprint((state) => state.index);
  const reviewRevision = useBlueprint((state) => state.prReviewRevision);
  const codeModalOpen = useBlueprint((state) => state.codeView?.mode === "modal");
  const { loadCodePreview } = useBlueprintActions();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestToken = useRef(0);
  const activeId = useRef<string | null>(null);
  const pendingId = useRef<string | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    pendingId.current = null;
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const hideNow = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    requestToken.current += 1;
    activeId.current = null;
    setPreview(null);
  }, [clearCloseTimer, clearOpenTimer]);
  const scheduleHide = useCallback(() => {
    if (activeId.current === null && pendingId.current === null) {
      return;
    }
    clearOpenTimer();
    clearCloseTimer();
    closeTimer.current = setTimeout(hideNow, CLOSE_GRACE_MS);
  }, [clearCloseTimer, clearOpenTimer, hideNow]);
  const holdPreview = useCallback(() => {
    // Reaching the portal can cross a located ancestor of the hovered node. Cancel that ancestor's
    // dwell so it cannot replace the card after the pointer has already arrived at the current one.
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);

  useEffect(() => {
    hideNow();
  }, [reviewRevision, hideNow]);
  useEffect(() => {
    if (!enabled || codeModalOpen) {
      hideNow();
    }
  }, [codeModalOpen, enabled, hideNow]);
  useEffect(() => hideNow(), [hideNow, trigger]);
  useEffect(() => () => {
    // Unmount invalidates late requests and timers; no state write is needed once the layer is gone.
    clearOpenTimer();
    clearCloseTimer();
    requestToken.current += 1;
    activeId.current = null;
  }, [clearCloseTimer, clearOpenTimer]);

  const activatePreview = useCallback((
    event: ReactMouseEvent,
    flowNode: FlowNode,
    dwell: boolean,
  ) => {
    clearCloseTimer();
    if (!enabled || codeModalOpen) {
      hideNow();
      return;
    }
    const graphNode = codePreviewNode(index.nodesById, flowNode.id);
    if (!graphNode) {
      scheduleHide();
      return;
    }
    // Returning from the card to the same node should keep the already-loaded preview steady.
    if (activeId.current === graphNode.id) {
      clearOpenTimer();
      return;
    }
    // React Flow can emit many moves during the dwell. Keep the original timer instead of pushing
    // the preview perpetually into the future; `onNodeMouseMove` also covers a node that laid out
    // underneath an already-stationary pointer and therefore never received a native enter.
    if (pendingId.current === graphNode.id) {
      return;
    }
    clearOpenTimer();
    const target = event.currentTarget as HTMLElement;
    const anchor = rectOf(target.getBoundingClientRect());
    const pane = target.closest<HTMLElement>(".react-flow")?.getBoundingClientRect();
    const bounds = pane
      ? boundsOf(pane)
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const open = () => {
      openTimer.current = null;
      pendingId.current = null;
      const token = ++requestToken.current;
      activeId.current = graphNode.id;
      setPreview({ node: graphNode, anchor, bounds, loading: true, view: null, unavailable: false });
      // Do not retain a second component-local payload cache. The store already deduplicates source
      // requests by immutable URL, while a mounted hook cache could survive a revision refresh and
      // replay a stale CodeView for a node id that exists in both revisions.
      const pending = loadCodePreview(graphNode).catch(() => null);
      void pending.then((view) => {
        if (requestToken.current !== token || activeId.current !== graphNode.id) {
          return;
        }
        setPreview((current) => {
          if (!current || current.node.id !== graphNode.id) {
            return current;
          }
          return { ...current, loading: false, view, unavailable: view === null };
        });
      });
    };
    if (dwell) {
      pendingId.current = graphNode.id;
      openTimer.current = setTimeout(open, OPEN_DWELL_MS);
    } else {
      open();
    }
  }, [clearCloseTimer, clearOpenTimer, codeModalOpen, enabled, hideNow, index, loadCodePreview, scheduleHide]);

  const onNodeMouseEnter = useCallback((event: ReactMouseEvent, flowNode: FlowNode) => {
    if (trigger === "hover") {
      activatePreview(event, flowNode, true);
    }
  }, [activatePreview, trigger]);
  const onNodeClick = useCallback((event: ReactMouseEvent, flowNode: FlowNode) => {
    if (trigger === "click") {
      activatePreview(event, flowNode, false);
    }
  }, [activatePreview, trigger]);
  const onPointerLeave = useCallback(() => {
    if (trigger === "hover") {
      scheduleHide();
    }
  }, [scheduleHide, trigger]);

  const layer = preview && !codeModalOpen && typeof document !== "undefined"
    ? createPortal(
        <NodeDiffPreviewCard
          preview={preview}
          onMouseEnter={holdPreview}
          onMouseLeave={onPointerLeave}
        />,
        document.body,
      )
    : null;

  return {
    onNodeClick,
    onNodeMouseEnter,
    onNodeMouseMove: onNodeMouseEnter,
    onNodeMouseLeave: onPointerLeave,
    onPaneClick: hideNow,
    onPaneMouseMove: onPointerLeave,
    layer,
  };
}

function NodeDiffPreviewCard(props: {
  preview: PreviewState;
  onMouseEnter(): void;
  onMouseLeave(): void;
}) {
  const { preview } = props;
  const codeView: CodeView = preview.view ?? {
    node: preview.node,
    code: null,
    loading: preview.loading,
    error: preview.unavailable ? "Source preview is unavailable." : null,
    mode: "inline",
    baseLine: preview.node.location.startLine,
    wholeFile: false,
  };
  const model = useSourceDiffModel(codeView);
  const placement = placeNodeDiffPreview(preview.anchor, preview.bounds);
  const shownEnd = codeView.code === null
    ? preview.node.location.endLine ?? model.baseLine
    : model.shownEnd;
  const range = codeView.code !== null && model.sourceLineCount === 0
    ? "empty"
    : shownEnd === model.baseLine ? String(model.baseLine) : `${model.baseLine}-${shownEnd}`;
  const stop = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <div
      className="nodrag nopan nowheel"
      role="dialog"
      aria-label={`Code preview for ${preview.node.displayName}`}
      style={{ ...PANEL_STYLE, ...placement }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onWheel={stop}
    >
      <header style={HEADER_STYLE}>
        <div style={HEADER_TEXT_STYLE}>
          <div style={PATH_STYLE} title={preview.node.location.file}>{preview.node.location.file}</div>
          <div style={NODE_STYLE} title={preview.node.qualifiedName}>{preview.node.displayName} · {range}</div>
        </div>
        {model.summary ? (
          <span style={SUMMARY_STYLE} aria-label={`${model.summary.added} added lines, ${model.summary.deleted} deleted lines`}>
            <span style={ADDED_STYLE}>+{model.summary.added}</span>
            <span style={DELETED_STYLE}>−{model.summary.deleted}</span>
          </span>
        ) : null}
      </header>
      <div style={BODY_STYLE}>
        <SourceDiffBody model={model} maxHeight={Math.max(90, placement.maxHeight - 74)} showGutter />
      </div>
    </div>
  );
}

function rectOf(rect: DOMRect): PreviewRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function boundsOf(rect: DOMRect): PreviewBounds {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}


const PANEL_STYLE: React.CSSProperties = {
  position: "fixed",
  // Above graph chrome/inline panels, but always below the global code modal (30) and palette (50).
  zIndex: 29,
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  overflow: "hidden",
  background: "#0E1116",
  border: "1px solid #3A414C",
  borderRadius: 10,
  boxShadow: "0 18px 48px rgba(0,0,0,0.62)",
  cursor: "default",
  pointerEvents: "auto",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexShrink: 0,
  padding: "9px 12px",
  background: "#191E25",
  borderBottom: "1px solid #303742",
};
const HEADER_TEXT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const PATH_STYLE: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#E6EDF3",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12.5,
  fontWeight: 650,
};
const NODE_STYLE: React.CSSProperties = {
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#7B8695",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10.5,
};
const SUMMARY_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  fontWeight: 700,
};
const ADDED_STYLE: React.CSSProperties = { color: "#56C271" };
const DELETED_STYLE: React.CSSProperties = { color: "#F0787C" };
const BODY_STYLE: React.CSSProperties = { minHeight: 0, padding: 9, overflow: "hidden", background: "#10151B" };
