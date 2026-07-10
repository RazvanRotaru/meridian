/**
 * The PR-review side panel. Files first: every changed file with its touched code units and a
 * per-file "viewed" check (ReviewFilesSection — the panel's primary content), then the affected
 * logic flows (ReviewFlowsSection), and a footer that submits the draft comments as one GitHub
 * review. The header tracks viewed-files progress and offers Reset (ticks only — never drafts)
 * and Hide; a hidden panel gives the graph the full width, and MinimalGraphView's floating bar
 * grows a "Review" button to bring it back. Self-hides when there is no review.
 */

import { memo } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { fileViewState } from "../../derive/reviewFiles";
import type { ReviewData } from "../../derive/reviewData";
import { ReviewFilesSection } from "./ReviewFilesSection";
import { ReviewFlowsSection } from "./ReviewFlowsSection";
import { SubmitReviewFooter } from "./ReviewComments";
import { NO_FOCUS_RING } from "./reviewPanelKit";

function ReviewPanelImpl() {
  const review = useBlueprint((state) => state.review);
  const hidden = useBlueprint((state) => state.reviewPanelHidden);
  if (!review) {
    return null;
  }
  if (hidden) {
    return <CollapsedRail />;
  }
  return (
    <div style={PANEL}>
      <Header review={review} />
      <div style={SCROLL}>
        <ReviewFilesSection />
        <ReviewFlowsSection />
      </div>
      <SubmitReviewFooter />
    </div>
  );
}

/** The hidden panel folds to a slim rail in place — the reopen affordance stays exactly where the
 * panel was instead of popping up somewhere else. The whole rail is the button. */
function CollapsedRail() {
  const files = useBlueprint((state) => state.reviewFiles);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const { toggleReviewPanel } = useBlueprintActions();
  const viewed = files.filter((file) => fileViewState(file, unitTicks, fileTicks) === "done").length;
  return (
    <button type="button" style={RAIL} onClick={toggleReviewPanel} title="Show the review panel">
      <span style={RAIL_GLYPH}>«</span>
      <span style={RAIL_LABEL}>PR review</span>
      {files.length > 0 && <span style={RAIL_COUNT}>{viewed}/{files.length}</span>}
    </button>
  );
}

function Header({ review }: { review: ReviewData }) {
  const files = useBlueprint((state) => state.reviewFiles);
  const unitTicks = useBlueprint((state) => state.reviewUnitTicks);
  const fileTicks = useBlueprint((state) => state.reviewFileTicks);
  const { resetReviewTicks, toggleReviewPanel } = useBlueprintActions();
  const viewed = files.filter((file) => fileViewState(file, unitTicks, fileTicks) === "done").length;
  const total = files.length;
  const ctx = review.context;
  return (
    <div style={HEADER}>
      <div style={HEADER_TOP}>
        <span style={HEADER_TITLE}>PR review</span>
        <span style={{ flex: 1 }} />
        {total > 0 && (
          <button type="button" style={RESET_BTN} title="Clear every reviewed tick (drafts are kept)" onClick={resetReviewTicks}>
            Reset
          </button>
        )}
        <button type="button" style={HIDE_BTN} title="Hide the review panel" onClick={toggleReviewPanel}>
          »
        </button>
      </div>
      <div style={HEADER_REF}>
        <span style={REF_BRANCH}>{ctx.headRef ?? "working tree"}</span>
        <span style={REF_ARROW}>vs</span>
        <span style={REF_BASE}>{ctx.baseRef ?? "explicit files"}</span>
      </div>
      {total > 0 && (
        <div style={PROGRESS_ROW}>
          <div style={PROGRESS_TRACK}>
            <div style={{ ...PROGRESS_FILL, width: `${(viewed / total) * 100}%` }} />
          </div>
          <span style={PROGRESS_LABEL}>{viewed}/{total} files viewed</span>
        </div>
      )}
      {ctx.warnings.map((warning, index) => (
        <div key={index} style={WARNING}>{warning}</div>
      ))}
    </div>
  );
}

export const ReviewPanel = memo(ReviewPanelImpl);

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

const PANEL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: 380,
  height: "100%",
  background: "#0B0E13",
  borderLeft: "1px solid #20262F",
};
const HEADER: React.CSSProperties = { padding: "14px 16px 12px", borderBottom: "1px solid #20262F", display: "flex", flexDirection: "column", gap: 8 };
const HEADER_TOP: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const HEADER_TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "#E6EDF3" };
// One shared chip metric for BOTH header buttons — mismatched size/weight reads as a glitch.
const HEADER_BTN: React.CSSProperties = { border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 9px", fontSize: 11.5, fontWeight: 600, lineHeight: "15px", cursor: "pointer", font: "inherit", ...NO_FOCUS_RING };
const RESET_BTN: React.CSSProperties = { ...HEADER_BTN };
const HIDE_BTN: React.CSSProperties = { ...HEADER_BTN };
const RAIL: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  width: 30,
  height: "100%",
  padding: "12px 0",
  boxSizing: "border-box",
  border: "none",
  borderLeft: "1px solid #20262F",
  background: "#0B0E13",
  cursor: "pointer",
  font: "inherit",
  ...NO_FOCUS_RING,
};
const RAIL_GLYPH: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "#9AA4B2", lineHeight: 1 };
const RAIL_LABEL: React.CSSProperties = { writingMode: "vertical-rl", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: "#9AA4B2", textTransform: "uppercase" };
const RAIL_COUNT: React.CSSProperties = { fontSize: 9, fontWeight: 600, color: "#9AA4B2", background: "#1B212A", borderRadius: 8, padding: "3px 2px", writingMode: "vertical-rl" };
const HEADER_REF: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11 };
const REF_BRANCH: React.CSSProperties = { color: "#6BE38A" };
const REF_ARROW: React.CSSProperties = { color: "#5A6472" };
const REF_BASE: React.CSSProperties = { color: "#9AA4B2" };
const PROGRESS_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const PROGRESS_TRACK: React.CSSProperties = { flex: 1, height: 5, background: "#1B212A", borderRadius: 3, overflow: "hidden" };
const PROGRESS_FILL: React.CSSProperties = { height: "100%", background: "#3FB950", transition: "width 160ms ease" };
const PROGRESS_LABEL: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", whiteSpace: "nowrap" };
const WARNING: React.CSSProperties = { fontSize: 11, color: "#D29922", background: "rgba(210,153,34,0.1)", borderRadius: 5, padding: "4px 8px" };
const SCROLL: React.CSSProperties = { flex: 1, overflowY: "auto", padding: "8px 10px 24px" };
