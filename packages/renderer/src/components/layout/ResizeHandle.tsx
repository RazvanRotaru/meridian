import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/** The separator's ARIA orientation: horizontal separates top/bottom; vertical separates left/right. */
export type ResizeHandleOrientation = "horizontal" | "vertical";

interface PointerCoordinates {
  clientX: number;
  clientY: number;
}

interface HandleBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ResizeHandlePointerGeometry {
  /** Pointer coordinate on the resize axis, in viewport coordinates. */
  clientPosition: number;
  /** Exact point at which the pointer grabbed the handle, clamped inside its hit area. */
  grabOffset: number;
}

/** Axis-neutral pointer geometry shared by every application resize handle. */
export function resizeHandlePointerGeometry(
  orientation: ResizeHandleOrientation,
  pointer: PointerCoordinates,
  bounds: HandleBounds,
): ResizeHandlePointerGeometry {
  const horizontal = orientation === "horizontal";
  const clientPosition = horizontal ? pointer.clientY : pointer.clientX;
  const handleStart = horizontal ? bounds.top : bounds.left;
  const handleSize = horizontal ? bounds.height : bounds.width;
  return {
    clientPosition,
    grabOffset: Math.max(0, Math.min(handleSize, clientPosition - handleStart)),
  };
}

type ResizeHandleDataAttributes = Record<`data-${string}`, string | number | boolean | undefined>;

export interface ResizeHandleProps {
  orientation: ResizeHandleOrientation;
  label: string;
  controls: string;
  valueMin: number;
  valueMax: number;
  valueNow: number;
  valueText: string;
  keyShortcuts: string;
  title: string;
  /** The host retains visual policy while this primitive owns interaction state and mechanics. */
  style: (active: boolean) => CSSProperties;
  renderGrip: (active: boolean) => ReactNode;
  /** Receives viewport-axis position plus the preserved grab point for host-specific geometry. */
  onDrag: (clientPosition: number, grabOffset: number) => void;
  /** Keyboard policy remains with the host because pane direction and constraints differ. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
  dataAttributes?: ResizeHandleDataAttributes;
}

/**
 * Shared accessible separator mechanics. Layout hosts own ratios, constraints, and visuals; this
 * component owns pointer capture, grab-point preservation, drag cursor/selection lock, interaction
 * state, and the common event-consumption contract.
 */
export function ResizeHandle(props: ResizeHandleProps) {
  const activePointer = useRef<number | null>(null);
  const pointerGrabOffset = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const interactionActive = dragging || focused || hovered;
  const horizontal = props.orientation === "horizontal";

  useEffect(() => {
    if (!dragging || typeof document === "undefined") return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging, horizontal]);

  const finishPointerDrag = (element: HTMLDivElement, pointerId: number) => {
    if (activePointer.current !== pointerId) return;
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    activePointer.current = null;
    setDragging(false);
  };

  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-controls={props.controls}
      aria-orientation={props.orientation}
      aria-valuemin={props.valueMin}
      aria-valuemax={props.valueMax}
      aria-valuenow={props.valueNow}
      aria-valuetext={props.valueText}
      aria-keyshortcuts={props.keyShortcuts}
      tabIndex={0}
      title={props.title}
      style={props.style(interactionActive)}
      {...props.dataAttributes}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        const geometry = resizeHandlePointerGeometry(
          props.orientation,
          event,
          event.currentTarget.getBoundingClientRect(),
        );
        pointerGrabOffset.current = geometry.grabOffset;
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (activePointer.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        props.onDrag(horizontal ? event.clientY : event.clientX, pointerGrabOffset.current);
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        finishPointerDrag(event.currentTarget, event.pointerId);
      }}
      onPointerCancel={(event) => finishPointerDrag(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => {
        if (activePointer.current !== event.pointerId) return;
        activePointer.current = null;
        setDragging(false);
      }}
      onKeyDown={props.onKeyDown}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onReset();
      }}
    >
      {props.renderGrip(interactionActive)}
    </div>
  );
}
