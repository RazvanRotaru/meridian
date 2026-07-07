/**
 * One ranked flow in the PR-review list: a reviewed checkbox, the callable's name and defining
 * file, why it qualifies (changed / calls-into badges), its size, and a jump into the Logic
 * lens. The whole row TOGGLES selection of the flow (a second click on the selected row clears it)
 * and highlights it on the graph pane; hovering only highlights, never moves the camera.
 */

import type { RankedReviewFlow, ReviewReason } from "../derive/reviewFlows";
import { useBlueprintActions } from "../state/StoreContext";
import { reasonBackground, reasonColor, REVIEW_COLORS } from "../theme/reviewColors";
import { callsIntoLabel, middleTruncate } from "./reviewListText";

const PATH_MAX_LENGTH = 46;

export function ReviewFlowRow(props: { flow: RankedReviewFlow; reviewed: boolean; selected: boolean }) {
  const { flow, reviewed, selected } = props;
  const { toggleReviewed, selectReviewFlow, setReviewHoverFlow, openInLogicFlow } = useBlueprintActions();

  return (
    <div
      style={rowStyle(selected, reviewed)}
      onClick={() => selectReviewFlow(selected ? null : flow.rootId)}
      onMouseEnter={() => setReviewHoverFlow(flow.rootId)}
      onMouseLeave={() => setReviewHoverFlow(null)}
    >
      <input
        type="checkbox"
        checked={reviewed}
        aria-label={`Mark ${flow.displayName} reviewed`}
        style={CHECKBOX_STYLE}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          event.stopPropagation();
          toggleReviewed(flow.rootId);
        }}
      />
      <div style={MAIN_COL_STYLE}>
        <div style={TOP_LINE_STYLE}>
          <span style={NAME_STYLE} title={flow.rootId}>
            {flow.displayName}
          </span>
          <span style={METRICS_STYLE}>
            {flow.stepCount} steps · {flow.branchCount} branches
          </span>
        </div>
        <div style={PATH_STYLE} title={flow.file}>
          {middleTruncate(flow.file, PATH_MAX_LENGTH)}
        </div>
        <div style={BOTTOM_ROW_STYLE}>
          <div style={BADGE_ROW_STYLE}>
            {flow.reasons.map((reason) => (
              <ReasonBadge key={reason} reason={reason} callsIntoFiles={flow.callsIntoFiles} />
            ))}
          </div>
          <button
            type="button"
            style={OPEN_BUTTON_STYLE}
            onClick={(event) => {
              event.stopPropagation();
              openInLogicFlow(flow.rootId);
            }}
          >
            Open in Logic flow
          </button>
        </div>
      </div>
    </div>
  );
}

function ReasonBadge(props: { reason: ReviewReason; callsIntoFiles: string[] }) {
  const { reason, callsIntoFiles } = props;
  const label = reason === "changed" ? "changed" : callsIntoLabel(callsIntoFiles);
  return (
    <span style={{ ...BADGE_STYLE, color: reasonColor(reason), background: reasonBackground(reason) }}>{label}</span>
  );
}

function rowStyle(selected: boolean, reviewed: boolean): React.CSSProperties {
  return {
    display: "flex",
    gap: 8,
    padding: "8px 10px 8px 8px",
    borderRadius: 6,
    cursor: "pointer",
    opacity: reviewed ? 0.6 : 1,
    borderLeft: selected ? `3px solid ${REVIEW_COLORS.selection}` : "3px solid transparent",
    background: selected ? "rgba(107,227,138,0.08)" : "transparent",
  };
}

const CHECKBOX_STYLE: React.CSSProperties = { marginTop: 3, accentColor: REVIEW_COLORS.reviewed, colorScheme: "dark" };
const MAIN_COL_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 };
const TOP_LINE_STYLE: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
const NAME_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const METRICS_STYLE: React.CSSProperties = { flexShrink: 0, fontSize: 10.5, color: "#7B8695", whiteSpace: "nowrap" };
const PATH_STYLE: React.CSSProperties = { fontSize: 11, color: "#6C7683", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const BOTTOM_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const BADGE_ROW_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5 };
const BADGE_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 7px",
  borderRadius: 10,
  whiteSpace: "nowrap",
};
const OPEN_BUTTON_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "transparent",
  color: "#7B8695",
  border: "none",
  fontSize: 10.5,
  cursor: "pointer",
  padding: "2px 4px",
  font: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};
