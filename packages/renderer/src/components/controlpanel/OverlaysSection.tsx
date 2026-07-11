/**
 * The OVERLAYS row: paint/lens switches (Tests, Reach, Private, Coverage, Flows) as unified pills.
 * Each pill is shown only where it means something for the active lens (e.g. Reach/Private only on
 * the module surface, Tests never in the Logic view), and carries its count where one exists.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintState } from "../../state/store";
import { moduleSurfaceSpec } from "../canvas/surfaceSpec";
import { COVERAGE_COLORS } from "../../theme/coverageColors";
import { Pill } from "./panelKit";

const REACH_HUE = "#5B9BE3";
const PRIVATE_HUE = "#7C8CA3";
const FLOWS_HUE = "#5B9BE3";
const HIGHWAYS_HUE = "#C99A4B";

export function OverlaysSection() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const showTests = useBlueprint((state) => state.showTests);
  const testCount = useBlueprint(countTestFiles);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const privateCount = useBlueprint((state) => state.index.privateIds.size);
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const coveragePercent = useBlueprint((state) => state.coverage?.summary.percent ?? null);
  const flowExplorerOpen = useBlueprint((state) => state.flowExplorerOpen);
  const showHighways = useBlueprint((state) => state.showHighways);
  const { toggleShowTests, toggleHighlightMode, togglePrivateMembers, toggleCoverageMode, toggleFlowExplorer, toggleHighways } = useBlueprintActions();

  const onModuleSurface = moduleSurfaceSpec(viewMode) !== null;
  const onMap = viewMode === "modules";
  const noTests = testCount === 0;
  const noPrivate = privateCount === 0;

  return (
    <div style={ROW_STYLE} role="group" aria-label="Overlays">
      {viewMode !== "logic" ? (
        <Pill
          active={showTests && !noTests}
          accent={COVERAGE_COLORS.covered}
          indicator="square"
          badge={testCount}
          disabled={noTests}
          title={noTests ? "No test files in this graph" : showTests ? "Hide test files" : "Show test files"}
          onClick={toggleShowTests}
        >
          Tests
        </Pill>
      ) : null}
      {onModuleSurface ? (
        <Pill
          active={highlightMode === "reach"}
          accent={REACH_HUE}
          indicator="square"
          title={highlightMode === "reach" ? "Reach mode: selection lights radius-based paths" : "Node mode: selection lights only incident wires"}
          onClick={toggleHighlightMode}
        >
          Reach
        </Pill>
      ) : null}
      {onModuleSurface ? (
        <Pill
          active={showPrivate && !noPrivate}
          accent={PRIVATE_HUE}
          indicator="square"
          badge={privateCount}
          disabled={noPrivate}
          title={noPrivate ? "Nothing is tagged private" : showPrivate ? "Hide private members" : "Show private members"}
          onClick={togglePrivateMembers}
        >
          Private
        </Pill>
      ) : null}
      {onMap ? (
        <Pill
          active={showHighways}
          accent={HIGHWAYS_HUE}
          indicator="square"
          title={showHighways ? "Highways on: cross-package edges merge into bundles (select a node to read its own links)" : "Highways off: draw every edge individually"}
          onClick={toggleHighways}
        >
          Highways
        </Pill>
      ) : null}
      <Pill
        active={coverageMode}
        accent={COVERAGE_COLORS.covered}
        indicator="square"
        badge={coverageMode && coveragePercent !== null ? `${coveragePercent}%` : undefined}
        title={coverageMode ? "Leave coverage mode" : "Color the graph by static test coverage"}
        onClick={toggleCoverageMode}
      >
        Coverage
      </Pill>
      {viewMode !== "logic" ? (
        <Pill
          active={flowExplorerOpen}
          accent={FLOWS_HUE}
          indicator="square"
          title={flowExplorerOpen ? "Close the flow explorer" : "Open the flow explorer"}
          onClick={toggleFlowExplorer}
        >
          Flows
        </Pill>
      ) : null}
    </div>
  );
}

function countTestFiles(state: BlueprintState): number {
  let count = 0;
  for (const id of state.index.testIds) {
    if (state.index.nodesById.get(id)?.kind === "module") {
      count += 1;
    }
  }
  return count;
}

const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
