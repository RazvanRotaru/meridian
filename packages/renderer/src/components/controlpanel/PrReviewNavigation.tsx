/** Minimal navigation kept over the graph during a PR review. The right review panel already owns
 * PR identity, branch, progress, files, and comments; this control carries only repository context
 * and the one action that panel cannot perform: choosing a different pull request. */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { PullRequestIcon } from "./icons";
import { TOKENS } from "./panelKit";

const ACTIVE_HUE = "#388BFD";

export function PrReviewNavigation() {
  const targetName = useBlueprint((state) => state.artifact.target.name);
  const { togglePrsView } = useBlueprintActions();
  return (
    <nav style={NAV_STYLE} aria-label="Pull request review navigation">
      <div style={REPOSITORY_STYLE} title={targetName}>
        <span style={DOT_STYLE} />
        <span style={REPOSITORY_NAME_STYLE}>{targetName}</span>
      </div>
      <button
        type="button"
        style={CHOOSE_STYLE}
        title="Return to the pull request list"
        onClick={togglePrsView}
      >
        <span style={ICON_STYLE}><PullRequestIcon size={15} /></span>
        <span>Choose another PR</span>
        <span style={{ flex: 1 }} />
        <span aria-hidden="true">→</span>
      </button>
    </nav>
  );
}

const NAV_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: 236,
  boxSizing: "border-box",
  padding: 8,
  borderRadius: 12,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(10,13,18,0.94)",
  backdropFilter: "blur(8px)",
};
const REPOSITORY_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  padding: "5px 8px",
  color: TOKENS.textMuted,
};
const DOT_STYLE: React.CSSProperties = { width: 7, height: 7, borderRadius: 999, background: "#5B9BE3", flexShrink: 0 };
const REPOSITORY_NAME_STYLE: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 };
const CHOOSE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 9px",
  border: `1px solid ${ACTIVE_HUE}`,
  borderRadius: 8,
  background: "rgba(56,139,253,0.08)",
  color: "#CDE3FF",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 650,
};
const ICON_STYLE: React.CSSProperties = { display: "inline-flex", color: ACTIVE_HUE };
