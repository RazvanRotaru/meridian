/**
 * Directional incoming-call lens for callable Map nodes.
 *
 * The visible React Flow handle remains the graph anchor. A larger semantic button sits over it,
 * while the count badge and caller popover render in a screen-space overlay so they can never be
 * hidden by another card. Hover/focus previews the incoming-call count; click pins the caller list
 * and asks GraphSurface to raise the matching presentation wires above the canvas.
 */

import { Cross2Icon } from "@radix-ui/react-icons";
import { Handle, Position, useStore, useViewport } from "@xyflow/react";
import type { CallSite, GraphEdge, GraphNode } from "@meridian/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GraphIndex } from "../../graph/graphIndex";
import { formatCallSite } from "../../graph/edgeEvidence";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { MONO } from "../nodes/modulemap/frameChrome";

export interface IncomingCallSiteRow {
  /** Compact source occurrence used in the popover row. */
  label: string;
  /** Full artifact path/range retained for the native tooltip. */
  title: string;
}

export interface IncomingCallerRow {
  callerId: string;
  callerLabel: string;
  callerQualifiedName: string;
  callCount: number;
  /** Syntax occurrences with exact file/line attribution. */
  siteCount: number;
  firstLocation: string;
  firstLocationTitle: string;
  sites: IncomingCallSiteRow[];
  edgeIds: string[];
}

export interface IncomingCallSummary {
  targetId: string;
  callerCount: number;
  callCount: number;
  /** Syntax occurrences with exact file/line attribution. */
  siteCount: number;
  rows: IncomingCallerRow[];
  edgeIds: ReadonlySet<string>;
}

/** Group exact incoming `calls` relationships by caller while retaining every syntax occurrence. */
export function incomingCallSummary(index: GraphIndex, targetId: string): IncomingCallSummary | null {
  const calls = (index.inEdges.get(targetId) ?? []).filter((edge) => edge.kind === "calls");
  if (calls.length === 0) {
    return null;
  }

  const byCaller = new Map<string, GraphEdge[]>();
  for (const edge of calls) {
    const group = byCaller.get(edge.source);
    if (group) {
      group.push(edge);
    } else {
      byCaller.set(edge.source, [edge]);
    }
  }

  const rows = [...byCaller].map(([callerId, edges]) => callerRow(index, callerId, edges));
  rows.sort((left, right) =>
    right.callCount - left.callCount
      || left.callerLabel.localeCompare(right.callerLabel)
      || left.callerId.localeCompare(right.callerId),
  );
  return {
    targetId,
    callerCount: rows.length,
    callCount: rows.reduce((total, row) => total + row.callCount, 0),
    siteCount: rows.reduce((total, row) => total + row.siteCount, 0),
    rows,
    edgeIds: new Set(calls.map((edge) => edge.id)),
  };
}

function callerRow(index: GraphIndex, callerId: string, edges: GraphEdge[]): IncomingCallerRow {
  const caller = index.nodesById.get(callerId);
  const sites = edges.flatMap((edge) => edge.callSites ?? []).map(callSiteRow);
  // Exact extractor occurrences are preferred. A lifted/legacy relationship can carry only a
  // weight; it still proves calls exist, but the UI never invents source lines for those sites.
  const callCount = edges.reduce(
    (total, edge) => total + ((edge.callSites?.length ?? 0) > 0 ? edge.callSites!.length : edge.weight ?? 1),
    0,
  );
  const fallback = callerLocation(caller, callerId);
  const first = sites[0] ?? fallback;
  return {
    callerId,
    callerLabel: caller?.displayName ?? shortId(callerId),
    callerQualifiedName: caller?.qualifiedName ?? callerId,
    callCount,
    siteCount: sites.length,
    firstLocation: first.label,
    firstLocationTitle: first.title,
    sites,
    edgeIds: edges.map((edge) => edge.id),
  };
}

function callSiteRow(site: CallSite): IncomingCallSiteRow {
  return {
    // The line is the useful differentiator. Compact a long basename from the leading side so the
    // suffix and `:line` stay visible in the fixed-width caller column.
    label: `${compactBasename(site.file)}:${site.line}`,
    title: formatCallSite(site),
  };
}

function callerLocation(caller: GraphNode | undefined, callerId: string): IncomingCallSiteRow {
  if (!caller) {
    return { label: "Location unavailable", title: callerId };
  }
  const line = caller.location.startLine;
  return {
    label: `${compactBasename(caller.location.file)}${line === undefined ? "" : `:${line}`}`,
    title: `${caller.location.file}${line === undefined ? "" : `:${line}`} · caller definition; call-site line unavailable`,
  };
}

function compactBasename(path: string): string {
  const name = basename(path);
  const maxLength = 22;
  return name.length <= maxLength ? name : `…${name.slice(-(maxLength - 1))}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function shortId(id: string): string {
  return id.split(/[.#/]/).filter(Boolean).pop() ?? id;
}

export interface IncomingCallLensController {
  enabled: boolean;
  activeTargetId: string | null;
  pinnedTargetId: string | null;
  preview(targetId: string | null): void;
  toggle(targetId: string, origin?: HTMLButtonElement): void;
  close(): void;
  focusOrigin(): void;
}

const NO_LENS: IncomingCallLensController = {
  enabled: false,
  activeTargetId: null,
  pinnedTargetId: null,
  preview: () => undefined,
  toggle: () => undefined,
  close: () => undefined,
  focusOrigin: () => undefined,
};

const IncomingCallLensContext = createContext<IncomingCallLensController>(NO_LENS);

export function IncomingCallLensScope(props: {
  value: IncomingCallLensController;
  children: ReactNode;
}) {
  return (
    <IncomingCallLensContext.Provider value={props.value}>
      {props.children}
    </IncomingCallLensContext.Provider>
  );
}

export function useIncomingCallLens(): IncomingCallLensController {
  return useContext(IncomingCallLensContext);
}

/** Surface-local controller: only the active canvas owns one pinned call lens. */
export function useIncomingCallLensController(
  enabled: boolean,
  onActivate?: (targetId: string) => void,
): IncomingCallLensController {
  const [previewTargetId, setPreviewTargetId] = useState<string | null>(null);
  const [pinnedTargetId, setPinnedTargetId] = useState<string | null>(null);
  const originRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setPreviewTargetId(null);
    setPinnedTargetId(null);
  }, []);
  const preview = useCallback((targetId: string | null) => {
    setPreviewTargetId(enabled ? targetId : null);
  }, [enabled]);
  const focusOrigin = useCallback(() => {
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => {
      if (originRef.current?.isConnected) {
        originRef.current.focus({ preventScroll: true });
      }
    });
  }, []);
  const toggle = useCallback((targetId: string, origin?: HTMLButtonElement) => {
    if (!enabled) return;
    const opening = pinnedTargetId !== targetId;
    setPinnedTargetId(opening ? targetId : null);
    if (opening) {
      originRef.current = origin ?? null;
      onActivate?.(targetId);
    }
  }, [enabled, onActivate, pinnedTargetId]);

  useEffect(() => {
    if (!enabled) close();
  }, [close, enabled]);

  useEffect(() => {
    if (pinnedTargetId === null) return;
    // Dismiss after the outside control's click completes. Closing on pointer-down can move a
    // raised wire between down/up and retarget the resulting click to the canvas beneath it.
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element
        && target.closest("[data-incoming-call-socket], [data-incoming-call-popover]") !== null
      ) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      focusOrigin();
    };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, focusOrigin, pinnedTargetId]);

  return useMemo(() => ({
    enabled,
    activeTargetId: pinnedTargetId ?? previewTargetId,
    pinnedTargetId,
    preview,
    toggle,
    close,
    focusOrigin,
  }), [close, enabled, focusOrigin, pinnedTargetId, preview, previewTargetId, toggle]);
}

/** The unchanged six-pixel handle plus its 24px accessible incoming-call hit target. */
export function IncomingCallTargetPort(props: {
  nodeId: string;
  nodeLabel: string;
  callable: boolean;
  pinStyle: React.CSSProperties;
}) {
  const lens = useIncomingCallLens();
  const index = useBlueprint((state) => state.index);
  const zoom = useStore((state) => state.transform[2]);
  const summary = useMemo(
    () => props.callable ? incomingCallSummary(index, props.nodeId) : null,
    [index, props.callable, props.nodeId],
  );
  const interactive = lens.enabled && summary !== null;
  const active = interactive && lens.activeTargetId === props.nodeId;
  const open = interactive && lens.pinnedTargetId === props.nodeId;
  const metric = summary === null ? null : summaryMetric(summary);
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        style={interactive ? { ...props.pinStyle, pointerEvents: "none" } : props.pinStyle}
        isConnectable={false}
      />
      {interactive ? (
        <button
          type="button"
          className="nodrag nopan incoming-call-socket"
          style={{ ...SOCKET_BUTTON, transform: incomingCallSocketTransform(zoom) }}
          data-incoming-call-socket="true"
          data-node-id={props.nodeId}
          data-call-lens-active={active ? "true" : "false"}
          aria-label={`Show ${summary.callCount} incoming ${plural(summary.callCount, "call")} from ${summary.callerCount} ${plural(summary.callerCount, "caller")} to ${props.nodeLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId(props.nodeId) : undefined}
          title={`${summary.callerCount} ${plural(summary.callerCount, "caller")} · ${metric!.count} ${plural(metric!.count, metric!.noun)} — click to inspect incoming calls`}
          onPointerEnter={() => lens.preview(props.nodeId)}
          onPointerLeave={() => lens.preview(null)}
          onFocus={() => lens.preview(props.nodeId)}
          onBlur={() => lens.preview(null)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const focusDialog = shouldFocusIncomingCallDialog(event.detail, open);
            const scope = event.currentTarget.closest(".react-flow");
            lens.toggle(props.nodeId, event.currentTarget);
            if (focusDialog) focusPopover(props.nodeId, scope);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </>
  );
}

/** Screen-space lens chrome, mounted inside React Flow but above its transformed node/edge layers. */
export function IncomingCallLensOverlay() {
  const lens = useIncomingCallLens();
  const targetId = lens.activeTargetId;
  const index = useBlueprint((state) => state.index);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const { selectModule, showCode } = useBlueprintActions();
  const summary = useMemo(
    () => targetId === null ? null : incomingCallSummary(index, targetId),
    [index, targetId],
  );
  const internal = useStore((state) => targetId === null ? undefined : state.nodeLookup.get(targetId));
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const viewport = useViewport();
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [targetId]);

  if (
    targetId === null
    || summary === null
    || internal === undefined
    || canvasWidth <= 0
    || canvasHeight <= 0
  ) {
    return null;
  }
  const measuredHeight = internal.measured.height ?? 0;
  const anchorX = internal.internals.positionAbsolute.x * viewport.zoom + viewport.x;
  const anchorY = (internal.internals.positionAbsolute.y + measuredHeight / 2) * viewport.zoom + viewport.y;
  const panelWidth = Math.min(356, Math.max(260, canvasWidth - 24));
  const panelHeightAllowance = Math.min(430, Math.max(220, canvasHeight - 24));
  const hasLeftRoom = anchorX >= panelWidth + 56;
  const panelLeft = hasLeftRoom
    ? anchorX - panelWidth - 44
    : clamp(anchorX + 32, 12, Math.max(12, canvasWidth - panelWidth - 12));
  const panelTop = clamp(anchorY + 14, 12, Math.max(12, canvasHeight - panelHeightAllowance - 12));
  const visibleRows = showAll ? summary.rows : summary.rows.slice(0, 8);
  const open = lens.pinnedTargetId === targetId;
  const target = index.nodesById.get(targetId);
  const metric = summaryMetric(summary);

  const closeAndReturnFocus = () => {
    lens.close();
    lens.focusOrigin();
  };
  const openCaller = (row: IncomingCallerRow) => {
    const caller = index.nodesById.get(row.callerId);
    selectModule(row.callerId);
    lens.close();
    if (sourceUrl !== null && caller !== undefined) {
      void showCode(caller, { mode: "modal" });
    }
  };

  return (
    <div style={OVERLAY_LAYER} data-incoming-call-lens-overlay="true">
      <div
        style={{ ...COUNT_PILL, left: anchorX - 14, top: anchorY }}
        aria-hidden="true"
        data-incoming-call-count="true"
      >
        {summary.callerCount} {plural(summary.callerCount, "caller")} · {metric.count} {plural(metric.count, metric.noun)}
      </div>
      {open ? (
        <section
          id={popoverId(targetId)}
          className="nodrag nopan nowheel"
          style={{ ...POPOVER, width: panelWidth, left: panelLeft, top: panelTop, maxHeight: panelHeightAllowance }}
          role="dialog"
          tabIndex={-1}
          aria-modal="false"
          aria-labelledby={`${popoverId(targetId)}-title`}
          data-incoming-call-popover="true"
          data-node-id={targetId}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <header style={POPOVER_HEADER}>
            <div style={POPOVER_TITLE_WRAP}>
              <strong id={`${popoverId(targetId)}-title`} style={POPOVER_TITLE}>Called by</strong>
              <span style={POPOVER_TARGET} title={target?.qualifiedName ?? targetId}>
                {target?.displayName ?? shortId(targetId)}
              </span>
            </div>
            <button
              type="button"
              style={CLOSE_BUTTON}
              aria-label="Close incoming calls"
              title="Close incoming calls"
              onClick={closeAndReturnFocus}
            >
              <Cross2Icon width={14} height={14} aria-hidden="true" />
            </button>
          </header>
          <div style={CALLER_LIST} data-incoming-call-list="true">
            {visibleRows.map((row) => (
              <button
                key={row.callerId}
                type="button"
                style={CALLER_BUTTON}
                title={`${row.callerQualifiedName} · ${row.firstLocationTitle}`}
                aria-label={`Open caller ${row.callerLabel} at ${row.firstLocationTitle}`}
                data-incoming-caller-id={row.callerId}
                onClick={() => openCaller(row)}
              >
                <span style={CALLER_PRIMARY}>
                  <span style={CALLER_NAME}>{row.callerLabel}</span>
                  <span style={CALLER_LOCATION}>{row.firstLocation}</span>
                </span>
                {showAll ? (
                  <span style={SITE_LIST} aria-label={`${row.siteCount} attributed call sites`}>
                    {row.sites.length > 0
                      ? row.sites.map((site, index) => (
                          <span key={`${site.title}:${index}`} style={SITE_ROW} title={site.title}>{site.label}</span>
                        ))
                      : <span style={SITE_ROW}>{row.callCount} {plural(row.callCount, "call")} · source line unavailable</span>}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            style={OPEN_ALL_BUTTON}
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show caller summary" : `Open all ${summary.callerCount}`}
          </button>
        </section>
      ) : null}
    </div>
  );
}

function popoverId(nodeId: string): string {
  let hash = 0;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash = (hash * 31 + nodeId.charCodeAt(index)) >>> 0;
  }
  return `incoming-call-popover-${hash.toString(36)}`;
}

/** Counteract React Flow's canvas zoom so the semantic hit target stays 24 CSS pixels. */
export function incomingCallSocketTransform(zoom: number): string {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return `translateY(-50%) scale(${1 / safeZoom})`;
}

/** Native keyboard and assistive-tech button activation arrives as a zero-detail click. */
export function shouldFocusIncomingCallDialog(eventDetail: number, alreadyOpen: boolean): boolean {
  return eventDetail === 0 && !alreadyOpen;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function summaryMetric(summary: IncomingCallSummary): { count: number; noun: "site" | "call" } {
  // Preserve the compact design's “sites” vocabulary only when every occurrence is attributable.
  return summary.siteCount === summary.callCount
    ? { count: summary.siteCount, noun: "site" }
    : { count: summary.callCount, noun: "call" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function focusPopover(targetId: string, scope: Element | null): void {
  if (scope === null || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => {
    const popovers = scope.querySelectorAll<HTMLElement>("[data-incoming-call-popover]");
    for (const popover of popovers) {
      if (popover.dataset.nodeId === targetId) {
        popover.focus({ preventScroll: true });
        return;
      }
    }
  });
}

const SOCKET_BUTTON: React.CSSProperties = {
  position: "absolute",
  zIndex: 5,
  left: -12,
  top: "50%",
  width: 24,
  height: 24,
  transformOrigin: "center",
  padding: 0,
  border: "none",
  borderRadius: 999,
  background: "transparent",
  cursor: "pointer",
};

const OVERLAY_LAYER: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 30,
  pointerEvents: "none",
  fontFamily: MONO,
};

const COUNT_PILL: React.CSSProperties = {
  position: "absolute",
  transform: "translate(-100%, -50%)",
  minHeight: 25,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  border: "1px solid rgba(139, 152, 255, 0.72)",
  borderRadius: 6,
  background: "rgba(28, 34, 48, 0.97)",
  color: "#AEB9FF",
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.38), inset 0 0 0 1px rgba(255,255,255,0.025)",
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

const POPOVER: React.CSSProperties = {
  position: "absolute",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  border: "1px solid #3A4351",
  borderRadius: 7,
  background: "rgba(19, 24, 31, 0.985)",
  color: "#DCE5F0",
  boxShadow: "0 16px 42px rgba(0, 0, 0, 0.54), inset 0 1px 0 rgba(255,255,255,0.035)",
  pointerEvents: "auto",
};

const POPOVER_HEADER: React.CSSProperties = {
  minHeight: 42,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 9px 7px 12px",
  borderBottom: "1px solid #2B333F",
};

const POPOVER_TITLE_WRAP: React.CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const POPOVER_TITLE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 13,
  letterSpacing: "0.01em",
  color: "#F0F5FB",
};

const POPOVER_TARGET: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#7E8A9B",
  fontSize: 10,
};

const CLOSE_BUTTON: React.CSSProperties = {
  flexShrink: 0,
  width: 26,
  height: 26,
  marginLeft: "auto",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid transparent",
  borderRadius: 5,
  background: "transparent",
  color: "#7F8B99",
  cursor: "pointer",
};

const CALLER_LIST: React.CSSProperties = {
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
};

const CALLER_BUTTON: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "8px 12px",
  border: "none",
  borderBottom: "1px solid #2A313B",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

const CALLER_PRIMARY: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const CALLER_NAME: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "#D8E0EA",
};

const CALLER_LOCATION: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: "48%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 10,
  color: "#8491A3",
};

const SITE_LIST: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

const SITE_ROW: React.CSSProperties = {
  padding: "2px 5px",
  border: "1px solid #303A47",
  borderRadius: 4,
  background: "#181F28",
  color: "#8E9AAC",
  fontSize: 9,
};

const OPEN_ALL_BUTTON: React.CSSProperties = {
  flexShrink: 0,
  minHeight: 40,
  boxSizing: "border-box",
  padding: "0 12px",
  border: "none",
  borderTop: "1px solid #303844",
  background: "rgba(13, 18, 24, 0.88)",
  color: "#69A6FF",
  fontFamily: MONO,
  fontSize: 11,
  fontWeight: 600,
  textAlign: "left",
  cursor: "pointer",
};

export const INCOMING_CALL_LENS_CSS = `
.incoming-call-socket::after {
  content: "";
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(174, 185, 255, 0);
  border-radius: 999px;
  box-shadow: 0 0 0 3px rgba(139, 152, 255, 0);
  transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
  pointer-events: none;
}
.incoming-call-socket:hover::after,
.incoming-call-socket:focus-visible::after,
.incoming-call-socket[data-call-lens-active="true"]::after {
  border-color: rgba(203, 211, 255, 0.96);
  background: rgba(114, 130, 255, 0.14);
  box-shadow: 0 0 0 3px rgba(114, 130, 255, 0.2), 0 0 12px rgba(114, 130, 255, 0.5);
}
.incoming-call-socket:focus-visible {
  outline: 2px solid #D7DEFF;
  outline-offset: 2px;
}
[data-incoming-call-popover] button:hover {
  background-color: rgba(75, 92, 116, 0.24) !important;
}
[data-incoming-call-popover] button:focus-visible {
  outline: 2px solid #AEB9FF;
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .incoming-call-socket::after { transition: none; }
}
`;
