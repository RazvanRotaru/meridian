import { useLayoutEffect, useState } from "react";
import type { PanelPosition } from "@xyflow/react";
import { CHROME_EDGE } from "../canvas/flowCanvasProps";
import { CONTROL_PANEL_WIDTH } from "./panelKit";

export type CanvasActionMode = "base" | "extract" | "minimal" | "review-focus" | "codebase";
export type CanvasActionLayout = "row" | "stacked";

export interface CanvasActionPlacement {
  position: PanelPosition;
  layout: CanvasActionLayout;
  left?: number;
  bottom?: number;
  maxWidth?: number;
  compact?: boolean;
}

interface SurfaceSize {
  width: number;
  height: number;
  actionBarWidth: number;
  /** Left edge of the visible bottom-right canvas chrome, relative to the graph surface. */
  bottomChromeLeft: number | null;
}

interface CanvasActionMeasurement extends Pick<SurfaceSize, "bottomChromeLeft"> {
  /** Review navigation is shallow, so its wide bar may use the free bottom-left lane. */
  shiftIntoBottomLane?: boolean;
  /** Secondary actions can move behind the accessible overflow control. */
  canCompact?: boolean;
}

/** Keep the full bar in one row whenever it can sit beside the control panel. Narrow panes stack
 * whole groups and compact secondary actions before constraining the row. Vertical placement is an
 * invariant: width pressure must never push primary canvas actions up into the graph. */
export function canvasActionPlacement(
  surfaceWidth: number | null,
  mode: CanvasActionMode,
  _surfaceHeight: number | null = null,
  extraActionWidth = 0,
  measurement?: CanvasActionMeasurement,
): CanvasActionPlacement {
  const rowWidth = BAR_WIDTHS[mode] + extraActionWidth;
  const layout: CanvasActionLayout =
    surfaceWidth !== null && mode !== "base" && surfaceWidth < CONTROL_CLEARANCE + rowWidth + EDGE_GAP
      ? "stacked"
      : "row";
  const barWidth = layout === "stacked" ? STACKED_BAR_WIDTHS[mode] + extraActionWidth : rowWidth;
  const chromeLeft = measurement?.bottomChromeLeft;

  if (surfaceWidth === null) {
    return { position: "bottom-center", layout };
  }
  const centeredRight = (surfaceWidth + rowWidth) / 2;
  const centeredClearsChrome = chromeLeft === null
    || chromeLeft === undefined
    || centeredRight + EDGE_GAP <= chromeLeft;
  if (layout === "row"
      && surfaceWidth >= CONTROL_CLEARANCE * 2 + rowWidth
      && centeredClearsChrome) {
    return { position: "bottom-center", layout };
  }
  const edgeClampedLeft = Math.max(EDGE_GAP, surfaceWidth - barWidth - EDGE_GAP);
  const fitsBesideControls = surfaceWidth - barWidth >= CONTROL_PANEL_END;
  const defaultLeft = Math.min(
    CONTROL_CLEARANCE,
    fitsBesideControls ? Math.max(CONTROL_PANEL_END, edgeClampedLeft) : edgeClampedLeft,
  );
  const fullBottomLaneLeft = chromeLeft === null || chromeLeft === undefined
    ? null
    : chromeLeft - EDGE_GAP - barWidth;
  let left = measurement?.shiftIntoBottomLane === true
      && fullBottomLaneLeft !== null
      && fullBottomLaneLeft >= EDGE_GAP
    ? Math.min(defaultLeft, fullBottomLaneLeft)
    : defaultLeft;
  const collidesWithChrome = chromeLeft !== null
    && chromeLeft !== undefined
    && left + barWidth + EDGE_GAP > chromeLeft;
  const collidesWithSurface = left + barWidth + EDGE_GAP > surfaceWidth;
  const compact = (collidesWithChrome || collidesWithSurface)
    && measurement?.canCompact === true;
  if (compact) {
    // Compact groups have a different max-of-groups width when stacked, so do not infer their
    // footprint by subtracting icon slots. Give them the complete left lane and let the measured
    // chrome boundary clamp the frame without a resize feedback loop.
    left = EDGE_GAP;
  }
  return {
    position: "bottom-left",
    layout,
    left,
    bottom: EDGE_GAP,
    ...(chromeLeft === null || chromeLeft === undefined
      ? {}
      : { maxWidth: Math.max(0, chromeLeft - left - EDGE_GAP) }),
    ...(compact ? { compact: true } : {}),
  };
}

export function useSurfaceSize(): [(element: HTMLDivElement | null) => void, SurfaceSize | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<SurfaceSize | null>(null);
  useLayoutEffect(() => {
    const actionBar = element;
    const surface = actionBar?.parentElement ?? null;
    if (actionBar === null || surface === null) {
      return;
    }
    const observedChrome = new Set<Element>();
    let observer: ResizeObserver;
    const observeChrome = () => {
      for (const chrome of surface.querySelectorAll<HTMLElement>(BOTTOM_CHROME_SELECTOR)) {
        if (!observedChrome.has(chrome)) {
          observedChrome.add(chrome);
          observer.observe(chrome);
        }
      }
    };
    const update = () => {
      observeChrome();
      const surfaceBounds = surface.getBoundingClientRect();
      const actionBarBounds = actionBar.getBoundingClientRect();
      const chromeLefts = [...surface.querySelectorAll<HTMLElement>(BOTTOM_CHROME_SELECTOR)]
        .map((chrome) => chrome.getBoundingClientRect())
        .filter((bounds) => bounds.width > 0
          && bounds.height > 0
          && bounds.bottom > actionBarBounds.top
          && bounds.top < actionBarBounds.bottom)
        .map((bounds) => bounds.left - surfaceBounds.left);
      const next: SurfaceSize = {
        width: surfaceBounds.width,
        height: surfaceBounds.height,
        actionBarWidth: actionBar.getBoundingClientRect().width,
        bottomChromeLeft: chromeLefts.length === 0 ? null : Math.min(...chromeLefts),
      };
      setSize((current) => sameSurfaceSize(current, next) ? current : next);
    };
    observer = new ResizeObserver(update);
    observer.observe(surface);
    observer.observe(actionBar);
    const mutationObserver = new MutationObserver((records) => {
      if (records.some(isBottomChromeMutation)) {
        update();
      }
    });
    mutationObserver.observe(surface, { childList: true, subtree: true });
    update();
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [element]);
  return [setElement, size];
}

function isBottomChromeMutation(record: MutationRecord): boolean {
  return [...record.addedNodes, ...record.removedNodes].some((node) =>
    node instanceof Element
      && (node.matches(BOTTOM_CHROME_SELECTOR) || node.querySelector(BOTTOM_CHROME_SELECTOR) !== null));
}

function sameSurfaceSize(current: SurfaceSize | null, next: SurfaceSize): boolean {
  return current !== null
    && near(current.width, next.width)
    && near(current.height, next.height)
    && near(current.actionBarWidth, next.actionBarWidth)
    && (current.bottomChromeLeft === null
      ? next.bottomChromeLeft === null
      : next.bottomChromeLeft !== null && near(current.bottomChromeLeft, next.bottomChromeLeft));
}

function near(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.5;
}

export function panelAnchorStyle(placement: CanvasActionPlacement): React.CSSProperties {
  if (placement.position === "bottom-center") {
    return CENTERED_ANCHOR_STYLE;
  }
  return {
    left: placement.left,
    bottom: placement.bottom,
    margin: 0,
    // The frame owns horizontal overflow, so a pane can remain usable even after all secondary
    // actions have moved behind More. This boundary prevents the bar from painting over the
    // MiniMap or Legend while preserving the fixed bottom inset.
    maxWidth: placement.maxWidth === undefined
      ? `calc(100% - ${(placement.left ?? 0) + EDGE_GAP}px)`
      : placement.maxWidth,
    zIndex: 7,
  };
}

const EDGE_GAP = 16;
const CONTROL_PANEL_END = CHROME_EDGE + CONTROL_PANEL_WIDTH;
const CONTROL_CLEARANCE = CHROME_EDGE + CONTROL_PANEL_WIDTH + EDGE_GAP;
const BOTTOM_CHROME_SELECTOR = '[data-canvas-bottom-chrome], .react-flow__controls, .react-flow__minimap';
const BASE_BAR_WIDTH = 144;
const BAR_WIDTHS: Record<CanvasActionMode, number> = {
  base: BASE_BAR_WIDTH,
  extract: 262,
  minimal: 590,
  "review-focus": 650,
  codebase: 282,
};
const STACKED_BAR_WIDTHS: Record<CanvasActionMode, number> = {
  base: BASE_BAR_WIDTH,
  extract: BASE_BAR_WIDTH,
  minimal: 400,
  "review-focus": 460,
  codebase: 228,
};
const CENTERED_ANCHOR_STYLE: React.CSSProperties = {
  marginBottom: EDGE_GAP,
  maxWidth: `calc(100% - ${EDGE_GAP * 2}px)`,
  zIndex: 7,
};
