/**
 * The Logic-flow canvas's selection actions. Logic selects by call TARGET rather than by one
 * React Flow node, so a single selection can cover several visible call-site occurrences. The
 * owning view resolves that target to instance ids and keeps the viewport operation local; this
 * component only supplies the shared canvas-action-bar chrome and accessible action states.
 */

import { Panel } from "@xyflow/react";
import {
  CanvasActionBarFrame,
  CanvasActionButton,
  CanvasActionGroup,
} from "./canvasActionBarKit";
import { canvasActionPlacement, panelAnchorStyle, useSurfaceSize } from "./canvasActionBarLayout";
import { CollapseIcon, ExpandIcon, RecenterIcon } from "./icons";

export interface LogicActionBarProps {
  selectedCount: number;
  canFocus: boolean;
  canExpand: boolean;
  canCollapse: boolean;
  onFocusSelection: () => void;
  onExpandSelection: () => void;
  onCollapseSelection: () => void;
}

export function LogicActionBar(props: LogicActionBarProps) {
  const [anchorRef, surfaceSize] = useSurfaceSize();
  // Three icon actions have the same footprint as the shared base bar.
  const placement = canvasActionPlacement(
    surfaceSize?.width ?? null,
    "base",
    surfaceSize?.height ?? null,
  );
  const hasSelection = props.selectedCount > 0;

  return (
    <Panel ref={anchorRef} position={placement.position} style={panelAnchorStyle(placement)}>
      <CanvasActionBarFrame layout={placement.layout}>
        <CanvasActionGroup label="Logic flow selection actions">
          <CanvasActionButton
            ariaLabel="Focus selection"
            title={hasSelection
              ? `Focus the ${selectionNoun(props.selectedCount)} in the viewport`
              : "Focus the whole visible flow in the viewport"}
            icon={<RecenterIcon size={18} />}
            onClick={props.onFocusSelection}
            disabled={!props.canFocus}
          />
          <CanvasActionButton
            ariaLabel="Expand selection"
            title={hasSelection
              ? "Expand every collapsed occurrence in the current selection"
              : "Expand every collapsed occurrence in the whole visible flow"}
            icon={<ExpandIcon size={18} />}
            onClick={props.onExpandSelection}
            disabled={!props.canExpand}
          />
          <CanvasActionButton
            ariaLabel="Collapse selection"
            title={hasSelection
              ? "Collapse every open occurrence in the current selection"
              : "Collapse every open occurrence in the whole visible flow"}
            icon={<CollapseIcon size={18} />}
            onClick={props.onCollapseSelection}
            disabled={!props.canCollapse}
          />
        </CanvasActionGroup>
      </CanvasActionBarFrame>
    </Panel>
  );
}

function selectionNoun(count: number): string {
  return count === 1 ? "selected occurrence" : `${count} selected occurrences`;
}
