import { useLayoutEffect, useState } from "react";
import type { PanelPosition } from "@xyflow/react";
import { CHROME_EDGE, MINIMAP_H } from "../canvas/flowCanvasProps";
import { CONTROL_PANEL_WIDTH } from "./panelKit";

export type CanvasActionMode = "base" | "extract" | "minimal" | "review-focus" | "codebase";
export type CanvasActionLayout = "row" | "stacked";

export interface CanvasActionPlacement {
  position: PanelPosition;
  layout: CanvasActionLayout;
  left?: number;
  bottom?: number;
}

interface SurfaceSize {
  width: number;
  height: number;
  actionBarWidth: number;
  /** Left edge of the visible bottom-right canvas chrome, relative to the graph surface. */
  bottomChromeLeft: number | null;
}

interface CanvasActionMeasurement extends Pick<SurfaceSize, "actionBarWidth" | "bottomChromeLeft"> {
  /** Review navigation is shallow, so its wide bar may use the free bottom-left lane. */
  shiftIntoBottomLane?: boolean;
}

/** Keep the full bar in one row whenever it can sit beside the control panel. Narrow panes stack
 * whole groups; collision-free bars share the bottom lane, while real chrome collisions lift. */
export function canvasActionPlacement(
  surfaceWidth: number | null,
  mode: CanvasActionMode,
  surfaceHeight: number | null = null,
  extraActionWidth = 0,
  measurement?: CanvasActionMeasurement,
): CanvasActionPlacement {
  const rowWidth = BAR_WIDTHS[mode] + extraActionWidth;
  const layout: CanvasActionLayout =
    surfaceWidth !== null && mode !== "base" && surfaceWidth < CONTROL_CLEARANCE + rowWidth + EDGE_GAP
      ? "stacked"
      : "row";
  const barWidth = layout === "stacked" ? STACKED_BAR_WIDTHS[mode] + extraActionWidth : rowWidth;

  if (surfaceWidth === null || (layout === "row" && surfaceWidth >= CONTROL_CLEARANCE * 2 + rowWidth)) {
    return { position: "bottom-center", layout };
  }
  const edgeClampedLeft = Math.max(EDGE_GAP, surfaceWidth - barWidth - EDGE_GAP);
  const fitsBesideControls = surfaceWidth - barWidth >= CONTROL_PANEL_END;
  const defaultLeft = Math.min(
    CONTROL_CLEARANCE,
    fitsBesideControls ? Math.max(CONTROL_PANEL_END, edgeClampedLeft) : edgeClampedLeft,
  );
  const bottomLaneLeft = measurement?.bottomChromeLeft === null || measurement?.bottomChromeLeft === undefined
    ? null
    : measurement.bottomChromeLeft - EDGE_GAP - measurement.actionBarWidth;
  const left = measurement?.shiftIntoBottomLane === true && bottomLaneLeft !== null && bottomLaneLeft >= EDGE_GAP
    ? Math.min(defaultLeft, bottomLaneLeft)
    : defaultLeft;
  return {
    position: "bottom-left",
    layout,
    left,
    bottom: actionBarBottom(
      surfaceHeight,
      layout,
      left + (measurement?.actionBarWidth ?? barWidth),
      measurement?.bottomChromeLeft,
    ),
  };
}

function actionBarBottom(
  surfaceHeight: number | null,
  layout: CanvasActionLayout,
  barRight: number,
  bottomChromeLeft?: number | null,
): number {
  // The bar and the minimap/legend/zoom cluster can share the bottom lane whenever their measured
  // horizontal footprints do not meet. Before the first client measurement, retain the lifted
  // fallback so hydration never flashes the action bar over interactive canvas chrome.
  if (bottomChromeLeft === null || (bottomChromeLeft !== undefined && barRight + EDGE_GAP <= bottomChromeLeft)) {
    return EDGE_GAP;
  }
  const barHeight = layout === "stacked" ? STACKED_BAR_HEIGHT : ROW_BAR_HEIGHT;
  if (surfaceHeight === null) {
    return NORMAL_BOTTOM;
  }
  return Math.min(NORMAL_BOTTOM, Math.max(EDGE_GAP, surfaceHeight - barHeight - EDGE_GAP));
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
      const chromeLefts = [...surface.querySelectorAll<HTMLElement>(BOTTOM_CHROME_SELECTOR)]
        .map((chrome) => chrome.getBoundingClientRect())
        .filter((bounds) => bounds.width > 0 && bounds.height > 0)
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
    // Placement normally preserves EDGE_GAP. When a wider stacked group only just fits beside the
    // controls, allow it to use the smaller remaining edge margin instead of becoming scrollable.
    maxWidth: `calc(100% - ${placement.left ?? 0}px)`,
    zIndex: (placement.left ?? CONTROL_CLEARANCE) < CONTROL_CLEARANCE || (placement.bottom ?? NORMAL_BOTTOM) < NORMAL_BOTTOM ? 7 : 4,
  };
}

const EDGE_GAP = 16;
const CONTROL_PANEL_END = CHROME_EDGE + CONTROL_PANEL_WIDTH;
const CONTROL_CLEARANCE = CHROME_EDGE + CONTROL_PANEL_WIDTH + EDGE_GAP;
const NORMAL_BOTTOM = MINIMAP_H + CHROME_EDGE + EDGE_GAP;
const ROW_BAR_HEIGHT = 54;
const STACKED_BAR_HEIGHT = 109;
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
  zIndex: 4,
};
