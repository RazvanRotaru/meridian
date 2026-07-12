/** Read-only status chrome for the minimal graph's codebase-context projection. */

import type { MinimalCodebaseContext } from "../derive/minimalCodebaseContext";
import { CHROME_EDGE } from "./canvas/flowCanvasProps";
import { CONTROL_PANEL_WIDTH } from "./controlpanel/panelKit";

type ContextStatus = "laying-out" | "ready" | "error";

export function MinimalCodebaseSummary({
  context,
  status,
  targetCount,
  highlightedCount,
}: {
  context: MinimalCodebaseContext | null;
  status: ContextStatus;
  targetCount: number;
  highlightedCount: number;
}) {
  const unresolved = context?.unresolvedTargetIds.size ?? 0;
  return (
    <section style={SUMMARY_STYLE} aria-label="Codebase context summary">
      <span style={SUMMARY_TITLE}>Codebase context</span>
      <span style={READ_ONLY_BADGE}>READ-ONLY</span>
      <span style={SUMMARY_COPY}>
        {status === "error"
          ? "Could not lay out this overview"
          : context === null
            ? `No extracted code could be located · ${targetCount} unavailable`
            : `${highlightedCount} graph node${highlightedCount === 1 ? "" : "s"} highlighted`}
        {context !== null && unresolved > 0 ? ` · ${unresolved} unavailable` : ""}
      </span>
    </section>
  );
}

export function EmptyMinimalCodebaseContext() {
  return (
    <div role="status" style={EMPTY_STYLE}>
      This extracted graph has no code nodes that can be placed in the repository map.
    </div>
  );
}

const SUMMARY_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 6,
  display: "flex",
  flexDirection: "row",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  width: "max-content",
  maxWidth: `min(280px, max(144px, calc(100% - ${CHROME_EDGE + CONTROL_PANEL_WIDTH + 32}px)))`,
  overflow: "hidden",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
};
const SUMMARY_TITLE: React.CSSProperties = { color: "#E6EDF3", fontSize: 12, fontWeight: 700 };
const READ_ONLY_BADGE: React.CSSProperties = {
  color: "#8FB6E3",
  border: "1px solid #365A7A",
  borderRadius: 4,
  padding: "1px 4px",
  fontSize: 8,
  fontWeight: 800,
  letterSpacing: "0.06em",
};
const SUMMARY_COPY: React.CSSProperties = { flexBasis: "100%", color: "#9AA4B2", fontSize: 11 };
const EMPTY_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: "50% auto auto 50%",
  zIndex: 5,
  transform: "translate(-50%, -50%)",
  maxWidth: 360,
  padding: "14px 16px",
  border: "1px dashed #365A7A",
  borderRadius: 8,
  background: "rgba(18,23,30,0.94)",
  color: "#9AA4B2",
  fontSize: 12,
  lineHeight: 1.45,
  textAlign: "center",
};
