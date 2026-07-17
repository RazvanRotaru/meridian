/**
 * The coverage side panel (top-right, coverage mode only). Runtime artifacts show their measured
 * repository totals. Artifacts without counters retain the static graph heuristic as an explicitly
 * labelled reachability estimate and navigator.
 */

import { Panel } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { coverageRows, type CoverageRow } from "../derive/coverageRows";
import type { RendererReachabilityReport } from "../derive/reachabilityFacts";
import {
  runtimeCoverageSummary,
  type RuntimeCoverageMetric,
  type RuntimeCoverageSummary,
} from "../derive/runtimeCoverageSummary";
import { COVERAGE_COLORS } from "../theme/coverageColors";
import { COVERAGE_PANEL_WIDTH } from "./canvas/panelLayout";

export function CoveragePanel() {
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const report = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const runtimeCoverage = useBlueprint((state) => runtimeCoverageSummary(state.artifact));
  const rows = report && runtimeCoverage === null
    ? coverageRows(report)
    : [];
  if (!coverageMode || (runtimeCoverage === null && report === null)) {
    return null;
  }
  return (
    <Panel position="top-right">
      <div style={PANEL_STYLE}>
        {runtimeCoverage ? (
          <RuntimeSummary summary={runtimeCoverage} />
        ) : report ? (
          <>
            <ReachabilitySummary report={report} />
            <ReachabilityLegend />
            {report.summary.testNodes === 0 ? <NoTests /> : <Rows rows={rows} />}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function RuntimeSummary(props: { summary: RuntimeCoverageSummary }) {
  return (
    <div>
      <div style={TITLE_STYLE}>Runtime coverage</div>
      <div style={METRICS_STYLE}>
        <RuntimeMetric label="Functions" metric={props.summary.functions} />
        <RuntimeMetric label="Branch paths" metric={props.summary.branchPaths} />
      </div>
      <div style={MUTED_STYLE}>Aggregate counters from the test run attached to this graph.</div>
    </div>
  );
}

function RuntimeMetric(props: { label: string; metric: RuntimeCoverageMetric }) {
  const percent = props.metric.percent;
  return (
    <div style={METRIC_STYLE}>
      <span>{props.label}</span>
      <span style={METRIC_VALUE_STYLE}>
        <span style={{ color: percent === null ? COVERAGE_COLORS.none : percentColor(percent), fontSize: 16 }}>
          {percent === null ? "—" : `${percent}%`}
        </span>
        <span style={MUTED_STYLE}>{props.metric.hit}/{props.metric.total} hit</span>
      </span>
    </div>
  );
}

function ReachabilitySummary(props: { report: Pick<RendererReachabilityReport, "summary"> }) {
  const { summary } = props.report;
  return (
    <div>
      <div style={TITLE_STYLE}>
        Estimated test reachability <span style={{ color: percentColor(summary.percent), fontSize: 16 }}>{summary.percent}%</span>
      </div>
      <div style={MUTED_STYLE}>
        {summary.covered} direct + {summary.indirect} indirect of {summary.callables} callables ·{" "}
        {summary.uncovered} not reached
      </div>
      {summary.unresolvedFromTests > 0 ? (
        <div style={CAVEAT_STYLE}>
          ⚠ {summary.unresolvedFromTests} unresolved call(s) leave test code — actual reachability may be higher.
        </div>
      ) : null}
    </div>
  );
}

function ReachabilityLegend() {
  return (
    <div style={LEGEND_STYLE}>
      <LegendItem color={COVERAGE_COLORS.covered} label="directly reachable" />
      <LegendItem color={COVERAGE_COLORS.indirect} label="indirectly reachable" />
      <LegendItem color={COVERAGE_COLORS.uncovered} label="not reached" />
      <LegendItem color={COVERAGE_COLORS.test} label="test code" />
    </div>
  );
}

function LegendItem(props: { color: string; label: string }) {
  return (
    <span style={LEGEND_ITEM_STYLE}>
      <span style={{ ...SWATCH_STYLE, background: props.color }} />
      {props.label}
    </span>
  );
}

function NoTests() {
  return (
    <div style={MUTED_STYLE}>
      No test code was discovered in this graph. Check that the project&apos;s tests are inside its
      workspace packages.
    </div>
  );
}

function Rows(props: { rows: readonly CoverageRow[] }) {
  return (
    <div style={ROWS_STYLE}>
      {props.rows.map((row) => (
        <ContainerRow key={row.id} row={row} />
      ))}
    </div>
  );
}

function ContainerRow(props: { row: CoverageRow }) {
  const actions = useBlueprintActions();
  const viewMode = useBlueprint((state) => state.viewMode);
  const parentOf = useBlueprint((state) => state.index.parentOf);
  const go = (nodeId: string) => navigate(nodeId, viewMode, parentOf, actions);
  const { row } = props;
  return (
    <div style={ROW_STYLE}>
      <button type="button" style={ROW_HEAD_STYLE} onClick={() => go(row.id)}>
        <span style={{ color: percentColor(row.percent), fontVariantNumeric: "tabular-nums" }}>
          {String(row.percent).padStart(3, " ")}%
        </span>
        <span style={ROW_NAME_STYLE}>{row.name}</span>
        <span style={MUTED_STYLE}>
          {row.covered}/{row.total}
        </span>
      </button>
      {row.uncoveredMembers.map((member) => (
        <button
          key={member.id}
          type="button"
          style={MEMBER_STYLE}
          title={member.reason}
          onClick={() => go(member.id)}
        >
          ✗ {member.name} <span style={REASON_STYLE}>— {member.reason}</span>
        </button>
      ))}
    </div>
  );
}

// Clicking a row navigates the ACTIVE surface to the node through the shared per-lens reveal
// (revealInView: the Map/UI lenses refocus at the definition, the Service lens pins + selects).
// The Service lens ALSO roots the composition side panel at the owning unit, so the scorecards
// follow the click (a method row highlights its parent unit).
function navigate(
  nodeId: string,
  viewMode: string,
  parentOf: ReadonlyMap<string, string | null>,
  actions: { revealInView(id: string): void; selectCompUnit(id: string | null): void },
): void {
  if (viewMode === "call") {
    actions.selectCompUnit(unitIdFor(nodeId, parentOf));
  }
  actions.revealInView(nodeId);
}

// A composition unit is a class/module; a method row's unit is its nearest such ancestor. Walk up
// until an ancestor is a plausible unit (has its own parent chain end), defaulting to the node itself.
function unitIdFor(nodeId: string, parentOf: ReadonlyMap<string, string | null>): string {
  const parent = parentOf.get(nodeId);
  // Methods hang off a class; functions hang off a module. Either parent IS the composition unit.
  return parent ?? nodeId;
}

function percentColor(percent: number): string {
  return percent >= 75 ? COVERAGE_COLORS.covered : percent >= 40 ? COVERAGE_COLORS.indirect : COVERAGE_COLORS.uncovered;
}

const PANEL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  gap: 10,
  padding: 12,
  borderRadius: 10,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.94)",
  backdropFilter: "blur(6px)",
  width: COVERAGE_PANEL_WIDTH,
  maxHeight: "70vh",
  overflowY: "auto",
  color: "#E6EDF3",
};
const TITLE_STYLE: React.CSSProperties = { fontSize: 14, fontWeight: 600, display: "flex", gap: 8, alignItems: "baseline" };
const METRICS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, margin: "8px 0 6px" };
const METRIC_STYLE: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, fontSize: 12 };
const METRIC_VALUE_STYLE: React.CSSProperties = { display: "inline-flex", alignItems: "baseline", gap: 7, fontVariantNumeric: "tabular-nums" };
const MUTED_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2" };
const CAVEAT_STYLE: React.CSSProperties = { fontSize: 11, color: COVERAGE_COLORS.indirect, marginTop: 4 };
const LEGEND_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "4px 12px" };
const LEGEND_ITEM_STYLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#9AA4B2" };
const SWATCH_STYLE: React.CSSProperties = { width: 8, height: 8, borderRadius: 2, display: "inline-block" };
const ROWS_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const ROW_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const ROW_HEAD_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  border: "none",
  background: "transparent",
  color: "#E6EDF3",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  padding: "2px 0",
  cursor: "pointer",
  textAlign: "left",
};
const ROW_NAME_STYLE: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const MEMBER_STYLE: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: COVERAGE_COLORS.uncovered,
  font: "inherit",
  fontSize: 11,
  padding: "1px 0 1px 14px",
  cursor: "pointer",
  textAlign: "left",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const REASON_STYLE: React.CSSProperties = { color: "#9AA4B2" };
