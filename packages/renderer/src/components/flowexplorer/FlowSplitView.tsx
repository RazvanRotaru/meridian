import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export const FLOW_SPLIT_HANDLE_PX = 10;
export const FLOW_SPLIT_EDGE_SNAP_PX = 72;
export const DEFAULT_GRAPH_RATIOS = { standard: 0.6, review: 0.7 } as const;

export type SplitVariant = keyof typeof DEFAULT_GRAPH_RATIOS;
export type GraphRatios = Record<SplitVariant, number>;

/** A top/bottom editor split whose separator remains reachable when either pane is minimized. */
export function FlowSplitView(props: { open: boolean; review: boolean; graph: ReactNode; flow: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activePointer = useRef<number | null>(null);
  const pointerGrabOffset = useRef(FLOW_SPLIT_HANDLE_PX / 2);
  const [ratios, setRatios] = useState<GraphRatios>({ ...DEFAULT_GRAPH_RATIOS });
  const [dragging, setDragging] = useState(false);
  const [handleFocused, setHandleFocused] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const variant: SplitVariant = props.review ? "review" : "standard";
  const graphRatio = ratios[variant];
  const graphMinimized = props.open && graphRatio === 0;
  const flowMinimized = props.open && graphRatio === 1;
  const handleActive = dragging || handleFocused || handleHovered;

  const setGraphRatio = (next: number) => {
    setRatios((current) => updateGraphRatio(current, variant, next));
  };

  useEffect(() => {
    if (!dragging || typeof document === "undefined") {
      return;
    }
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging]);

  // An external close/preference change can remove the captured separator mid-gesture. Clear the
  // drag state explicitly so the body cursor and selection lock are always restored on unmount.
  useEffect(() => {
    if (props.open) {
      return;
    }
    activePointer.current = null;
    setDragging(false);
    setHandleFocused(false);
    setHandleHovered(false);
  }, [props.open]);

  const updateFromPointer = (clientY: number) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    setGraphRatio(splitRatioFromPointer({
      clientY,
      containerTop: rect.top,
      containerHeight: rect.height,
      grabOffset: pointerGrabOffset.current,
    }));
  };

  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointer.current = null;
    setDragging(false);
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = splitRatioForKey(graphRatio, event.key, event.shiftKey, DEFAULT_GRAPH_RATIOS[variant]);
    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setGraphRatio(next);
  };

  return (
    <div ref={containerRef} style={ROOT_STYLE}>
      <div
        id="meridian-graph-pane"
        style={paneStyle(props.open ? graphRatio : 1)}
        aria-hidden={graphMinimized || undefined}
        inert={graphMinimized || undefined}
      >
        {props.graph}
      </div>
      {props.open ? (
        <div
          role="separator"
          aria-label="Resize graph and logic flow"
          aria-controls="meridian-graph-pane meridian-logic-flow-pane"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(graphRatio * 100)}
          aria-valuetext={splitValueText(graphRatio)}
          aria-keyshortcuts="ArrowUp ArrowDown Home End Enter"
          data-split-state={splitState(graphRatio)}
          tabIndex={0}
          title="Drag to resize. Move to an edge to minimize a pane. Double-click or press Enter to reset."
          style={handleStyle(handleActive)}
          onFocus={() => setHandleFocused(true)}
          onBlur={() => setHandleFocused(false)}
          onPointerEnter={() => setHandleHovered(true)}
          onPointerLeave={() => setHandleHovered(false)}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            const handleRect = event.currentTarget.getBoundingClientRect();
            pointerGrabOffset.current = Math.max(0, Math.min(handleRect.height, event.clientY - handleRect.top));
            activePointer.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (activePointer.current !== event.pointerId) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            updateFromPointer(event.clientY);
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
            finishPointerDrag(event);
          }}
          onPointerCancel={finishPointerDrag}
          onLostPointerCapture={(event) => {
            if (activePointer.current === event.pointerId) {
              activePointer.current = null;
              setDragging(false);
            }
          }}
          onKeyDown={onHandleKeyDown}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setGraphRatio(DEFAULT_GRAPH_RATIOS[variant]);
          }}
        >
          <span aria-hidden style={gripStyle(handleActive)} />
        </div>
      ) : null}
      {props.open ? (
        <div
          id="meridian-logic-flow-pane"
          style={paneStyle(1 - graphRatio)}
          aria-hidden={flowMinimized || undefined}
          inert={flowMinimized || undefined}
        >
          {props.flow}
        </div>
      ) : null}
    </div>
  );
}

/** Convert the live pointer position into the upper pane's ratio, snapping close edges shut. */
export function splitRatioFromPointer(args: {
  clientY: number;
  containerTop: number;
  containerHeight: number;
  grabOffset: number;
  handleHeight?: number;
}): number {
  const availableHeight = Math.max(0, args.containerHeight - (args.handleHeight ?? FLOW_SPLIT_HANDLE_PX));
  if (availableHeight === 0) {
    return 0.5;
  }
  const handleTop = Math.max(0, Math.min(availableHeight, args.clientY - args.containerTop - args.grabOffset));
  const snapDistance = Math.min(FLOW_SPLIT_EDGE_SNAP_PX, availableHeight / 4);
  if (handleTop <= snapDistance) {
    return 0;
  }
  if (availableHeight - handleTop <= snapDistance) {
    return 1;
  }
  return handleTop / availableHeight;
}

/** Keyboard parity for the separator: arrows resize, Home/End minimize, and Enter resets. */
export function splitRatioForKey(current: number, key: string, shiftKey: boolean, defaultRatio: number): number | null {
  const step = shiftKey ? 0.15 : 0.05;
  if (key === "ArrowUp") return clampRatio(current - step);
  if (key === "ArrowDown") return clampRatio(current + step);
  if (key === "Home") return 0;
  if (key === "End") return 1;
  if (key === "Enter") return defaultRatio;
  return null;
}

/** Remember standard and PR-review positions independently while updating the active split. */
export function updateGraphRatio(current: Readonly<GraphRatios>, variant: SplitVariant, value: number): GraphRatios {
  return { ...current, [variant]: clampRatio(value) };
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function splitState(graphRatio: number): "graph-minimized" | "flow-minimized" | "split" {
  if (graphRatio === 0) return "graph-minimized";
  if (graphRatio === 1) return "flow-minimized";
  return "split";
}

function splitValueText(graphRatio: number): string {
  if (graphRatio === 0) return "Graph minimized; logic flow full height";
  if (graphRatio === 1) return "Graph full height; logic flow minimized";
  const graphPercent = Math.round(graphRatio * 100);
  return `Graph ${graphPercent}%; logic flow ${100 - graphPercent}%`;
}

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

function paneStyle(portion: number): CSSProperties {
  return {
    position: "relative",
    flex: `${portion} 1 0px`,
    minWidth: 0,
    // React Flow warns and briefly loses its measured viewport at exactly 0px. One clipped pixel is
    // visually minimized while keeping both canvas instances warm for an immediate drag-open.
    minHeight: portion === 0 ? 1 : 0,
    overflow: "hidden",
  };
}

function handleStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    zIndex: 20,
    flex: `0 0 ${FLOW_SPLIT_HANDLE_PX}px`,
    width: "100%",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderTop: "1px solid #222936",
    borderBottom: "1px solid #171C24",
    outline: "none",
    background: active ? "#1B222C" : "#10151C",
    boxShadow: active ? "0 0 0 1px rgba(92,130,180,0.45) inset" : "none",
    cursor: "row-resize",
    touchAction: "none",
    userSelect: "none",
  };
}

function gripStyle(active: boolean): CSSProperties {
  return {
    width: 48,
    height: 2,
    borderRadius: 999,
    background: active ? "#71839A" : "#3C4654",
    pointerEvents: "none",
  };
}
