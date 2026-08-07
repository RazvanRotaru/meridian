import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_SOURCE_DOCK_RATIO,
  readSourceDockRatio,
  writeSourceDockRatio,
} from "../../state/sourceDockPreference";
import { ResizeHandle } from "../layout/ResizeHandle";
import {
  sourceDockMetrics,
  sourceDockRatioForKey,
  sourceDockRatioFromPointer,
  sourceDockValueText,
} from "./sourceDockGeometry";

export const SOURCE_DOCK_ID = "meridian-source-code-dock";
export const SOURCE_DOCK_RESIZE_HIT_WIDTH = 20;

export interface SourceDockControls {
  expanded: boolean;
  initialFocusRef: { current: HTMLElement | null };
  toggleExpanded: () => void;
}

export interface SourceDockProps {
  ariaLabel: string;
  onClose: () => void;
  children: (controls: SourceDockControls) => ReactNode;
}

/** Shell-level modal side sheet. Source content remains host-owned; this component owns only the
 * overlay lifecycle, responsive width, accessible separator, focus boundary, and persistence. */
export function SourceDock(props: SourceDockProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLElement | null>(null);
  // Read before commit: the same commit marks the workspace underlay inert, which may cause some
  // browsers to clear its current focus before layout effects get a chance to capture the opener.
  const openerRef = useRef<HTMLElement | null>(sourceDockOpenerBeforeCommit());
  const [preferredRatio, setPreferredRatio] = useState(readSourceDockRatio);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  const measureContainer = useCallback(() => {
    const width = layerRef.current?.getBoundingClientRect().width ?? 0;
    if (!Number.isFinite(width) || width <= 0) return;
    setContainerWidth((current) => current === width ? current : width);
  }, []);

  useLayoutEffect(() => measureContainer(), [measureContainer]);
  useEffect(() => {
    const layer = layerRef.current;
    if (layer === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureContainer);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [measureContainer]);

  // Capture once for this open lifecycle. Restoration is deferred until the dock DOM has actually
  // gone, and only claims focus if no newer surface or action already selected a destination.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const ownerDocument = dialog?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (dialog === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const active = ownerDocument.activeElement;
    if (openerRef.current === null && active instanceof HTMLElement && active !== ownerDocument.body) {
      openerRef.current = active;
    }
    const focusFrame = ownerWindow.requestAnimationFrame(() => {
      (initialFocusRef.current ?? dialog).focus({ preventScroll: true });
    });
    return () => {
      ownerWindow.cancelAnimationFrame(focusFrame);
      const opener = openerRef.current;
      openerRef.current = null;
      ownerWindow.requestAnimationFrame(() => {
        const current = ownerDocument.activeElement;
        const focusUnclaimed = current === null
          || current === ownerDocument.body
          || current === ownerDocument.documentElement
          || (current instanceof HTMLElement && !current.isConnected);
        if (
          focusUnclaimed
          && opener?.isConnected
          && opener.closest("[inert]") === null
        ) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const ownerDocument = dialog?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (dialog === null || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return;
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isEditableTarget(event.target)) return;
      // In-file search is the sheet's nested Escape layer and owns this key first.
      if (dialog.querySelector('[data-source-search="true"]') !== null) return;
      const higherModalOpen = Array.from(ownerDocument.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
        .some((modal) => modal !== dialog && modal.closest("[inert]") === null);
      if (higherModalOpen) return;
      const target = event.target;
      // A higher modal (for example symbol lookup) lives outside this dialog and owns its Escape.
      // Body/document focus is different: an action inside this sheet may have just unmounted its
      // focused button, leaving focus temporarily unclaimed. The active modal still owns Escape.
      const focusIsUnclaimed = target === ownerDocument.body
        || target === ownerDocument.documentElement
        || target === ownerDocument;
      if (target instanceof Node && !dialog.contains(target) && !focusIsUnclaimed) return;
      event.preventDefault();
      props.onClose();
    };
    // Capture keeps modal dismissal reliable when the previously-focused action just unmounted and
    // another document listener consumes the body-targeted key before it can bubble back here.
    ownerWindow.addEventListener("keydown", closeFromEscape, true);
    return () => ownerWindow.removeEventListener("keydown", closeFromEscape, true);
  }, [props.onClose]);

  const measuredWidth = containerWidth ?? 0;
  const metrics = sourceDockMetrics(preferredRatio, measuredWidth);
  const rememberRatio = (ratio: number) => {
    setPreferredRatio(ratio);
    writeSourceDockRatio(ratio);
  };
  const liveContainerRect = () => layerRef.current?.getBoundingClientRect() ?? null;

  return (
    <div
      ref={layerRef}
      style={DOCK_LAYER_STYLE}
      data-source-code-dock-layer="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        ref={dialogRef}
        id={SOURCE_DOCK_ID}
        role="dialog"
        aria-modal="true"
        aria-label={props.ariaLabel}
        tabIndex={-1}
        style={{ ...DOCK_HOST_STYLE, width: expanded ? "100%" : `${metrics.valuePercent}%` }}
        data-source-code-dock-host="true"
        data-source-code-expanded={expanded ? "true" : "false"}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepFocusInsideSourceDock}
      >
        {!expanded ? (
          <ResizeHandle
            orientation="vertical"
            label="Resize source dock"
            controls={SOURCE_DOCK_ID}
            valueMin={metrics.minPercent}
            valueMax={metrics.maxPercent}
            valueNow={metrics.valuePercent}
            valueText={sourceDockValueText(metrics)}
            keyShortcuts="ArrowLeft ArrowRight Home End Enter"
            title="Drag to resize. Press Enter or double-click to reset."
            dataAttributes={{ "data-source-code-resize-handle": "true" }}
            style={sourceDockHandleStyle}
            renderGrip={(active) => <span aria-hidden style={sourceDockGripStyle(active)} />}
            onDrag={(clientPosition, grabOffset) => {
              if (metrics.minRatio === metrics.maxRatio) return;
              const rect = liveContainerRect();
              if (rect === null) return;
              rememberRatio(sourceDockRatioFromPointer({
                clientPosition,
                grabOffset,
                handleBoundaryOffset: SOURCE_DOCK_RESIZE_HIT_WIDTH / 2,
                containerLeft: rect.left,
                containerWidth: rect.width,
              }));
            }}
            onKeyDown={(event) => {
              const width = liveContainerRect()?.width ?? measuredWidth;
              const next = sourceDockRatioForKey(
                metrics.effectiveRatio,
                event.key,
                event.shiftKey,
                width,
              );
              if (next === null) return;
              event.preventDefault();
              event.stopPropagation();
              rememberRatio(next);
            }}
            onReset={() => rememberRatio(DEFAULT_SOURCE_DOCK_RATIO)}
          />
        ) : null}
        {props.children({
          expanded,
          initialFocusRef,
          toggleExpanded: () => setExpanded((current) => !current),
        })}
      </div>
    </div>
  );
}

function sourceDockOpenerBeforeCommit(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function keepFocusInsideSourceDock(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.getAttribute("aria-hidden") !== "true" && element.closest("[inert]") === null);
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = event.currentTarget.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  return element !== null && (
    element.tagName === "INPUT"
    || element.tagName === "TEXTAREA"
    || element.tagName === "SELECT"
    || element.isContentEditable
  );
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const DOCK_LAYER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 30,
  pointerEvents: "auto",
  background: "transparent",
};

const DOCK_HOST_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: "0 0 0 auto",
  maxWidth: "100%",
  display: "flex",
  pointerEvents: "auto",
  outline: "none",
  boxShadow: "-18px 0 32px rgba(0,0,0,0.42)",
};

function sourceDockHandleStyle(_active: boolean): React.CSSProperties {
  return {
    position: "absolute",
    inset: `0 auto 0 -${SOURCE_DOCK_RESIZE_HIT_WIDTH / 2}px`,
    zIndex: 2,
    width: SOURCE_DOCK_RESIZE_HIT_WIDTH,
    display: "flex",
    alignItems: "stretch",
    justifyContent: "center",
    boxSizing: "border-box",
    border: "none",
    outline: "none",
    background: "transparent",
    cursor: "col-resize",
    touchAction: "none",
  };
}

function sourceDockGripStyle(active: boolean): React.CSSProperties {
  return {
    width: 2,
    height: "100%",
    flex: "0 0 2px",
    background: active ? "#58A6FF" : "#303844",
    boxShadow: active ? "0 0 0 1px rgba(88,166,255,0.22)" : "none",
    pointerEvents: "none",
  };
}
