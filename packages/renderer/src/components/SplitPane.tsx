/**
 * A resizable horizontal split for the PR-review view: the graph on the LEFT, the flow list on the
 * RIGHT. A 6px divider drags the boundary; `reviewSplitRatio` (the RIGHT/list width fraction) is the
 * single source of truth, and every drag re-clamps it so the graph keeps >=480px and the list
 * >=340px. Below ~900px of container width the two panes stack (graph 40vh on top, list 60vh below)
 * and the divider retires — there isn't room for a side-by-side split that thin.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

const MIN_GRAPH_PX = 480;
const MIN_LIST_PX = 340;
const DIVIDER_PX = 6;
const STACK_BELOW_PX = 900;

export function SplitPane(props: { left: ReactNode; right: ReactNode }) {
  const ratio = useBlueprint((state) => state.reviewSplitRatio);
  const { setReviewSplitRatio } = useBlueprintActions();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useContainerWidth(containerRef);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Too narrow for a real side-by-side split — stack the panes and drop the divider.
  if (width > 0 && width < STACK_BELOW_PX) {
    return (
      <div ref={containerRef} style={STACK_STYLE}>
        <div style={STACK_GRAPH_STYLE}>{props.left}</div>
        <div style={STACK_LIST_STYLE}>{props.right}</div>
      </div>
    );
  }

  // The list is the fixed-width side (clamped); the graph flexes to fill whatever remains, so its
  // minimum is enforced by capping the list at `width - MIN_GRAPH_PX - divider`.
  const listPx = clampListPx(ratio * width, width);

  const onPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!draggingRef.current || width === 0 || !containerRef.current) {
      return;
    }
    const rect = containerRef.current.getBoundingClientRect();
    setReviewSplitRatio(clampListPx(rect.right - event.clientX, width) / width);
  };
  const onPointerUp = (event: React.PointerEvent) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = false;
    setDragging(false);
  };

  return (
    <div ref={containerRef} style={dragging ? ROW_DRAGGING_STYLE : ROW_STYLE}>
      <div style={GRAPH_STYLE}>{props.left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={DIVIDER_STYLE}
      />
      <div style={{ ...LIST_STYLE, width: listPx }}>{props.right}</div>
    </div>
  );
}

/** Keep the list within [MIN_LIST_PX, width - MIN_GRAPH_PX - divider], so both minimums hold. */
function clampListPx(px: number, width: number): number {
  const max = width - MIN_GRAPH_PX - DIVIDER_PX;
  return Math.max(MIN_LIST_PX, Math.min(max, px));
}

/** Track the container's live width (layout-effect measured, ResizeObserver kept fresh). */
function useContainerWidth(ref: React.MutableRefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const ROW_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "row",
  width: "100%",
  height: "100%",
};
const ROW_DRAGGING_STYLE: React.CSSProperties = { ...ROW_STYLE, userSelect: "none", cursor: "col-resize" };
const GRAPH_STYLE: React.CSSProperties = { position: "relative", flex: "1 1 0", minWidth: 0, height: "100%", overflow: "hidden" };
const LIST_STYLE: React.CSSProperties = { position: "relative", flex: "0 0 auto", minWidth: 0, height: "100%", overflow: "hidden" };
const DIVIDER_STYLE: React.CSSProperties = {
  flex: `0 0 ${DIVIDER_PX}px`,
  height: "100%",
  background: "#2A2F37",
  cursor: "col-resize",
  touchAction: "none",
  userSelect: "none",
};
const STACK_STYLE: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  overflowY: "auto",
};
const STACK_GRAPH_STYLE: React.CSSProperties = { position: "relative", flex: "0 0 auto", width: "100%", height: "40vh", overflow: "hidden" };
const STACK_LIST_STYLE: React.CSSProperties = { position: "relative", flex: "0 0 auto", width: "100%", height: "60vh", overflow: "hidden" };
