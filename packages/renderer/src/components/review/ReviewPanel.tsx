/**
 * The PR-review side panel. Files first: every changed file with its touched code units and a
 * per-file "viewed" check (ReviewFilesSection — the panel's primary content). Change groups and
 * impacted logic flows stay pinned above that file scroller, and a footer submits the draft
 * comments as one GitHub review. The header tracks viewed-files progress, states the review's provenance (which graph,
 * which code), offers the fallback review's opt-in "Extract head graph", and Reset (ticks only —
 * never drafts) and Hide; a hidden panel folds into a narrow reopen rail. Self-hides when there
 * is no review.
 */

import { memo } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { countViewedFiles } from "../../derive/reviewFiles";
import type { ReviewData } from "../../derive/reviewData";
import { PrPrepareInline } from "../prs/PrPrepareProgress";
import { ChangeGroupStrip } from "./ChangeGroupStrip";
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
      <ChangeGroupStrip />
      <ReviewFlowsSection />
      <div style={SCROLL}>
        <ReviewFilesSection />
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
  const viewed = countViewedFiles(files, unitTicks, fileTicks);
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
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const preparedArtifactCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const preparing = useBlueprint((state) => state.prReviewStatus === "preparing");
  const canExtract = useBlueprint((state) => state.prReviewed !== null
    && !state.prPreparedArtifactCurrent
    && state.prPreparedGraphId === null
    && state.analyzeUrl !== null);
  const { resetReviewTicks, toggleReviewPanel, prepareHeadGraph } = useBlueprintActions();
  const viewed = countViewedFiles(files, unitTicks, fileTicks);
  const total = files.length;
  const addedUnmatched = files.filter((file) => file.status === "added" && file.moduleId === null).length;
  const ctx = review.context;
  return (
    <div style={HEADER}>
      <div style={HEADER_TOP}>
        <span style={HEADER_TITLE}>PR review</span>
        <span style={{ flex: 1 }} />
        {preparing ? <PrPrepareInline /> : canExtract && (
          <button
            type="button"
            style={EXTRACT_BTN}
            title="Clone the PR head and rebuild the graph from it — added files join the graph, deleted files leave it"
            onClick={() => void prepareHeadGraph()}
          >
            Extract head graph
          </button>
        )}
        {total > 0 && (
          <button type="button" style={RESET_BTN} title="Clear every reviewed tick (drafts are kept)" onClick={resetReviewTicks}>
            Reset
          </button>
        )}
        <button type="button" style={HIDE_BTN} title="Hide the review panel" onClick={toggleReviewPanel}>
          »
        </button>
      </div>
      {prReviewed !== null ? <PrProvenance ctx={ctx} /> : (
        <div style={HEADER_REF}>
          <span style={REF_BRANCH}>{ctx.headRef ?? "working tree"}</span>
          <span style={REF_ARROW}>vs</span>
          <span style={REF_BASE}>{ctx.baseRef ?? "explicit files"}</span>
        </div>
      )}
      {prReviewed !== null && !preparedArtifactCurrent && addedUnmatched > 0 && (
        <div style={ADDED_FILES_NOTE}>
          {addedUnmatched === 1
            ? "1 added file isn't in the base graph — Extract head graph to review it"
            : `${addedUnmatched} added files aren't in the base graph — Extract head graph to review them`}
        </div>
      )}
      {prReviewed !== null && <ExtractFailedWarning />}
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

/** The GitHub-PR provenance line: which graph the review computes on, and which code it shows —
 * sync mode reviews the boot (base-branch) graph with head-fetched code; after head extraction
 * the graph itself IS the PR head, pinned to the analyzed commit. */
function PrProvenance({ ctx }: { ctx: ReviewData["context"] }) {
  const headSha = useBlueprint((state) => state.prPreparedHeadSha);
  const swapped = useBlueprint((state) => state.prPreparedArtifactCurrent);
  // Real spaces live in the text nodes (not flex gaps) so the line's DOM text reads exactly
  // "<head> → <base> · <mode>" — greppable, copyable, e2e-assertable.
  return (
    <div style={PROVENANCE}>
      <span style={REF_BRANCH}>{ctx.headRef ?? "head"}</span>
      <span style={REF_ARROW}>{" → "}</span>
      <span style={REF_BASE}>{ctx.baseRef ?? "base"}</span>
      <span style={REF_BASE}>{swapped ? ` · head graph @${(headSha ?? "").slice(0, 7)}` : " · base graph + head code"}</span>
    </div>
  );
}

/** A failed head extraction leaves the sync review untouched; this amber line says so, carries the
 * server's short reason, and dismisses via the prepare-error lane. */
function ExtractFailedWarning() {
  const error = useBlueprint((state) => state.prPrepareError);
  const { dismissPrepareError } = useBlueprintActions();
  if (error === null) {
    return null;
  }
  return (
    <div style={EXTRACT_WARNING}>
      <span style={{ flex: 1 }}>
        Head extraction failed — still reviewing on the base graph. <span style={EXTRACT_WARNING_DETAIL}>{error}</span>
      </span>
      <button type="button" style={WARNING_DISMISS} title="Dismiss" onClick={dismissPrepareError}>
        ×
      </button>
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
const HEADER_BTN: React.CSSProperties = { font: "inherit", border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "3px 9px", fontSize: 11.5, fontWeight: 600, lineHeight: "15px", cursor: "pointer", ...NO_FOCUS_RING };
const RESET_BTN: React.CSSProperties = { ...HEADER_BTN };
const HIDE_BTN: React.CSSProperties = { ...HEADER_BTN };
const EXTRACT_BTN: React.CSSProperties = { ...HEADER_BTN };
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
// The PR provenance line flows inline (its spaces are text, not gaps) — see PrProvenance.
const PROVENANCE: React.CSSProperties = { fontFamily: MONO, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const REF_BRANCH: React.CSSProperties = { color: "#6BE38A" };
const REF_ARROW: React.CSSProperties = { color: "#5A6472" };
const REF_BASE: React.CSSProperties = { color: "#9AA4B2" };
const ADDED_FILES_NOTE: React.CSSProperties = { fontSize: 11, color: "#7D8695" };
const PROGRESS_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const PROGRESS_TRACK: React.CSSProperties = { flex: 1, height: 5, background: "#1B212A", borderRadius: 3, overflow: "hidden" };
const PROGRESS_FILL: React.CSSProperties = { height: "100%", background: "#3FB950", transition: "width 160ms ease" };
const PROGRESS_LABEL: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", whiteSpace: "nowrap" };
const WARNING: React.CSSProperties = { fontSize: 11, color: "#D29922", background: "rgba(210,153,34,0.1)", borderRadius: 5, padding: "4px 8px" };
const EXTRACT_WARNING: React.CSSProperties = { ...WARNING, display: "flex", alignItems: "flex-start", gap: 6 };
const EXTRACT_WARNING_DETAIL: React.CSSProperties = { color: "#9A7B2D" };
const WARNING_DISMISS: React.CSSProperties = { font: "inherit", border: "none", background: "transparent", color: "#D29922", cursor: "pointer", padding: 0, lineHeight: "14px", fontSize: 13, ...NO_FOCUS_RING };
const SCROLL: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px 24px" };
