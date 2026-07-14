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

/** Keep the full bar in one row whenever it can sit beside the control panel. Narrow panes stack
 * whole groups; short panes slide the bar downward so every action stays visible. */
export function canvasActionPlacement(
  surfaceWidth: number | null,
  mode: CanvasActionMode,
  surfaceHeight: number | null = null,
): CanvasActionPlacement {
  const rowWidth = BAR_WIDTHS[mode];
  const layout: CanvasActionLayout =
    surfaceWidth !== null && mode !== "base" && surfaceWidth < CONTROL_CLEARANCE + rowWidth + EDGE_GAP
      ? "stacked"
      : "row";
  const barWidth = layout === "stacked" ? STACKED_BAR_WIDTHS[mode] : rowWidth;

  if (surfaceWidth === null || (layout === "row" && surfaceWidth >= CONTROL_CLEARANCE * 2 + rowWidth)) {
    return { position: "bottom-center", layout };
  }
  const edgeClampedLeft = Math.max(EDGE_GAP, surfaceWidth - barWidth - EDGE_GAP);
  const fitsBesideControls = surfaceWidth - barWidth >= CONTROL_PANEL_END;
  return {
    position: "bottom-left",
    layout,
    left: Math.min(
      CONTROL_CLEARANCE,
      fitsBesideControls ? Math.max(CONTROL_PANEL_END, edgeClampedLeft) : edgeClampedLeft,
    ),
    bottom: actionBarBottom(surfaceHeight, layout),
  };
}

function actionBarBottom(surfaceHeight: number | null, layout: CanvasActionLayout): number {
  const barHeight = layout === "stacked" ? STACKED_BAR_HEIGHT : ROW_BAR_HEIGHT;
  if (surfaceHeight === null) {
    return NORMAL_BOTTOM;
  }
  return Math.min(NORMAL_BOTTOM, Math.max(EDGE_GAP, surfaceHeight - barHeight - EDGE_GAP));
}

export function useSurfaceSize(): [(element: HTMLDivElement | null) => void, { width: number; height: number } | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const surface = element?.parentElement ?? null;
    if (surface === null) {
      return;
    }
    const update = () => {
      const bounds = surface.getBoundingClientRect();
      setSize({ width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return [setElement, size];
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
