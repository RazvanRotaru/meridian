import { Cross2Icon } from "@radix-ui/react-icons";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type RefCallback,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_SOURCE_WINDOW_HEIGHT,
  DEFAULT_SOURCE_WINDOW_WIDTH,
  SOURCE_WINDOW_MARGIN,
  constrainSourceWindowRect,
  defaultSourceWindowRect,
  moveSourceWindow,
  moveSourceWindowForKey,
  resizeSourceWindow,
  resizeSourceWindowForKey,
  sourceWindowResizeValueBounds,
  sourceWindowShouldCollapseRail,
  type SourceWindowRect,
  type SourceWindowRegion,
  type SourceWindowResizeDirection,
} from "./sourceWindowGeometry";
import {
  readSourceWindowPreference,
  resetSourceWindowPreference,
  writeSourceWindowPreference,
} from "../../state/sourceWindowPreference";

export const FLOATING_SOURCE_WINDOW_ID = "meridian-source-code-dock";
export const FLOATING_SOURCE_WINDOW_LAYER_ID = "meridian-source-code-dock-layer";
export const FLOATING_SOURCE_WINDOW_RAIL_ID = "meridian-source-code-related-rail";
export const FLOATING_SOURCE_WINDOW_PORTAL_HOST_ID = "meridian-floating-source-window-portal";
export const FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE = 10;

export interface FloatingSourceHeaderDragProps {
  "data-source-window-drag-handle": "true";
  title: string;
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerMove: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
  onLostPointerCapture: PointerEventHandler<HTMLElement>;
}

export interface FloatingSourceMoveHandleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  "data-source-window-move-control": "true";
}

export interface FloatingSourceWindowControls {
  headerDragProps: FloatingSourceHeaderDragProps;
  moveHandleProps: FloatingSourceMoveHandleProps;
  resetGeometry: () => void;
  railToggleRef: RefCallback<HTMLButtonElement>;
  railCollapsed: boolean;
  railOpen: boolean;
  /** Place at the end of the side rail's top row; compact modes use frame-level close chrome. */
  sideRailCloseButton: ReactNode | null;
  toggleRail: () => void;
}

export interface FloatingSourceWindowProps {
  ariaLabel?: string;
  closeLabel?: string;
  /** Render prop so the source header can own the visible move and reset controls. */
  main: (controls: FloatingSourceWindowControls) => ReactNode;
  rail?: ReactNode | ((controls: FloatingSourceWindowControls) => ReactNode);
  railLabel?: string;
  railCount?: number;
  onClose: () => void;
  /** The product default is measured inside this region; subsequent dragging may use the shell. */
  defaultRegionElementId?: string;
  /** Hoist graph-local inspectors into the shell so every persisted rect uses one coordinate space. */
  portalElementId?: string;
  onGeometryReset?: () => void;
}

interface MeasuredWindowRegion {
  shell: SourceWindowRegion;
  defaultOriginX: number;
  defaultOriginY: number;
  defaultRegion: SourceWindowRegion;
}

interface PointerSession {
  pointerId: number;
  kind: "move" | "resize";
  direction?: SourceWindowResizeDirection;
  clientX: number;
  clientY: number;
  startRect: SourceWindowRect;
  startPreferred: SourceWindowRect | null;
  changed: boolean;
  cursor: string;
}

const FALLBACK_MEASUREMENT: MeasuredWindowRegion = {
  shell: {
    width: DEFAULT_SOURCE_WINDOW_WIDTH + SOURCE_WINDOW_MARGIN * 2,
    height: DEFAULT_SOURCE_WINDOW_HEIGHT + SOURCE_WINDOW_MARGIN * 2,
  },
  defaultOriginX: 0,
  defaultOriginY: 0,
  defaultRegion: {
    width: DEFAULT_SOURCE_WINDOW_WIDTH + SOURCE_WINDOW_MARGIN * 2,
    height: DEFAULT_SOURCE_WINDOW_HEIGHT + SOURCE_WINDOW_MARGIN * 2,
  },
};

/**
 * Modeless source tool window. The full-shell layer is deliberately transparent to pointer input;
 * only the floating host and its resize zones participate in hit testing. Preferred geometry stays
 * untouched by passive viewport constraints and is persisted only when a user gesture commits.
 */
export function FloatingSourceWindow(props: FloatingSourceWindowProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const railRef = useRef<HTMLElement | null>(null);
  const railCloseRef = useRef<HTMLButtonElement | null>(null);
  const railToggleNodeRef = useRef<HTMLButtonElement | null>(null);
  const railDisclosureFocusOwnedRef = useRef(false);
  const railFocusOwnedRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(sourceWindowOpenerBeforeCommit());
  const pointerSessionRef = useRef<PointerSession | null>(null);
  const [measurement, setMeasurement] = useState<MeasuredWindowRegion>(FALLBACK_MEASUREMENT);
  const [preferredRect, setPreferredRectState] = useState<SourceWindowRect | null>(
    () => readSourceWindowPreference().rect,
  );
  const preferredRectRef = useRef<SourceWindowRect | null>(preferredRect);
  const [pointerActive, setPointerActive] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" || props.portalElementId === undefined
      ? null
      : document.getElementById(props.portalElementId));

  const setRailToggleRef = useCallback<RefCallback<HTMLButtonElement>>((node) => {
    const current = railToggleNodeRef.current;
    if (node === null) {
      railDisclosureFocusOwnedRef.current = current?.ownerDocument.activeElement === current;
    }
    railToggleNodeRef.current = node;
  }, []);

  const restoreRailDisclosureFocus = useCallback(() => {
    const host = hostRef.current;
    const ownerWindow = host?.ownerDocument.defaultView;
    if (host === null || ownerWindow === null || ownerWindow === undefined) return;
    ownerWindow.requestAnimationFrame(() => {
      const disclosure = railToggleNodeRef.current;
      const fallback = host.querySelector<HTMLElement>('[data-source-window-title="true"]');
      const target = disclosure?.isConnected ? disclosure : fallback ?? host;
      target.focus({ preventScroll: true });
    });
  }, []);

  const closeCompactRail = useCallback(() => {
    setRailOpen(false);
    restoreRailDisclosureFocus();
  }, [restoreRailDisclosureFocus]);

  const setPreferredRect = useCallback((rect: SourceWindowRect | null) => {
    preferredRectRef.current = rect;
    setPreferredRectState(rect);
  }, []);

  const productDefaultRect = useMemo(
    () => translatedDefaultRect(measurement),
    [measurement],
  );
  const effectiveRect = constrainSourceWindowRect(
    preferredRect ?? productDefaultRect,
    measurement.shell,
  );
  const effectiveRectRef = useRef(effectiveRect);
  effectiveRectRef.current = effectiveRect;
  const hasRail = props.rail !== undefined && props.rail !== null;
  const railLabel = props.railLabel ?? "Related code";
  const railCollapsed = hasRail && sourceWindowShouldCollapseRail(effectiveRect.width);
  const railMode = hasRail ? floatingSourceWindowRailMode(effectiveRect.width, railOpen) : "hidden";
  const previousRailModeRef = useRef<FloatingSourceWindowRailMode>(railMode);

  const measure = useCallback(() => {
    const layer = layerRef.current;
    if (layer === null) return;
    const layerRect = layer.getBoundingClientRect();
    if (!positiveFinite(layerRect.width) || !positiveFinite(layerRect.height)) return;
    const target = props.defaultRegionElementId === undefined
      ? null
      : layer.ownerDocument.getElementById(props.defaultRegionElementId);
    const next = measuredWindowRegion(layerRect, target?.getBoundingClientRect() ?? null);
    setMeasurement((current) => sameMeasurement(current, next) ? current : next);
  }, [props.defaultRegionElementId]);

  useLayoutEffect(() => measure(), [measure]);
  useLayoutEffect(() => {
    const next = props.portalElementId === undefined
      ? null
      : document.getElementById(props.portalElementId);
    setPortalTarget((current) => current === next ? current : next);
  }, [props.portalElementId]);
  useEffect(() => {
    const layer = layerRef.current;
    if (layer === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    if (props.defaultRegionElementId !== undefined) {
      const target = layer.ownerDocument.getElementById(props.defaultRegionElementId);
      if (target !== null) observer.observe(target);
    }
    return () => observer.disconnect();
  }, [measure, props.defaultRegionElementId]);

  useLayoutEffect(() => {
    const previous = previousRailModeRef.current;
    previousRailModeRef.current = railMode;
    if (previous !== railMode && railMode === "overlay") {
      railFocusOwnedRef.current = true;
      railCloseRef.current?.focus({ preventScroll: true });
    } else if (previous !== "hidden" && railMode === "hidden" && railFocusOwnedRef.current) {
      railFocusOwnedRef.current = false;
      restoreRailDisclosureFocus();
    } else if (previous === "overlay" && railMode === "side" && railFocusOwnedRef.current) {
      const firstRailControl = railRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (firstRailControl ?? hostRef.current?.querySelector<HTMLElement>('[data-source-window-title="true"]'))
        ?.focus({ preventScroll: true });
    } else if (previous === "hidden" && railMode === "side" && railDisclosureFocusOwnedRef.current) {
      railDisclosureFocusOwnedRef.current = false;
      const firstRailControl = railRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (firstRailControl ?? hostRef.current?.querySelector<HTMLElement>('[data-source-window-title="true"]'))
        ?.focus({ preventScroll: true });
    }
    if (!railCollapsed && railOpen) setRailOpen(false);
  }, [railCollapsed, railMode, railOpen, restoreRailDisclosureFocus]);

  useEffect(() => {
    if (!pointerActive || typeof document === "undefined") return;
    const session = pointerSessionRef.current;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = session?.cursor ?? "default";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [pointerActive]);

  // Capture once for this open lifecycle without stealing focus from the graph. When an explicit
  // source action closes the window, restore its opener only if no new destination claimed focus.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const ownerDocument = host?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (host === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const active = ownerDocument.activeElement;
    if (openerRef.current === null && active instanceof HTMLElement && active !== ownerDocument.body) {
      openerRef.current = active;
    }
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      ownerWindow.requestAnimationFrame(() => {
        const current = ownerDocument.activeElement;
        const focusUnclaimed = current === null
          || current === ownerDocument.body
          || current === ownerDocument.documentElement
          || (current instanceof HTMLElement && !current.isConnected);
        if (focusUnclaimed && opener?.isConnected && opener.closest("[inert]") === null) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  // The sticky tool window owns Escape across the workspace, independent of which underlying or
  // source-window control has focus. Only a higher modal gets the first dismissal gesture.
  useLayoutEffect(() => {
    const host = hostRef.current;
    const ownerDocument = host?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (host === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const higherModalOpen = Array.from(ownerDocument.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
        .some((modal) => modal.closest("[inert]") === null);
      if (higherModalOpen) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    ownerWindow.addEventListener("keydown", closeFromEscape, true);
    return () => ownerWindow.removeEventListener("keydown", closeFromEscape, true);
  }, []);

  const commitPreferredRect = useCallback((rect: SourceWindowRect) => {
    setPreferredRect(rect);
    writeSourceWindowPreference(rect);
  }, [setPreferredRect]);

  const resetGeometry = useCallback(() => {
    resetSourceWindowPreference();
    setPreferredRect(null);
    setRailOpen(false);
    props.onGeometryReset?.();
  }, [props.onGeometryReset, setPreferredRect]);

  const beginPointerSession = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    kind: PointerSession["kind"],
    direction?: SourceWindowResizeDirection,
  ) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (kind === "move" && isDragExcludedTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      kind,
      direction,
      clientX: event.clientX,
      clientY: event.clientY,
      startRect: effectiveRectRef.current,
      startPreferred: preferredRectRef.current,
      changed: false,
      cursor: kind === "move" ? "grabbing" : resizeCursor(direction ?? "se"),
    };
    setPointerActive(true);
  }, []);

  const updatePointerSession = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = pointerSessionRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - session.clientX;
    const deltaY = event.clientY - session.clientY;
    const nextEffective = session.kind === "move"
      ? moveSourceWindow(session.startRect, deltaX, deltaY, measurement.shell)
      : resizeSourceWindow(
          session.startRect,
          session.direction ?? "se",
          deltaX,
          deltaY,
          measurement.shell,
        );
    // Moving in a temporarily constrained viewport must not destroy the preferred wider size.
    const nextPreferred = session.kind === "move" && session.startPreferred !== null
      ? { ...session.startPreferred, x: nextEffective.x, y: nextEffective.y }
      : nextEffective;
    session.changed = !sameRect(nextEffective, session.startRect);
    setPreferredRect(session.changed ? nextPreferred : session.startPreferred);
  }, [measurement.shell, setPreferredRect]);

  const finishPointerSession = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    commit: boolean,
  ) => {
    const session = pointerSessionRef.current;
    if (session === null || session.pointerId !== event.pointerId) return;
    pointerSessionRef.current = null;
    setPointerActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!commit) {
      setPreferredRect(session.startPreferred);
      return;
    }
    if (!session.changed) {
      // Pointer-down/up is selection intent, not a geometry preference. In particular, do not turn
      // the responsive default into a fixed or viewport-clamped rectangle on a simple click.
      setPreferredRect(session.startPreferred);
      return;
    }
    if (preferredRectRef.current !== null) {
      writeSourceWindowPreference(preferredRectRef.current);
    }
  }, [setPreferredRect]);

  const headerDragProps: FloatingSourceHeaderDragProps = {
    "data-source-window-drag-handle": "true",
    title: "Drag to move source window",
    onPointerDown: (event) => beginPointerSession(event, "move"),
    onPointerMove: updatePointerSession,
    onPointerUp: (event) => {
      updatePointerSession(event);
      finishPointerSession(event, true);
    },
    onPointerCancel: (event) => finishPointerSession(event, false),
    onLostPointerCapture: (event) => {
      // A lost capture without pointer-up is an interrupted gesture, so restore the preference.
      finishPointerSession(event, false);
    },
  };

  const moveHandleProps: FloatingSourceMoveHandleProps = {
    type: "button",
    "aria-label": "Move source window",
    "aria-keyshortcuts": "ArrowLeft ArrowRight ArrowUp ArrowDown",
    title: "Move source window with arrow keys; hold Shift for larger steps",
    "data-source-window-move-control": "true",
    onPointerDown: (event) => event.stopPropagation(),
    onKeyDown: (event) => {
      const nextEffective = moveSourceWindowForKey(
        effectiveRectRef.current,
        event.key,
        event.shiftKey,
        measurement.shell,
      );
      if (nextEffective === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (sameRect(nextEffective, effectiveRectRef.current)) return;
      const currentPreferred = preferredRectRef.current;
      const next = currentPreferred === null
        ? nextEffective
        : { ...currentPreferred, x: nextEffective.x, y: nextEffective.y };
      commitPreferredRect(next);
    },
  };

  const controls: FloatingSourceWindowControls = {
    headerDragProps,
    moveHandleProps,
    resetGeometry,
    railToggleRef: setRailToggleRef,
    railCollapsed,
    railOpen: railCollapsed && railOpen,
    sideRailCloseButton: railMode === "side" ? (
      <SourceWindowCloseButton
        label={props.closeLabel ?? "Close source"}
        onClose={props.onClose}
        placement="side-rail"
      />
    ) : null,
    toggleRail: () => setRailOpen((current) => !current),
  };
  const renderedRail = typeof props.rail === "function" ? props.rail(controls) : props.rail;
  const layer = (
    <div
      ref={layerRef}
      id={FLOATING_SOURCE_WINDOW_LAYER_ID}
      style={LAYER_STYLE}
      data-floating-source-window-layer="true"
      data-source-code-dock-layer="true"
    >
      <style>{FLOATING_SOURCE_WINDOW_CSS}</style>
      <div
        ref={hostRef}
        id={FLOATING_SOURCE_WINDOW_ID}
        role="dialog"
        aria-label={props.ariaLabel ?? "Source code"}
        tabIndex={-1}
        style={{
          ...HOST_STYLE,
          left: effectiveRect.x,
          top: effectiveRect.y,
          width: effectiveRect.width,
          height: effectiveRect.height,
        }}
        data-floating-source-window-host="true"
        data-source-code-dock-host="true"
        data-source-window-pointer-active={pointerActive || undefined}
        data-source-window-rail-mode={railMode}
        onClick={(event) => event.stopPropagation()}
      >
        {railMode === "side" ? null : (
          <SourceWindowCloseButton
            label={props.closeLabel ?? "Close source"}
            onClose={props.onClose}
            placement="frame"
          />
        )}
        <div
          style={MAIN_STYLE}
          data-source-window-main="true"
          inert={railMode === "overlay" ? true : undefined}
          aria-hidden={railMode === "overlay" ? true : undefined}
        >
          {props.main(controls)}
        </div>
        {hasRail ? <aside
          ref={railRef}
          id={FLOATING_SOURCE_WINDOW_RAIL_ID}
          role="complementary"
          aria-label={railLabel}
          hidden={railMode === "hidden" || undefined}
          style={railMode === "overlay"
            ? RAIL_OVERLAY_STYLE
            : railMode === "side" ? RAIL_SIDE_STYLE : RAIL_HIDDEN_STYLE}
          data-source-window-rail="true"
          data-source-window-rail-mode={railMode}
          data-source-window-rail-count={props.railCount}
          onFocusCapture={() => {
            railFocusOwnedRef.current = true;
          }}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) {
              railFocusOwnedRef.current = false;
            } else if (next === null) {
              event.currentTarget.ownerDocument.defaultView?.requestAnimationFrame(() => {
                const active = railRef.current?.ownerDocument.activeElement;
                if (!(active instanceof Node) || railRef.current?.contains(active) !== true) {
                  railFocusOwnedRef.current = false;
                }
              });
            }
          }}
        >
          {railMode === "overlay" ? (
            <header style={RAIL_OVERLAY_HEADER_STYLE}>
              <span style={RAIL_OVERLAY_TITLE_STYLE}>{railLabel}</span>
              <button
                ref={railCloseRef}
                type="button"
                style={RAIL_OVERLAY_CLOSE_STYLE}
                aria-label={`Hide ${railLabel}`}
                title={`Hide ${railLabel}`}
                data-source-window-rail-close="true"
                onClick={closeCompactRail}
              >
                <Cross2Icon />
              </button>
            </header>
          ) : null}
          <div style={RAIL_CONTENT_STYLE}>{renderedRail}</div>
        </aside> : null}
      </div>
      {RESIZE_DIRECTIONS.map((direction) => (
        <ResizeZone
          key={direction}
          direction={direction}
          rect={effectiveRect}
          region={measurement.shell}
          onBegin={(event) => beginPointerSession(event, "resize", direction)}
          onMove={updatePointerSession}
          onFinish={(event) => {
            updatePointerSession(event);
            finishPointerSession(event, true);
          }}
          onCancel={(event) => finishPointerSession(event, false)}
          onKeyboardRect={commitPreferredRect}
          onReset={resetGeometry}
        />
      ))}
    </div>
  );
  return portalTarget === null ? layer : createPortal(layer, portalTarget);
}

function SourceWindowCloseButton({
  label,
  onClose,
  placement,
}: {
  label: string;
  onClose: () => void;
  placement: "frame" | "side-rail";
}) {
  return (
    <button
      type="button"
      style={placement === "frame" ? FRAME_CLOSE_STYLE : SIDE_RAIL_CLOSE_STYLE}
      aria-label={label}
      aria-keyshortcuts="Escape"
      title={label}
      data-source-window-close="true"
      data-source-window-close-placement={placement}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClose}
    >
      <Cross2Icon />
    </button>
  );
}

export type FloatingSourceWindowRailMode = "side" | "overlay" | "hidden";

export function floatingSourceWindowRailMode(
  width: number,
  railOpen: boolean,
): FloatingSourceWindowRailMode {
  if (!sourceWindowShouldCollapseRail(width)) return "side";
  return railOpen ? "overlay" : "hidden";
}

function ResizeZone(props: {
  direction: SourceWindowResizeDirection;
  rect: SourceWindowRect;
  region: SourceWindowRegion;
  onBegin: (event: ReactPointerEvent<HTMLElement>) => void;
  onMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onFinish: (event: ReactPointerEvent<HTMLElement>) => void;
  onCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onKeyboardRect: (rect: SourceWindowRect) => void;
  onReset: () => void;
}) {
  const edge = props.direction.length === 1;
  const horizontalSize = props.direction === "e" || props.direction === "w";
  const axisBounds = edge
    ? sourceWindowResizeValueBounds(
        props.rect,
        props.direction as Extract<SourceWindowResizeDirection, "n" | "e" | "s" | "w">,
        props.region,
      )
    : null;
  const label = edge ? resizeEdgeLabel(props.direction) : undefined;
  return (
    <div
      role={edge ? "separator" : undefined}
      aria-hidden={edge ? undefined : true}
      aria-label={label}
      aria-controls={edge ? FLOATING_SOURCE_WINDOW_ID : undefined}
      aria-orientation={edge ? (horizontalSize ? "vertical" : "horizontal") : undefined}
      aria-valuemin={axisBounds?.minimum}
      aria-valuemax={axisBounds?.maximum}
      aria-valuenow={edge ? (horizontalSize ? props.rect.width : props.rect.height) : undefined}
      aria-valuetext={edge ? sourceWindowSizeText(props.rect, horizontalSize) : undefined}
      aria-keyshortcuts={edge ? resizeKeyShortcuts(props.direction) : undefined}
      tabIndex={edge ? 0 : undefined}
      title={edge ? `${label}. Use arrow keys; press Enter or double-click to reset.` : undefined}
      style={resizeZoneStyle(props.direction, props.rect)}
      data-source-window-resize-zone={props.direction}
      onPointerDown={props.onBegin}
      onPointerMove={props.onMove}
      onPointerUp={props.onFinish}
      onPointerCancel={props.onCancel}
      onLostPointerCapture={props.onCancel}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onReset();
      }}
      onKeyDown={edge ? (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          props.onReset();
          return;
        }
        const next = resizeSourceWindowForKey(
          props.rect,
          props.direction,
          event.key,
          event.shiftKey,
          props.region,
        );
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        if (sameRect(next, props.rect)) return;
        props.onKeyboardRect(next);
      } : undefined}
    />
  );
}

function translatedDefaultRect(measurement: MeasuredWindowRegion): SourceWindowRect {
  const local = defaultSourceWindowRect(measurement.defaultRegion);
  return constrainSourceWindowRect({
    ...local,
    x: local.x + measurement.defaultOriginX,
    y: local.y + measurement.defaultOriginY,
  }, measurement.shell);
}

function measuredWindowRegion(
  layer: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  target: Pick<DOMRect, "left" | "top" | "right" | "bottom"> | null,
): MeasuredWindowRegion {
  if (target === null) {
    return {
      shell: { width: layer.width, height: layer.height },
      defaultOriginX: 0,
      defaultOriginY: 0,
      defaultRegion: { width: layer.width, height: layer.height },
    };
  }
  const left = Math.max(layer.left, target.left);
  const top = Math.max(layer.top, target.top);
  const right = Math.min(layer.right, target.right);
  const bottom = Math.min(layer.bottom, target.bottom);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (!positiveFinite(width) || !positiveFinite(height)) {
    return {
      shell: { width: layer.width, height: layer.height },
      defaultOriginX: 0,
      defaultOriginY: 0,
      defaultRegion: { width: layer.width, height: layer.height },
    };
  }
  return {
    shell: { width: layer.width, height: layer.height },
    defaultOriginX: left - layer.left,
    defaultOriginY: top - layer.top,
    defaultRegion: { width, height },
  };
}

function sameMeasurement(left: MeasuredWindowRegion, right: MeasuredWindowRegion): boolean {
  return left.shell.width === right.shell.width
    && left.shell.height === right.shell.height
    && left.defaultOriginX === right.defaultOriginX
    && left.defaultOriginY === right.defaultOriginY
    && left.defaultRegion.width === right.defaultRegion.width
    && left.defaultRegion.height === right.defaultRegion.height;
}

function sameRect(left: SourceWindowRect, right: SourceWindowRect): boolean {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function resizeZoneStyle(
  direction: SourceWindowResizeDirection,
  rect: SourceWindowRect,
): React.CSSProperties {
  const half = FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE / 2;
  const style: React.CSSProperties = {
    position: "absolute",
    zIndex: direction.length === 1 ? 8 : 9,
    touchAction: "none",
    cursor: resizeCursor(direction),
    pointerEvents: "auto",
    outlineOffset: -2,
  };
  if (direction === "n" || direction === "s") {
    return {
      ...style,
      left: rect.x + FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
      top: direction === "n" ? rect.y - half : rect.y + rect.height - half,
      width: Math.max(0, rect.width - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE * 2),
      height: FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
    };
  }
  if (direction === "e" || direction === "w") {
    return {
      ...style,
      left: direction === "w" ? rect.x - half : rect.x + rect.width - half,
      top: rect.y + FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
      width: FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
      height: Math.max(0, rect.height - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE * 2),
    };
  }
  return {
    ...style,
    left: direction.includes("w")
      ? rect.x - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE
      : rect.x + rect.width - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
    top: direction.includes("n")
      ? rect.y - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE
      : rect.y + rect.height - FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE,
    width: FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE * 2,
    height: FLOATING_SOURCE_WINDOW_RESIZE_HIT_SIZE * 2,
  };
}

function resizeCursor(direction: SourceWindowResizeDirection): string {
  if (direction === "n" || direction === "s") return "ns-resize";
  if (direction === "e" || direction === "w") return "ew-resize";
  if (direction === "ne" || direction === "sw") return "nesw-resize";
  return "nwse-resize";
}

function resizeEdgeLabel(direction: SourceWindowResizeDirection): string {
  if (direction === "n") return "Resize source window from top edge";
  if (direction === "e") return "Resize source window from right edge";
  if (direction === "s") return "Resize source window from bottom edge";
  return "Resize source window from left edge";
}

function resizeKeyShortcuts(direction: SourceWindowResizeDirection): string {
  return direction === "n" || direction === "s"
    ? "ArrowUp ArrowDown Enter"
    : "ArrowLeft ArrowRight Enter";
}

function sourceWindowSizeText(rect: SourceWindowRect, horizontal: boolean): string {
  return horizontal
    ? `Source window ${Math.round(rect.width)} pixels wide`
    : `Source window ${Math.round(rect.height)} pixels tall`;
}

function sourceWindowOpenerBeforeCommit(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function isDragExcludedTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return element?.closest([
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    '[contenteditable="true"]',
    '[data-source-window-no-drag="true"]',
  ].join(",")) !== null;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

const RESIZE_DIRECTIONS: readonly SourceWindowResizeDirection[] = [
  "n", "ne", "e", "se", "s", "sw", "w", "nw",
];

const LAYER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 30,
  pointerEvents: "none",
  background: "transparent",
};

const HOST_STYLE: React.CSSProperties = {
  position: "absolute",
  display: "flex",
  alignItems: "stretch",
  boxSizing: "border-box",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  pointerEvents: "auto",
  outline: "none",
  background: "rgba(22, 27, 34, 0.98)",
  border: "1px solid #30363d",
  borderRadius: 10,
  boxShadow: "0 18px 48px rgba(0,0,0,0.48)",
};

const FRAME_CLOSE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 10,
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "#1A1F27",
  color: "#9AA4B2",
  cursor: "pointer",
};

const SIDE_RAIL_CLOSE_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "#1A1F27",
  color: "#9AA4B2",
  cursor: "pointer",
};

const MAIN_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  height: "100%",
  display: "flex",
  overflow: "hidden",
};

const RAIL_SIDE_STYLE: React.CSSProperties = {
  flex: "0 0 min(360px, 36%)",
  width: "min(360px, 36%)",
  minWidth: 260,
  minHeight: 0,
  height: "100%",
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  overflow: "hidden",
  borderLeft: "1px solid #30363d",
  background: "rgba(22, 27, 34, 0.97)",
};

const RAIL_OVERLAY_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: "0 0 0 auto",
  zIndex: 5,
  width: "min(360px, 100%)",
  maxWidth: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  overflow: "hidden",
  borderLeft: "1px solid #30363d",
  background: "rgba(22, 27, 34, 0.99)",
  boxShadow: "-14px 0 30px rgba(0,0,0,0.42)",
};

const RAIL_HIDDEN_STYLE: React.CSSProperties = {
  display: "none",
};

const RAIL_CONTENT_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const RAIL_OVERLAY_HEADER_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  minHeight: 38,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "6px 46px 6px 12px",
  borderBottom: "1px solid #30363d",
  background: "#161B22",
};

const RAIL_OVERLAY_TITLE_STYLE: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#E6EDF3",
  fontSize: 11.5,
  fontWeight: 700,
};

const RAIL_OVERLAY_CLOSE_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "#1A1F27",
  color: "#9AA4B2",
  cursor: "pointer",
};

const FLOATING_SOURCE_WINDOW_CSS = `
[data-source-window-drag-handle="true"] {
  cursor: grab;
  touch-action: none;
  user-select: none;
}
[data-source-window-pointer-active="true"] [data-source-window-drag-handle="true"] {
  cursor: grabbing;
}
[data-source-window-resize-zone]:focus-visible {
  outline: 2px solid #58A6FF;
}
`;
