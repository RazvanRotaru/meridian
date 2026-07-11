/**
 * The OVERLAYS row: paint/lens switches (Tests, Reach, Private, Coverage) as unified pills.
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
const GHOST_GROUP_HUE = "#8C83D9";
const HIGHWAYS_HUE = "#E8843C"; // orange — arterial/high-traffic edges; the one bold warm accent (diff amber is reserved)
const COMMONS_HUE = "#B08F4E"; // the dock tray's quiet amber (a shelf, not an alert)

export function OverlaysSection() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const showTests = useBlueprint((state) => state.showTests);
  const testCount = useBlueprint(countTestFiles);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const privateCount = useBlueprint((state) => state.index.privateIds.size);
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const coveragePercent = useBlueprint((state) => state.coverage?.summary.percent ?? null);
  const showHighways = useBlueprint((state) => state.showHighways);
  const showCommons = useBlueprint((state) => state.showCommons);
  const groupGhostsByParent = useBlueprint((state) => state.groupGhostsByParent);
  const { toggleShowTests, toggleHighlightMode, togglePrivateMembers, toggleCoverageMode, toggleHighways, toggleCommons, toggleGhostGrouping } = useBlueprintActions();

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
      {onModuleSurface ? (
        <Pill
          active={groupGhostsByParent}
          accent={GHOST_GROUP_HUE}
          indicator="square"
          title={groupGhostsByParent ? "Ghost grouping on: 4+ related siblings collapse under their parent" : "Ghost grouping off: show every exact related ghost"}
          onClick={toggleGhostGrouping}
        >
          Ghost groups
        </Pill>
      ) : null}
      {onMap ? (
        <Pill
          active={showHighways}
          accent={HIGHWAYS_HUE}
          indicator="square"
          title={showHighways ? "Highways on: cross-container edges merge into bundles (select a node to read its own links)" : "Highways off: draw every edge individually"}
          onClick={toggleHighways}
        >
          Highways
        </Pill>
      ) : null}
      {onMap ? (
        <Pill
          active={showCommons}
          accent={COMMONS_HUE}
          indicator="square"
          title={showCommons ? "Commons on: the level's utility hubs park in the dock below the graph (their wires hide until selected)" : "Commons off: utility hubs stay in the graph with all their wires"}
          onClick={toggleCommons}
        >
          Commons
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
