/**
 * The canvas-wide actions, kept out of the narrow control-panel header. The bar sits at the
 * bottom-center of the active graph surface, Canva-style, and absorbs both the extraction entry
 * point and the extracted graph's own actions so floating controls never compete for space.
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import {
  CanvasActionBarFrame,
  CanvasActionButton,
  CanvasActionGroup,
  CanvasActionSeparator,
} from "./canvasActionBarKit";
import { canvasActionPlacement, panelAnchorStyle, useSurfaceSize, type CanvasActionMode } from "./canvasActionBarLayout";
import {
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  ExtractSelectionIcon,
  RearrangeIcon,
  RecenterIcon,
  ResetIcon,
} from "./icons";

export function CanvasActionBar() {
  const selectedCount = useBlueprint((state) => state.moduleSelected.size);
  const minimalOpen = useBlueprint((state) => state.minimalSeedIds.length > 0);
  const minimalArranged = useBlueprint((state) => state.minimalArrange);
  const minimalChanged = useBlueprint(
    (state) => !sameMembers(state.minimalMemberIds, state.minimalSeedIds) || state.minimalArrange,
  );
  const {
    recenter,
    expandAll,
    collapseAll,
    buildMinimalGraph,
    rearrangeMinimalGraph,
    resetMinimalGraph,
    closeMinimalGraph,
  } = useBlueprintActions();
  const [anchorRef, surfaceSize] = useSurfaceSize();

  const canExtract = selectedCount > 0 && !minimalOpen;
  const mode: CanvasActionMode = minimalOpen ? "minimal" : canExtract ? "extract" : "base";
  const placement = canvasActionPlacement(surfaceSize?.width ?? null, mode, surfaceSize?.height ?? null);
  const boundaryOrientation = placement.layout === "row" ? "vertical" : "horizontal";
  return (
    <Panel ref={anchorRef} position={placement.position} style={panelAnchorStyle(placement)}>
      <CanvasActionBarFrame layout={placement.layout}>
        <CanvasActionGroup label="View actions">
          <CanvasActionButton
            ariaLabel="Recenter view"
            title="Recenter on the current selection, or the whole graph if nothing is selected"
            icon={<RecenterIcon size={18} />}
            onClick={recenter}
          />
          <CanvasActionButton
            ariaLabel="Expand one level"
            title="Expand the selection one level, or the whole view when nothing is selected"
            icon={<ExpandIcon size={18} />}
            onClick={expandAll}
          />
          <CanvasActionButton
            ariaLabel="Collapse all"
            title="Collapse all open containers in the selection, or the whole view when nothing is selected"
            icon={<CollapseIcon size={18} />}
            onClick={collapseAll}
          />
        </CanvasActionGroup>
        {canExtract ? (
          <>
            <CanvasActionSeparator orientation={boundaryOrientation} />
            <CanvasActionGroup label="Selection actions">
              <CanvasActionButton
                primary
                badge={selectedCount}
                ariaLabel={`Extract selection (${selectedCount})`}
                title="Extract the current selection into a focused graph"
                icon={<ExtractSelectionIcon size={18} />}
                onClick={buildMinimalGraph}
              />
            </CanvasActionGroup>
          </>
        ) : null}
        {minimalOpen ? (
          <>
            <CanvasActionSeparator orientation={boundaryOrientation} />
            <CanvasActionGroup label="Extracted graph actions">
              <CanvasActionButton
                ariaLabel="Rearrange extracted graph"
                title={
                  minimalArranged
                    ? "Re-run the compact layout for the current extracted graph"
                    : "Lay out the current extracted graph compactly, ignoring its map positions"
                }
                icon={<RearrangeIcon size={18} />}
                onClick={rearrangeMinimalGraph}
              />
              <CanvasActionButton
                ariaLabel="Reset extracted graph"
                title={
                  minimalChanged
                    ? "Restore the original selection and map positions"
                    : "Already matches the original selection and map positions"
                }
                icon={<ResetIcon size={18} />}
                onClick={resetMinimalGraph}
                disabled={!minimalChanged}
              />
              <CanvasActionSeparator orientation="vertical" />
              <CanvasActionButton
                ariaLabel="Close extracted graph"
                title="Return to the previous graph"
                icon={<CloseIcon size={18} />}
                onClick={closeMinimalGraph}
              />
            </CanvasActionGroup>
          </>
        ) : null}
      </CanvasActionBarFrame>
    </Panel>
  );
}

// Order-independent equality of member ids — Reset also covers arrange-only changes.
function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const members = new Set(a);
  return b.every((id) => members.has(id));
}
