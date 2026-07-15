/**
 * The OVERLAYS row: paint/lens switches (Tests, Reach, Private, Telemetry, Coverage) as unified pills.
 * Each pill is shown only where it means something for the active lens (e.g. Reach/Private only on
 * the module surface, Tests never in the Logic view), and carries its count where one exists.
 */

import { EXTERNAL_CONTAINER_ID, type CoverageSummary } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintState } from "../../state/store";
import { moduleSurfaceSpec } from "../canvas/surfaceSpec";
import { COVERAGE_COLORS } from "../../theme/coverageColors";
import { accentForKind } from "../../theme/kindColors";
import { matchAffectedFiles } from "../../derive/matchAffectedFiles";
import { isReviewTestPath } from "../../derive/reviewFiles";
import { runtimeCoverageSummary, type RuntimeCoverageMetric } from "../../derive/runtimeCoverageSummary";
import { Pill } from "./panelKit";

const REACH_HUE = "#5B9BE3";
const PRIVATE_HUE = "#7C8CA3";
const GHOST_GROUP_HUE = "#8C83D9";
const HIGHWAYS_HUE = "#E8843C"; // orange — arterial/high-traffic edges; the one bold warm accent (diff amber is reserved)
const COMMONS_HUE = "#B08F4E"; // the dock tray's quiet amber (a shelf, not an alert)
const TELEMETRY_HUE = "#58C9A3";

export function OverlaysSection() {
  const viewMode = useBlueprint((state) => state.viewMode);
  const showTests = useBlueprint((state) => state.showTests);
  const testCount = useBlueprint(countTestFiles);
  const highlightMode = useBlueprint((state) => state.highlightMode);
  const showPrivate = useBlueprint((state) => state.showPrivate);
  const privateCount = useBlueprint((state) => state.index.privateIds.size);
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const reachability = useBlueprint((state) => state.coverage?.summary ?? null);
  const runtimeCoverage = useBlueprint((state) => runtimeCoverageSummary(state.artifact));
  const telemetryMode = useBlueprint((state) => state.telemetryMode);
  const telemetryAvailable = useBlueprint((state) => (
    state.hasOverlay || state.provider !== null || state.telemetrySources.length > 0
  ));
  const showHighways = useBlueprint((state) => state.showHighways);
  const showCommons = useBlueprint((state) => state.showCommons);
  const showExternalGhosts = useBlueprint((state) => state.showExternalGhosts);
  const hasExternalGhosts = useBlueprint(hasExternalDependencies);
  const groupGhostsByParent = useBlueprint((state) => state.groupGhostsByParent);
  const { toggleShowTests, toggleHighlightMode, togglePrivateMembers, toggleCoverageMode, toggleTelemetryMode, toggleHighways, toggleCommons, toggleExternalGhosts, toggleGhostGrouping } = useBlueprintActions();

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
          active={showExternalGhosts && hasExternalGhosts}
          accent={accentForKind("external")}
          indicator="square"
          disabled={!hasExternalGhosts}
          title={!hasExternalGhosts ? "No external package ghosts in this graph" : showExternalGhosts ? "Hide external package ghosts" : "Show external package ghosts"}
          onClick={toggleExternalGhosts}
        >
          External packages
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
      {telemetryAvailable ? (
        <Pill
          active={telemetryMode}
          accent={TELEMETRY_HUE}
          indicator="square"
          title={telemetryMode ? "Leave telemetry mode" : "Show request telemetry controls and runtime evidence"}
          onClick={toggleTelemetryMode}
        >
          Telemetry
        </Pill>
      ) : null}
      <Pill
        active={coverageMode}
        accent={COVERAGE_COLORS.covered}
        indicator="square"
        badge={coverageMode ? coverageBadge(runtimeCoverage, reachability?.percent ?? null) : undefined}
        title={coverageTitle(coverageMode, runtimeCoverage, reachability)}
        onClick={toggleCoverageMode}
      >
        {runtimeCoverage ? "Coverage" : "Reachability"}
      </Pill>
    </div>
  );
}

function coverageBadge(
  runtime: ReturnType<typeof runtimeCoverageSummary>,
  reachabilityPercent: number | null,
): string | undefined {
  if (runtime) {
    return `F ${metricPercent(runtime.functions)} · B ${metricPercent(runtime.branchPaths)}`;
  }
  return reachabilityPercent === null ? undefined : `${reachabilityPercent}%`;
}

function coverageTitle(
  active: boolean,
  runtime: ReturnType<typeof runtimeCoverageSummary>,
  reachability: CoverageSummary | null,
): string {
  const action = active ? "Leave" : "Show";
  if (runtime) {
    return `${action} runtime coverage · Functions: ${metricDescription(runtime.functions)} · Branch paths: ${metricDescription(runtime.branchPaths)}`;
  }
  if (reachability) {
    const reached = reachability.covered + reachability.indirect;
    return `${action} estimated test reachability · ${reached}/${reachability.callables} callables reachable (${reachability.percent}%)`;
  }
  return `${action} estimated test reachability from the static call graph`;
}

function metricPercent(metric: RuntimeCoverageMetric): string {
  return metric.percent === null ? "—" : `${metric.percent}%`;
}

function metricDescription(metric: RuntimeCoverageMetric): string {
  const percent = metric.percent === null ? "no items" : `${metric.percent}%`;
  return `${metric.hit}/${metric.total} hit (${percent})`;
}

export function countTestFiles(state: BlueprintState): number {
  const paths = new Set<string>();
  const addIndexTests = (index: BlueprintState["index"]) => {
    for (const id of index.testIds) {
      const node = index.nodesById.get(id);
      if (node?.kind === "module") {
        paths.add(node.location.file);
      }
    }
  };
  addIndexTests(state.index);
  const addReviewTestPath = (path: string) => {
    if (!isReviewTestPath(path, state.index, state.prReviewComparison?.index ?? null)) {
      return;
    }
    const activeMatch = matchAffectedFiles(state.index, [path]).matched[0];
    const moduleId = activeMatch?.moduleId;
    const graphPath = moduleId === undefined
      ? null
      : state.index.nodesById.get(moduleId)?.location.file ?? null;
    paths.add(graphPath ?? path);
  };
  // A PR can add its first test file, so it has no module in the base graph yet. Keep the toggle
  // available from the PR detail/review surfaces by also classifying the raw changed-file paths.
  if (state.viewMode === "prs" || state.prReviewed !== null) {
    for (const file of state.prFiles ?? []) {
      addReviewTestPath(file.path);
    }
  }
  // Artifact-carried reviews have no prFiles payload. Their raw context is intentionally retained
  // by the projection so an added/unmatched test row can still make this restore toggle available.
  for (const file of state.review?.context.changedFiles ?? []) {
    addReviewTestPath(file.path);
  }
  return paths.size;
}

function hasExternalDependencies(state: BlueprintState): boolean {
  return state.index.childrenByParent
    .get(EXTERNAL_CONTAINER_ID)
    ?.some((node) => node.id.startsWith("ext:")) ?? false;
}

const ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 7 };
