/**
 * Hover-to-preview for every source-backed node on the PR review graph. React Flow owns the node
 * elements (and scales/clips them with the canvas), so this hook listens at the shared surface and
 * portals one fixed, interactive card to document.body. A short dwell avoids fetching source while
 * the pointer merely crosses the graph; a leave grace lets the pointer bridge the gap into the card
 * and scroll it. Loaded and in-flight views are cached per mounted review graph/node.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import type { Node as FlowNode } from "@xyflow/react";
import type { GraphNode, ReviewContext } from "@meridian/core";
import { isSourceBackedNode } from "../../derive/sourceBackedNode";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { CodeView } from "../../state/store";
import { CodeBlock } from "../CodeBlock";
import { summarizeChangeKinds, useChangeSummary, useChangedLines, useLineChangeKinds } from "../useChangedLines";
import { useCodeReviewComments } from "./useCodeReviewComments";

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
  onNodeMouseEnter(event: ReactMouseEvent, node: FlowNode): void;
  onNodeMouseMove(event: ReactMouseEvent, node: FlowNode): void;
  onNodeMouseLeave(): void;
  onPaneMouseMove(): void;
  layer: ReactNode;
}

export function useNodeDiffPreview(enabled: boolean): NodeDiffPreviewControls {
  const index = useBlueprint((state) => state.index);
  const reviewKey = useBlueprint((state) => state.review?.context.reviewKey ?? null);
  const codeModalOpen = useBlueprint((state) => state.codeView?.mode === "modal");
  const { loadCodePreview } = useBlueprintActions();
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestToken = useRef(0);
  const activeId = useRef<string | null>(null);
  const pendingId = useRef<string | null>(null);
  const cache = useRef(new Map<string, Promise<CodeView | null>>());

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
    cache.current.clear();
    hideNow();
  }, [reviewKey, hideNow]);
  useEffect(() => {
    if (!enabled || codeModalOpen) {
      hideNow();
    }
  }, [codeModalOpen, enabled, hideNow]);
  useEffect(() => () => {
    // Unmount invalidates late requests and timers; no state write is needed once the layer is gone.
    clearOpenTimer();
    clearCloseTimer();
    requestToken.current += 1;
    activeId.current = null;
  }, [clearCloseTimer, clearOpenTimer]);

  const onNodeMouseEnter = useCallback((event: ReactMouseEvent, flowNode: FlowNode) => {
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
    pendingId.current = graphNode.id;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      pendingId.current = null;
      const token = ++requestToken.current;
      activeId.current = graphNode.id;
      setPreview({ node: graphNode, anchor, bounds, loading: true, view: null, unavailable: false });
      const key = `${reviewKey ?? "review"}|${graphNode.id}|${graphNode.location.startLine}:${graphNode.location.endLine ?? graphNode.location.startLine}`;
      let pending = cache.current.get(key);
      if (!pending) {
        pending = loadCodePreview(graphNode).catch(() => null);
        cache.current.set(key, pending);
      }
      void pending.then((view) => {
        if (view?.error) {
          cache.current.delete(key); // a transient source failure should be retryable on re-hover
        }
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
    }, OPEN_DWELL_MS);
  }, [clearCloseTimer, clearOpenTimer, codeModalOpen, enabled, hideNow, index, loadCodePreview, reviewKey, scheduleHide]);

  const layer = preview && !codeModalOpen && typeof document !== "undefined"
    ? createPortal(
        <NodeDiffPreviewCard
          preview={preview}
          onMouseEnter={holdPreview}
          onMouseLeave={scheduleHide}
        />,
        document.body,
      )
    : null;

  return {
    onNodeMouseEnter,
    onNodeMouseMove: onNodeMouseEnter,
    onNodeMouseLeave: scheduleHide,
    onPaneMouseMove: scheduleHide,
    layer,
  };
}

function NodeDiffPreviewCard(props: {
  preview: PreviewState;
  onMouseEnter(): void;
  onMouseLeave(): void;
}) {
  const { preview } = props;
  const review = useBlueprint((state) => state.review);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const { addReviewComment } = useBlueprintActions();
  const hookChangedLines = useChangedLines(preview.node);
  const hookChangedLineKinds = useLineChangeKinds(preview.node);
  const hookSummary = useChangeSummary(preview.node);
  const changedLines = preview.view?.changedLines ?? hookChangedLines;
  const changedLineKinds = preview.view?.changedLineKinds ?? hookChangedLineKinds;
  const summary = preview.view?.changedLineKinds
    ? summarizeChangeKinds(preview.view.changedLineKinds)
    : hookSummary;
  const placement = placeNodeDiffPreview(preview.anchor, preview.bounds);
  const baseLine = preview.view?.baseLine ?? preview.node.location.startLine;
  const code = preview.view?.code ?? null;
  const reviewFile = preview.node.location.file;
  const existingComments = useCodeReviewComments(reviewFile, baseLine, code);
  const lineCommentsEnabled = previewFileAllowsLineComments(
    reviewFile,
    prReviewed,
    review?.context.changedFiles ?? EMPTY_CHANGED_FILES,
  );
  const commentableLines = useMemo(
    () => visiblePreviewCommentLines(baseLine, code, lineCommentsEnabled),
    [baseLine, code, lineCommentsEnabled],
  );
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  useEffect(() => setActiveCommentLine(null), [preview.node.id, baseLine]);
  const shownEnd = code === null
    ? preview.node.location.endLine ?? baseLine
    : baseLine + Math.max(code.split("\n").length - 1, 0);
  const range = shownEnd === baseLine ? String(baseLine) : `${baseLine}-${shownEnd}`;
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
        {summary ? (
          <span style={SUMMARY_STYLE} aria-label={`${summary.added} added or modified lines, ${summary.deleted} deleted lines`}>
            <span style={ADDED_STYLE}>+{summary.added}</span>
            <span style={DELETED_STYLE}>−{summary.deleted}</span>
          </span>
        ) : null}
      </header>
      <div style={BODY_STYLE}>
        {preview.loading ? <div style={STATUS_STYLE}>Loading code…</div> : null}
        {preview.unavailable ? <div style={STATUS_STYLE}>Source preview is unavailable.</div> : null}
        {preview.view?.error ? <div style={ERROR_STYLE}>{preview.view.error}</div> : null}
        {code !== null ? (
          <CodeBlock
            code={code}
            maxHeight={Math.max(90, placement.maxHeight - 74)}
            startLine={baseLine}
            showGutter
            changedLines={changedLines}
            changedLineKinds={changedLineKinds}
            commentableLines={commentableLines}
            onLineClick={commentableLines.size > 0 ? setActiveCommentLine : undefined}
            lineComposer={activeCommentLine === null || !commentableLines.has(activeCommentLine) ? null : {
              line: activeCommentLine,
              onAdd: (body) => addReviewComment(reviewFile, null, body, activeCommentLine),
              onCancel: () => setActiveCommentLine(null),
            }}
            existingComments={existingComments}
          />
        ) : null}
        {preview.view?.truncated ? <div style={TRUNCATED_STYLE}>Snippet truncated by the server.</div> : null}
      </div>
    </div>
  );
}

/** Every source row in a PR hover preview is HEAD-side and can carry a pending review comment. */
export function visiblePreviewCommentLines(
  baseLine: number,
  code: string | null,
  enabled: boolean,
): ReadonlySet<number> {
  if (!enabled || code === null) {
    return EMPTY_COMMENTABLE_LINES;
  }
  return new Set(Array.from({ length: code.split("\n").length }, (_value, index) => baseLine + index));
}

/** Deleted files have no RIGHT-side HEAD source to anchor, even if a synchronous review can still
 * preview their base-side text. Only surviving changed files expose line-comment actions. */
export function previewFileAllowsLineComments(
  path: string,
  prReviewed: number | null,
  changedFiles: ReviewContext["changedFiles"],
): boolean {
  if (prReviewed === null) {
    return false;
  }
  const file = changedFiles.find((candidate) => candidate.path === path);
  return file !== undefined && file.status !== "deleted";
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

const EMPTY_COMMENTABLE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_CHANGED_FILES: ReviewContext["changedFiles"] = [];

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
const STATUS_STYLE: React.CSSProperties = { padding: "12px 4px", color: "#7B8695", fontSize: 11.5 };
const ERROR_STYLE: React.CSSProperties = { padding: "12px 4px", color: "#F0787C", fontSize: 11.5 };
const TRUNCATED_STYLE: React.CSSProperties = { marginTop: 6, color: "#7B8695", fontSize: 10 };
