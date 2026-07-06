/**
 * The "Coverage" mode switch. Entering coverage mode computes the static coverage report
 * (once — the artifact is immutable after boot), recolors every node by verdict, and opens
 * the coverage panel. The layout itself never changes: coverage is a lens, not a filter.
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { COVERAGE_COLORS } from "../theme/coverageColors";

export function CoverageToggle() {
  const coverageMode = useBlueprint((state) => state.coverageMode);
  const percent = useBlueprint((state) => state.coverage?.summary.percent ?? null);
  const toggleCoverageMode = useBlueprintActions().toggleCoverageMode;
  return (
    <button
      type="button"
      style={toggleStyle(coverageMode)}
      aria-pressed={coverageMode}
      title={coverageMode ? "Leave coverage mode" : "Color the graph by static test coverage"}
      onClick={toggleCoverageMode}
    >
      ▦ Coverage
      {coverageMode && percent !== null ? <span style={percentStyle(percent)}>{percent}%</span> : null}
    </button>
  );
}

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${active ? `${COVERAGE_COLORS.covered}66` : "#2A2F37"}`,
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "#0E1116",
    color: active ? "#E6EDF3" : "#9AA4B2",
  };
}

function percentStyle(percent: number): React.CSSProperties {
  const color =
    percent >= 75 ? COVERAGE_COLORS.covered : percent >= 40 ? COVERAGE_COLORS.indirect : COVERAGE_COLORS.uncovered;
  return { color, fontWeight: 700 };
}
