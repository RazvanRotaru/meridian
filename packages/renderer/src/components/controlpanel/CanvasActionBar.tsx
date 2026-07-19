/**
 * The canvas-wide actions, kept out of the narrow control-panel header. The bar sits at the
 * bottom-center of the active graph surface, Canva-style, and absorbs both the extraction entry
 * point and the extracted graph's own actions so floating controls never compete for space.
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import {
  moduleGraphSurfaceOwner,
  moduleGraphOverlayIsOpen,
  removableModuleSelectionCount,
  reviewSurfaceIsOpen,
} from "../../state/store";
import { isReviewPathInScope } from "../../derive/reviewPathScope";
import {
  CanvasActionBarFrame,
  CanvasActionButton,
  CanvasActionGroup,
  CanvasActionSeparator,
} from "./canvasActionBarKit";
import { canvasActionPlacement, panelAnchorStyle, useSurfaceSize, type CanvasActionMode } from "./canvasActionBarLayout";
import { CanvasRelationFilter } from "./CanvasRelationFilter";
import {
  BackToGraphIcon,
  CloseIcon,
  CodebaseHighlightIcon,
  CollapseIcon,
  ExpandIcon,
  ExtractSelectionIcon,
  GhostVisibilityIcon,
  HighwaysIcon,
  RemoveSelectionIcon,
  RearrangeIcon,
  RecenterIcon,
  ResetIcon,
} from "./icons";

export interface CanvasActionBarProps {
  minimalView?: "graph" | "codebase";
  onShowCodebase?: () => void;
  codebaseButtonRef?: React.Ref<HTMLButtonElement>;
  onBackToGraph?: () => void;
  backButtonRef?: React.Ref<HTMLButtonElement>;
  ghostNodesVisible?: boolean;
  hasGhostNodes?: boolean;
  onToggleGhostNodes?: () => void;
  relationKinds?: readonly string[];
}

export function CanvasActionBar({
  minimalView = "graph",
  onShowCodebase,
  codebaseButtonRef,
  onBackToGraph,
  backButtonRef,
  ghostNodesVisible = true,
  hasGhostNodes = false,
  onToggleGhostNodes,
  relationKinds,
}: CanvasActionBarProps = {}) {
  const selectedCount = useBlueprint((state) => state.moduleSelected.size);
  const removableCount = useBlueprint(removableModuleSelectionCount);
  const minimalOpen = useBlueprint(moduleGraphOverlayIsOpen);
  const surfaceOwner = useBlueprint(moduleGraphSurfaceOwner);
  const emptyReview = surfaceOwner === "prepared-review-empty";
  const preparedOverview = useBlueprint((state) => (
    state.prPreparedArtifactCurrent && state.prPreparedReviewCursor === null
  ));
  const minimalHasMembers = useBlueprint((state) => state.minimalMemberIds.length > 0);
  const minimalArranged = useBlueprint((state) => state.minimalArrange);
  const minimalLayoutStatus = useBlueprint((state) => state.minimalLayoutStatus);
  const minimalCodebaseProjectionPending = useBlueprint((state) => state.minimalCodebaseProjectionPending);
  const flowPaneLayoutStatus = useBlueprint((state) => state.flowPaneLayoutStatus);
  const syntheticExecutionStatus = useBlueprint((state) => state.syntheticExecutionStatus);
  const minimalHistory = useBlueprint((state) => state.minimalGraphHistory);
  const showHighways = useBlueprint((state) => state.showHighways);
  const reviewActive = useBlueprint(reviewSurfaceIsOpen);
  const selectedReviewContainerId = useBlueprint((state) => {
    if (
      state.review === null
      || state.minimalCodebaseProjectionPending
      || (state.minimalView === "graph" && state.minimalLayoutStatus !== "ready")
      || state.moduleSelected.size !== 1
      || state.flowSelection !== null
      || state.syntheticExecutionStatus === "running"
    ) {
      return null;
    }
    const id = state.moduleSelected.values().next().value as string | undefined;
    const node = id === undefined ? undefined : state.index.nodesById.get(id);
    if (
      node === undefined
      || (node.kind !== "package" && node.kind !== "directory")
      || !state.index.isContainer(node.id)
      || state.reviewFocusedSubgraph?.rootId === node.id
    ) {
      return null;
    }
    const activeGroup = state.reviewActiveGroupId === null
      ? null
      : state.reviewGroups?.groups.find((group) => group.id === state.reviewActiveGroupId) ?? null;
    const groupFiles = activeGroup === null ? null : new Set(activeGroup.files);
    const hasChangedFile = state.reviewFiles.some((file) =>
      file.moduleId !== null
      && (groupFiles === null || groupFiles.has(file.path))
      && isReviewPathInScope(file.path, state.reviewPathScope)
      && state.index.isWithinFocus(node.id, file.moduleId),
    );
    return hasChangedFile ? node.id : null;
  });
  const minimalChanged = useBlueprint(
    (state) => state.minimalMemberIds.length > 0 && (!sameMembers(state.minimalMemberIds, state.minimalSeedIds)
      || state.minimalArrange
      || Object.keys(state.minimalRollups).some((id) => state.moduleExpanded.has(id))),
  );
  const {
    recenter,
    expandAll,
    collapseAll,
    buildMinimalGraph,
    backMinimalGraph,
    removeSelectionFromView,
    rearrangeMinimalGraph,
    resetMinimalGraph,
    closeMinimalGraph,
    openReviewSubgraph,
    toggleHighways,
  } = useBlueprintActions();
  const [anchorRef, surfaceSize] = useSurfaceSize();

  const showExtract = !emptyReview && selectedCount > 0
    && flowPaneLayoutStatus !== "laying-out"
    && syntheticExecutionStatus !== "running";
  const canExtract = showExtract
    && !minimalCodebaseProjectionPending
    && (!minimalOpen || minimalView === "codebase" || minimalLayoutStatus === "ready");
  const showSourceSelectionActions = showExtract && !minimalOpen;
  const codebaseView = minimalOpen && minimalView === "codebase";
  // Back is present at every extraction depth. A root graph also needs the wider nested-action
  // footprint whenever Extract (or the review-container equivalent) sits beside it.
  const wideMinimalActions = minimalHistory.length > 0
    || showExtract
    || (reviewActive && selectedReviewContainerId !== null);
  const mode: CanvasActionMode = codebaseView
    ? "codebase"
    : minimalOpen
      ? wideMinimalActions ? "review-focus" : "minimal"
      : showSourceSelectionActions ? "extract" : "base";
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
            disabled={emptyReview}
          />
          {codebaseView ? null : (
            <>
              <CanvasActionButton
                ariaLabel="Expand one level"
                title="Expand the selection one level, or the whole view when nothing is selected"
                icon={<ExpandIcon size={18} />}
                onClick={expandAll}
                disabled={emptyReview}
              />
              <CanvasActionButton
                ariaLabel="Collapse all"
                title="Collapse all open containers in the selection, or the whole view when nothing is selected"
                icon={<CollapseIcon size={18} />}
                onClick={collapseAll}
                disabled={emptyReview}
              />
              {minimalOpen ? (
                <CanvasActionButton
                  ariaLabel="Remove added nodes in selection"
                  title={
                    removableCount > 0
                      ? "Remove added nodes associated with the current selection from this view"
                      : "Select added nodes while keeping at least one member in the extracted graph"
                  }
                  icon={<RemoveSelectionIcon size={18} />}
                  onClick={removeSelectionFromView}
                  disabled={emptyReview || removableCount === 0}
                />
              ) : null}
            </>
          )}
        </CanvasActionGroup>
        {showSourceSelectionActions ? (
          <>
            <CanvasActionSeparator orientation={boundaryOrientation} />
            <CanvasActionGroup label="Selection actions">
              <CanvasActionButton
                primary
                badge={selectedCount}
                ariaLabel={`Extract selection (${selectedCount})`}
                title="Extract the current selection into a focused graph"
                icon={<ExtractSelectionIcon size={18} />}
                onClick={() => { void buildMinimalGraph(); }}
                disabled={!canExtract}
              />
              <CanvasActionButton
                ariaLabel="Remove added nodes in selection"
                title={
                  removableCount > 0
                    ? "Remove added nodes associated with the current selection from this view"
                    : "Only nodes added to this view can be removed"
                }
                icon={<RemoveSelectionIcon size={18} />}
                onClick={removeSelectionFromView}
                disabled={removableCount === 0}
              />
            </CanvasActionGroup>
          </>
        ) : null}
        {minimalOpen && !codebaseView ? (
          <>
            <CanvasActionSeparator orientation={boundaryOrientation} />
            <CanvasActionGroup label="Extracted graph actions">
              <CanvasActionButton
                primary
                ariaLabel="Back to previous graph"
                title={minimalHistory.length === 0
                  ? "Return to the source graph"
                  : `Return to ${minimalHistory.at(-1)?.label ?? "the previous graph"}`}
                icon={<BackToGraphIcon size={18} />}
                onClick={() => { void backMinimalGraph(); }}
              />
              {!reviewActive || selectedReviewContainerId === null ? null : (
                <CanvasActionButton
                  primary
                  ariaLabel="Open selected container as review subgraph"
                  title="Open the selected container's changed files in a separate review graph"
                  icon={<ExtractSelectionIcon size={18} />}
                  onClick={() => { void openReviewSubgraph(selectedReviewContainerId); }}
                />
              )}
              {!showExtract || selectedReviewContainerId !== null ? null : (
                <CanvasActionButton
                  primary
                  badge={selectedCount}
                  ariaLabel={`Extract selection (${selectedCount})`}
                  title="Extract the current selection into another focused graph"
                  icon={<ExtractSelectionIcon size={18} />}
                  onClick={() => { void buildMinimalGraph(); }}
                  disabled={!canExtract}
                />
              )}
              {onToggleGhostNodes === undefined ? null : (
                <CanvasActionButton
                  ariaLabel="Show ghost nodes"
                  title={
                    !hasGhostNodes
                      ? "No ghost nodes in this extracted graph"
                      : ghostNodesVisible
                        ? "Hide ghost nodes and their connections"
                        : "Show ghost nodes and their connections"
                  }
                  icon={<GhostVisibilityIcon size={18} visible={ghostNodesVisible} />}
                  onClick={onToggleGhostNodes}
                  disabled={emptyReview || !hasGhostNodes}
                  pressed={ghostNodesVisible}
                />
              )}
              <CanvasActionButton
                ariaLabel="Highways"
                title={showHighways
                  ? "Disable highways and draw node links individually"
                  : "Enable highways for dense edge traffic"}
                icon={<HighwaysIcon size={18} />}
                onClick={toggleHighways}
                pressed={showHighways}
                disabled={emptyReview}
              />
              {emptyReview || relationKinds === undefined ? null : <CanvasRelationFilter kinds={relationKinds} />}
              <CanvasActionButton
                ariaLabel="Rearrange extracted graph"
                title={
                  !minimalHasMembers
                    ? "No visible nodes to rearrange"
                    : minimalArranged
                    ? "Re-run the compact layout for the current extracted graph"
                    : "Lay out the current extracted graph compactly, ignoring its map positions"
                }
                icon={<RearrangeIcon size={18} />}
                onClick={rearrangeMinimalGraph}
                disabled={emptyReview || !minimalHasMembers}
              />
              <CanvasActionButton
                ariaLabel="Reset extracted graph"
                title={
                  minimalChanged
                    ? "Restore the original selection, collapsed rollups, and map positions"
                    : "Already matches the original selection, disclosure, and map positions"
                }
                icon={<ResetIcon size={18} />}
                onClick={resetMinimalGraph}
                disabled={emptyReview || !minimalChanged}
              />
              {onShowCodebase === undefined ? null : (
                <CanvasActionButton
                  ariaLabel="Highlight code in codebase"
                  title={preparedOverview
                    ? "Select a changed file before opening its codebase context"
                    : "Show this extracted graph highlighted in its whole-codebase context"}
                  icon={<CodebaseHighlightIcon size={18} />}
                  onClick={onShowCodebase}
                  buttonRef={codebaseButtonRef}
                  disabled={emptyReview || preparedOverview}
                />
              )}
              <CanvasActionSeparator orientation="vertical" />
              <CanvasActionButton
                ariaLabel="Close extracted graph"
                title="Close all extracted graphs and return to the source graph"
                icon={<CloseIcon size={18} />}
                onClick={closeMinimalGraph}
              />
            </CanvasActionGroup>
          </>
        ) : null}
        {codebaseView ? (
          <>
            <CanvasActionSeparator orientation={boundaryOrientation} />
            <CanvasActionGroup label="Codebase view actions">
              <CanvasActionButton
                primary
                ariaLabel="Back to previous graph"
                title={minimalHistory.length === 0
                  ? "Return to the source graph"
                  : `Return to ${minimalHistory.at(-1)?.label ?? "the previous graph"}`}
                icon={<BackToGraphIcon size={18} />}
                onClick={() => { void backMinimalGraph(); }}
              />
              {!reviewActive || selectedReviewContainerId === null ? null : (
                <CanvasActionButton
                  primary
                  ariaLabel="Open selected container as review subgraph"
                  title="Open the selected container's changed files in a separate review graph"
                  icon={<ExtractSelectionIcon size={18} />}
                  onClick={() => {
                    void openReviewSubgraph(selectedReviewContainerId);
                  }}
                />
              )}
              {!showExtract || selectedReviewContainerId !== null ? null : (
                <CanvasActionButton
                  primary
                  badge={selectedCount}
                  ariaLabel={`Extract selection (${selectedCount})`}
                  title="Extract the current selection into another focused graph"
                  icon={<ExtractSelectionIcon size={18} />}
                  onClick={() => {
                    void buildMinimalGraph();
                  }}
                  disabled={!canExtract}
                />
              )}
              <CanvasActionButton
                ariaLabel="Back to extracted graph"
                title="Return to the curated extracted graph"
                icon={<BackToGraphIcon size={18} />}
                onClick={() => onBackToGraph?.()}
                buttonRef={backButtonRef}
              />
              <CanvasActionButton
                ariaLabel="Close extracted graph"
                title="Close all extracted graphs and return to the source graph"
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
