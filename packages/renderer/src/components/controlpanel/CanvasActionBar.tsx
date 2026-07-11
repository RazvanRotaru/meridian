/**
 * The canvas-wide actions, kept out of the narrow control-panel header. The bar sits at the
 * bottom-center of the active graph surface, Canva-style, and absorbs the contextual extraction
 * action so two floating controls never compete for the same space.
 */

import { useLayoutEffect, useState } from "react";
import { Panel, type PanelPosition } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { CHROME_EDGE, MINIMAP_H } from "../canvas/flowCanvasProps";
import { CONTROL_PANEL_WIDTH, TOKENS } from "./panelKit";
import { CollapseIcon, ExpandIcon, ExtractSelectionIcon, RecenterIcon } from "./icons";

export function CanvasActionBar() {
  const selectedCount = useBlueprint((state) => state.moduleSelected.size);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const { recenter, expandAll, collapseAll, buildMinimalGraph } = useBlueprintActions();
  const [anchorRef, surfaceWidth] = useSurfaceWidth();

  const canExtract = selectedCount > 0 && !minimalOpen;
  const placement = canvasActionPlacement(surfaceWidth, canExtract);
  return (
    <Panel ref={anchorRef} position={placement.position} style={panelAnchorStyle(placement)}>
      <div id="meridian-canvas-action-bar" role="group" aria-label="Canvas actions" className="mrd-scroll" style={BAR_STYLE}>
        <ActionButton
          ariaLabel="Recenter view"
          title="Recenter on the current selection, or the whole graph if nothing is selected"
          icon={<RecenterIcon size={18} />}
          onClick={recenter}
        />
        <ActionButton
          ariaLabel="Expand one level"
          title="Expand the selection one level, or the whole view when nothing is selected"
          icon={<ExpandIcon size={18} />}
          onClick={expandAll}
        />
        <ActionButton
          ariaLabel="Collapse all"
          title="Collapse all open containers in the selection, or the whole view when nothing is selected"
          icon={<CollapseIcon size={18} />}
          onClick={collapseAll}
        />
        {canExtract ? (
          <>
            <span role="separator" aria-orientation="vertical" style={SEPARATOR_STYLE} />
            <ActionButton
              primary
              badge={selectedCount}
              ariaLabel={`Extract selection (${selectedCount})`}
              title="Extract the current selection into a focused graph"
              icon={<ExtractSelectionIcon size={18} />}
              onClick={buildMinimalGraph}
            />
          </>
        ) : null}
      </div>
    </Panel>
  );
}

interface ActionBarPlacement {
  position: PanelPosition;
  left?: number;
  bottom?: number;
}

/** Keep the compact bar centered while the graph has a clear bottom lane. When a review / explorer
 * rail narrows that lane, move it right of the control panel and above the minimap instead. */
export function canvasActionPlacement(surfaceWidth: number | null, canExtract: boolean): ActionBarPlacement {
  const barWidth = canExtract ? EXTRACT_BAR_WIDTH : BASE_BAR_WIDTH;
  if (surfaceWidth === null || surfaceWidth >= CONTROL_CLEARANCE * 2 + barWidth) {
    return { position: "bottom-center" };
  }
  return {
    position: "bottom-left",
    left: Math.min(CONTROL_CLEARANCE, Math.max(EDGE_GAP, surfaceWidth - barWidth - EDGE_GAP)),
    bottom: MINIMAP_H + CHROME_EDGE + EDGE_GAP,
  };
}

function useSurfaceWidth(): [(element: HTMLDivElement | null) => void, number | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const surface = element?.parentElement ?? null;
    if (surface === null) {
      return;
    }
    const update = () => setWidth(surface.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return [setElement, width];
}

function ActionButton(props: {
  ariaLabel: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      style={props.primary ? PRIMARY_ACTION_STYLE : ACTION_STYLE}
      aria-label={props.ariaLabel}
      title={props.title}
      onClick={props.onClick}
    >
      <span style={ICON_STYLE}>{props.icon}</span>
      {props.badge === undefined ? null : <span aria-hidden style={BADGE_STYLE}>{props.badge}</span>}
    </button>
  );
}

const EDGE_GAP = 16;
const CONTROL_CLEARANCE = CHROME_EDGE + CONTROL_PANEL_WIDTH + EDGE_GAP;
const BASE_BAR_WIDTH = 144;
const EXTRACT_BAR_WIDTH = 213;
const CENTERED_ANCHOR_STYLE: React.CSSProperties = { marginBottom: EDGE_GAP, maxWidth: `calc(100% - ${EDGE_GAP * 2}px)`, zIndex: 4 };

function panelAnchorStyle(placement: ActionBarPlacement): React.CSSProperties {
  if (placement.position === "bottom-center") {
    return CENTERED_ANCHOR_STYLE;
  }
  return {
    left: placement.left,
    bottom: placement.bottom,
    margin: 0,
    maxWidth: `calc(100% - ${(placement.left ?? 0) + EDGE_GAP}px)`,
    zIndex: 4,
  };
}
const BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  maxWidth: "100%",
  overflowX: "auto",
  boxSizing: "border-box",
  padding: 5,
  borderRadius: 13,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(10,13,18,0.94)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.35)",
};
const ACTION_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flexShrink: 0,
  width: 42,
  height: 42,
  padding: 0,
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: TOKENS.textMuted,
  cursor: "pointer",
  font: "inherit",
};
const PRIMARY_ACTION_STYLE: React.CSSProperties = {
  ...ACTION_STYLE,
  width: "auto",
  minWidth: 56,
  padding: "0 9px",
  border: "1px solid #2F5C3B",
  background: "rgba(86,194,113,0.16)",
  color: "#6BE38A",
};
const ICON_STYLE: React.CSSProperties = { display: "inline-flex", flexShrink: 0 };
const BADGE_STYLE: React.CSSProperties = { minWidth: 14, color: "inherit", fontSize: 10.5, fontWeight: 700, lineHeight: 1, textAlign: "center" };
const SEPARATOR_STYLE: React.CSSProperties = { width: 1, height: 24, margin: "0 3px", flexShrink: 0, background: TOKENS.divider };
