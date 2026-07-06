/**
 * The per-node coverage chip shown in a node header while coverage mode is on: a verdict
 * glyph for leaves ("✓ tested" / "◑ reached" / "✗ untested"), a percentage for containers,
 * "TEST" for test code. Renders nothing outside coverage mode — the slot stays telemetry's.
 */

import { useBlueprint } from "../state/StoreContext";
import { COVERAGE_COLORS, coverageBadgeText, coverageVerdict } from "../theme/coverageColors";

export function CoverageBadge(props: { nodeId: string }) {
  const report = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  if (!report) {
    return null;
  }
  const text = coverageBadgeText(props.nodeId, report);
  if (!text) {
    return null;
  }
  const color = COVERAGE_COLORS[coverageVerdict(props.nodeId, report)];
  return <span style={badgeStyle(color)}>{text}</span>;
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: "inline-block",
    marginTop: 3,
    padding: "1px 6px",
    borderRadius: 4,
    border: `1px solid ${color}66`,
    background: `${color}1A`,
    color,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.3,
  };
}
