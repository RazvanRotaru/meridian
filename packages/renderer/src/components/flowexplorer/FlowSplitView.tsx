import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

export const FLOW_SPLIT_HANDLE_PX = 10;
export const FLOW_SPLIT_EDGE_SNAP_PX = 72;
export const DEFAULT_GRAPH_RATIOS = { standard: 0.6, review: 0.7, synthetic: 0.44 } as const;

export type SplitVariant = keyof typeof DEFAULT_GRAPH_RATIOS;
export type GraphRatios = Record<SplitVariant, number>;
/** The separator's ARIA orientation: horizontal separates top/bottom; vertical separates left/right. */
export type SplitOrientation = "horizontal" | "vertical";

export interface ResizableSplitViewProps {
  open: boolean;
  orientation: SplitOrientation;
  primary: ReactNode;
  secondary: ReactNode;
  primaryRatio: number;
  defaultPrimaryRatio: number;
  onPrimaryRatioChange: (ratio: number) => void;
  primaryPaneId: string;
  secondaryPaneId: string;
  primaryLabel: string;
  secondaryLabel: string;
  separatorLabel: string;
  /** Preserve a fixed secondary-pane default on any viewport (for example, a 380px sidebar). */
  defaultSecondarySize?: number;
  /** Apply the fixed-size default on this mount. Disable after a parent has remembered a resize. */
  initializeDefaultSecondarySize?: boolean;
  /** Keep an open pane usable while resizing; exact 0/1 ratios still intentionally minimize it. */
  minimumPrimarySize?: number;
  minimumSecondarySize?: number;
  /** Keep the secondary pane mounted at a fixed size when resizing is closed (for example, a rail). */
  keepSecondaryWhenClosed?: boolean;
  closedSecondarySize?: number;
  /**
   * Temporarily remove a pane from layout without unmounting its children. This is useful for
   * composed split workspaces where an optional section can be empty or enter a focus mode: the
   * neighbouring pane fills the space and no orphan separator remains, while disclosure/editor
   * state inside the hidden pane survives.
   */
  primaryVisible?: boolean;
  secondaryVisible?: boolean;
  /** Visual and hit-area thickness. The application split defaults to 10px; dense nested panels
   * can opt into a smaller handle while retaining the same pointer and keyboard behaviour. */
  handleSize?: number;
}

/** Shared accessible splitter for both top/bottom and left/right application panes. */
export function ResizableSplitView(props: ResizableSplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activePointer = useRef<number | null>(null);
  const pointerGrabOffset = useRef(FLOW_SPLIT_HANDLE_PX / 2);
  const appliedDefaultSizeKey = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [handleFocused, setHandleFocused] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const [observedContainerSize, setObservedContainerSize] = useState<number | null>(null);
  const handleActive = dragging || handleFocused || handleHovered;
  const axisIsVertical = props.orientation === "horizontal";
  const primaryVisible = props.primaryVisible !== false;
  const secondaryVisible = props.secondaryVisible !== false;
  const handleSize = Math.max(1, props.handleSize ?? FLOW_SPLIT_HANDLE_PX);
  const splitActive = props.open && primaryVisible && secondaryVisible;
  const renderSecondary = props.open || props.keepSecondaryWhenClosed;

  const containerSize = (): number | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return axisIsVertical ? rect.height : rect.width;
  };
  const constrainForContainer = (ratio: number, size = containerSize()): number => size === null
    ? clampRatio(ratio)
    : constrainSplitRatio(
      ratio,
      size,
      props.minimumPrimarySize,
      props.minimumSecondarySize,
      handleSize,
    );
  const defaultRatioForCurrentSize = (): number => {
    const size = containerSize();
    const ratio = props.defaultSecondarySize !== undefined && size !== null
      ? splitRatioForSecondarySize(size, props.defaultSecondarySize, handleSize)
      : props.defaultPrimaryRatio;
    return constrainForContainer(ratio, size);
  };
  // The controlled ratio remains the user's preferred position. Window-size constraints affect
  // only what is rendered, so restoring the viewport also restores that preferred position.
  const effectivePrimaryRatio = observedContainerSize === null
    ? props.primaryRatio
    : constrainSplitRatio(
      props.primaryRatio,
      observedContainerSize,
      props.minimumPrimarySize,
      props.minimumSecondarySize,
      handleSize,
    );
  const primaryMinimized = splitActive && effectivePrimaryRatio === 0;
  const secondaryMinimized = splitActive && effectivePrimaryRatio === 1;

  // A sidebar owns a pixel default, while subsequent drags remain proportional like the flow pane.
  // useLayoutEffect applies it before paint, avoiding a one-frame jump from the fallback ratio.
  useLayoutEffect(() => {
    if (props.defaultSecondarySize === undefined) {
      appliedDefaultSizeKey.current = null;
      return;
    }
    if (
      props.initializeDefaultSecondarySize === false
      || !splitActive
    ) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const size = axisIsVertical ? rect.height : rect.width;
    if (size <= handleSize) return;
    const next = constrainForContainer(
      splitRatioForSecondarySize(size, props.defaultSecondarySize, handleSize),
      size,
    );
    const key = [
      props.orientation,
      props.defaultSecondarySize,
      props.minimumPrimarySize ?? 0,
      props.minimumSecondarySize ?? 0,
      handleSize,
    ].join(":");
    if (appliedDefaultSizeKey.current === key) return;
    appliedDefaultSizeKey.current = key;
    props.onPrimaryRatioChange(next);
  }, [
    axisIsVertical,
    handleSize,
    props.defaultSecondarySize,
    props.initializeDefaultSecondarySize,
    props.keepSecondaryWhenClosed,
    props.minimumPrimarySize,
    props.minimumSecondarySize,
    props.onPrimaryRatioChange,
    splitActive,
    props.orientation,
  ]);

  // Measure before paint when the split opens, then observe only its container size. This keeps
  // viewport clamps local to the lightweight splitter instead of overwriting the remembered ratio.
  useLayoutEffect(() => {
    if (
      !splitActive
      || ((props.minimumPrimarySize ?? 0) === 0 && (props.minimumSecondarySize ?? 0) === 0)
    ) {
      setObservedContainerSize(null);
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setObservedContainerSize(axisIsVertical ? rect.height : rect.width);
  }, [
    axisIsVertical,
    props.minimumPrimarySize,
    props.minimumSecondarySize,
    splitActive,
  ]);

  useEffect(() => {
    if (
      !splitActive
      || typeof ResizeObserver === "undefined"
      || ((props.minimumPrimarySize ?? 0) === 0 && (props.minimumSecondarySize ?? 0) === 0)
    ) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const size = axisIsVertical ? rect.height : rect.width;
      setObservedContainerSize((current) => current === size ? current : size);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    axisIsVertical,
    props.minimumPrimarySize,
    props.minimumSecondarySize,
    splitActive,
  ]);

  useEffect(() => {
    if (!dragging || typeof document === "undefined") {
      return;
    }
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axisIsVertical ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [axisIsVertical, dragging]);

  // An external close can remove the captured separator mid-gesture. Clear drag state explicitly
  // so the body cursor and selection lock are always restored while a collapsed rail stays usable.
  useEffect(() => {
    if (splitActive) {
      return;
    }
    activePointer.current = null;
    setDragging(false);
    setHandleFocused(false);
    setHandleHovered(false);
  }, [splitActive]);

  const updateFromPointer = (clientPosition: number) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const next = splitRatioFromAxisPointer({
      clientPosition,
      containerStart: axisIsVertical ? rect.top : rect.left,
      containerSize: axisIsVertical ? rect.height : rect.width,
      grabOffset: pointerGrabOffset.current,
      handleSize,
    });
    props.onPrimaryRatioChange(constrainForContainer(
      next,
      axisIsVertical ? rect.height : rect.width,
    ));
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
    const next = splitRatioForKey(
      effectivePrimaryRatio,
      event.key,
      event.shiftKey,
      defaultRatioForCurrentSize(),
      props.orientation,
    );
    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    props.onPrimaryRatioChange(constrainForContainer(next));
  };

  return (
    <div
      ref={containerRef}
      style={rootStyle(props.orientation)}
      data-resizable-split={props.orientation}
    >
      <div
        id={props.primaryPaneId}
        key="primary-pane"
        style={!primaryVisible
          ? hiddenPaneStyle()
          : paneStyle(splitActive ? effectivePrimaryRatio : 1, props.orientation)}
        aria-hidden={!primaryVisible || primaryMinimized || undefined}
        inert={!primaryVisible || primaryMinimized || undefined}
      >
        {props.primary}
      </div>
      {splitActive ? (
        <div
          role="separator"
          aria-label={props.separatorLabel}
          aria-controls={`${props.primaryPaneId} ${props.secondaryPaneId}`}
          aria-orientation={props.orientation}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(effectivePrimaryRatio * 100)}
          aria-valuetext={splitValueText(
            effectivePrimaryRatio,
            props.primaryLabel,
            props.secondaryLabel,
            axisIsVertical ? "height" : "width",
          )}
          aria-keyshortcuts={axisIsVertical
            ? "ArrowUp ArrowDown Home End Enter"
            : "ArrowLeft ArrowRight Home End Enter"}
          data-split-state={splitState(effectivePrimaryRatio)}
          tabIndex={0}
          title="Drag to resize. Move to an edge to minimize a pane. Double-click or press Enter to reset."
          style={handleStyle(handleActive, props.orientation, handleSize)}
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
            const handleStart = axisIsVertical ? handleRect.top : handleRect.left;
            const handleSize = axisIsVertical ? handleRect.height : handleRect.width;
            const pointerPosition = axisIsVertical ? event.clientY : event.clientX;
            pointerGrabOffset.current = Math.max(0, Math.min(handleSize, pointerPosition - handleStart));
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
            updateFromPointer(axisIsVertical ? event.clientY : event.clientX);
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
            props.onPrimaryRatioChange(defaultRatioForCurrentSize());
          }}
        >
          <span aria-hidden style={gripStyle(handleActive, props.orientation)} />
        </div>
      ) : null}
      {renderSecondary ? (
        <div
          id={props.secondaryPaneId}
          key="secondary-pane"
          style={!secondaryVisible
            ? hiddenPaneStyle()
            : splitActive
              ? paneStyle(1 - effectivePrimaryRatio, props.orientation)
              : props.open
                ? paneStyle(1, props.orientation)
            : closedPaneStyle(props.orientation, props.closedSecondarySize ?? 0)}
          aria-hidden={!secondaryVisible || secondaryMinimized || undefined}
          inert={!secondaryVisible || secondaryMinimized || undefined}
        >
          {props.secondary}
        </div>
      ) : null}
    </div>
  );
}

/** The established graph/logic-flow split remains a thin top/bottom wrapper over the shared core. */
export function FlowSplitView(props: { open: boolean; review: boolean; synthetic?: boolean; graph: ReactNode; flow: ReactNode }) {
  const [ratios, setRatios] = useState<GraphRatios>({ ...DEFAULT_GRAPH_RATIOS });
  const variant: SplitVariant = props.review ? "review" : props.synthetic ? "synthetic" : "standard";
  const graphRatio = ratios[variant];
  return (
    <ResizableSplitView
      open={props.open}
      orientation="horizontal"
      primary={props.graph}
      secondary={props.flow}
      primaryRatio={graphRatio}
      defaultPrimaryRatio={DEFAULT_GRAPH_RATIOS[variant]}
      onPrimaryRatioChange={(next) => {
        setRatios((current) => updateGraphRatio(current, variant, next));
      }}
      primaryPaneId="meridian-graph-pane"
      secondaryPaneId="meridian-logic-flow-pane"
      primaryLabel="Graph"
      secondaryLabel="logic flow"
      separatorLabel="Resize graph and logic flow"
    />
  );
}

/** Axis-neutral pointer geometry shared by horizontal and vertical separators. */
export function splitRatioFromAxisPointer(args: {
  clientPosition: number;
  containerStart: number;
  containerSize: number;
  grabOffset: number;
  handleSize?: number;
}): number {
  const availableSize = Math.max(0, args.containerSize - (args.handleSize ?? FLOW_SPLIT_HANDLE_PX));
  if (availableSize === 0) {
    return 0.5;
  }
  const handleStart = Math.max(
    0,
    Math.min(availableSize, args.clientPosition - args.containerStart - args.grabOffset),
  );
  const snapDistance = Math.min(FLOW_SPLIT_EDGE_SNAP_PX, availableSize / 4);
  if (handleStart <= snapDistance) {
    return 0;
  }
  if (availableSize - handleStart <= snapDistance) {
    return 1;
  }
  return handleStart / availableSize;
}

/** Backward-compatible top/bottom pointer helper. */
export function splitRatioFromPointer(args: {
  clientY: number;
  containerTop: number;
  containerHeight: number;
  grabOffset: number;
  handleHeight?: number;
}): number {
  return splitRatioFromAxisPointer({
    clientPosition: args.clientY,
    containerStart: args.containerTop,
    containerSize: args.containerHeight,
    grabOffset: args.grabOffset,
    handleSize: args.handleHeight,
  });
}

/** Convert a fixed secondary-pane size into the primary pane's proportional split. */
export function splitRatioForSecondarySize(
  containerSize: number,
  secondarySize: number,
  handleSize = FLOW_SPLIT_HANDLE_PX,
): number {
  const availableSize = Math.max(0, containerSize - handleSize);
  if (availableSize === 0) return 0.5;
  return clampRatio((availableSize - Math.max(0, secondarySize)) / availableSize);
}

/** Clamp an open split to usable pane sizes without taking away the intentional edge-minimize states. */
export function constrainSplitRatio(
  ratio: number,
  containerSize: number,
  minimumPrimarySize = 0,
  minimumSecondarySize = 0,
  handleSize = FLOW_SPLIT_HANDLE_PX,
): number {
  const clamped = clampRatio(ratio);
  if (clamped === 0 || clamped === 1) return clamped;

  const availableSize = Math.max(0, containerSize - handleSize);
  if (availableSize === 0) return 0.5;
  const primaryMinimum = Math.max(0, minimumPrimarySize);
  const secondaryMinimum = Math.max(0, minimumSecondarySize);
  const minimumTotal = primaryMinimum + secondaryMinimum;

  // Both requested minimums cannot fit. Divide the available space proportionally, which keeps
  // both panes reachable and avoids privileging whichever constraint happens to run first.
  if (minimumTotal > availableSize && minimumTotal > 0) {
    return primaryMinimum / minimumTotal;
  }

  const minimumRatio = Math.min(1, primaryMinimum / availableSize);
  const maximumRatio = Math.max(0, 1 - secondaryMinimum / availableSize);
  return Math.max(minimumRatio, Math.min(maximumRatio, clamped));
}

/** Keyboard parity for either separator axis. */
export function splitRatioForKey(
  current: number,
  key: string,
  shiftKey: boolean,
  defaultRatio: number,
  orientation: SplitOrientation = "horizontal",
): number | null {
  const step = shiftKey ? 0.15 : 0.05;
  if (orientation === "horizontal") {
    if (key === "ArrowUp") return clampRatio(current - step);
    if (key === "ArrowDown") return clampRatio(current + step);
  } else {
    if (key === "ArrowLeft") return clampRatio(current - step);
    if (key === "ArrowRight") return clampRatio(current + step);
  }
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

function splitState(primaryRatio: number): "graph-minimized" | "flow-minimized" | "split" {
  if (primaryRatio === 0) return "graph-minimized";
  if (primaryRatio === 1) return "flow-minimized";
  return "split";
}

function splitValueText(
  primaryRatio: number,
  primaryLabel: string,
  secondaryLabel: string,
  dimension: "height" | "width",
): string {
  if (primaryRatio === 0) return `${primaryLabel} minimized; ${secondaryLabel} full ${dimension}`;
  if (primaryRatio === 1) return `${primaryLabel} full ${dimension}; ${secondaryLabel} minimized`;
  const primaryPercent = Math.round(primaryRatio * 100);
  return `${primaryLabel} ${primaryPercent}%; ${secondaryLabel} ${100 - primaryPercent}%`;
}

function rootStyle(orientation: SplitOrientation): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: orientation === "horizontal" ? "column" : "row",
    overflow: "hidden",
  };
}

function paneStyle(portion: number, orientation: SplitOrientation): CSSProperties {
  return {
    position: "relative",
    flex: `${portion} 1 0px`,
    // React Flow warns and briefly loses its measured viewport at exactly 0px. One clipped pixel is
    // visually minimized while keeping both canvas instances warm for an immediate drag-open.
    minWidth: orientation === "vertical" && portion === 0 ? 1 : 0,
    minHeight: orientation === "horizontal" && portion === 0 ? 1 : 0,
    overflow: "hidden",
  };
}

function closedPaneStyle(orientation: SplitOrientation, size: number): CSSProperties {
  return {
    position: "relative",
    flex: `0 0 ${Math.max(0, size)}px`,
    minWidth: 0,
    minHeight: 0,
    width: orientation === "vertical" ? size : "100%",
    height: orientation === "horizontal" ? size : "100%",
    overflow: "hidden",
  };
}

function hiddenPaneStyle(): CSSProperties {
  return {
    display: "none",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  };
}

function handleStyle(active: boolean, orientation: SplitOrientation, handleSize: number): CSSProperties {
  const horizontal = orientation === "horizontal";
  return {
    position: "relative",
    zIndex: 20,
    flex: `0 0 ${handleSize}px`,
    width: horizontal ? "100%" : handleSize,
    height: horizontal ? handleSize : "100%",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderTop: horizontal ? "1px solid #222936" : "none",
    borderBottom: horizontal ? "1px solid #171C24" : "none",
    borderLeft: horizontal ? "none" : "1px solid #222936",
    borderRight: horizontal ? "none" : "1px solid #171C24",
    outline: "none",
    background: active ? "#1B222C" : "#10151C",
    boxShadow: active ? "0 0 0 1px rgba(92,130,180,0.45) inset" : "none",
    cursor: horizontal ? "row-resize" : "col-resize",
    touchAction: "none",
    userSelect: "none",
  };
}

function gripStyle(active: boolean, orientation: SplitOrientation): CSSProperties {
  const horizontal = orientation === "horizontal";
  return {
    width: horizontal ? 48 : 2,
    height: horizontal ? 2 : 48,
    borderRadius: 999,
    background: active ? "#71839A" : "#3C4654",
    pointerEvents: "none",
  };
}
