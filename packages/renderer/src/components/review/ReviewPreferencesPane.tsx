/**
 * Inline preferences for the PR-review experience. The parent owns visibility and persistence;
 * this component is deliberately presentational so opening/closing it never disturbs review state.
 */

import type { CSSProperties } from "react";
import { STATIC_LOGIC_VIEW_MODES } from "../../derive/flowViewModel";
import type { ReviewCodePreviewTrigger, ReviewFlowSplitView } from "../../state/reviewPreferences";

const HEADING_ID = "review-preferences-heading";
const TEST_CHANGES_DESCRIPTION_ID = "review-test-changes-description";
const DIFF_ONLY_DESCRIPTION_ID = "review-diff-only-description";
const CODE_PREVIEW_DESCRIPTION_ID = "review-code-preview-description";
const PROJECTION_DESCRIPTION_ID = "review-flow-view-description";
const NOTE_ID = "review-preferences-storage-note";
const FLOW_VIEW_RADIO_NAME = "review-flow-split-view";
const CODE_PREVIEW_RADIO_NAME = "review-code-preview-trigger";

interface ReviewPreferencesPaneProps {
  excludeTestChanges: boolean;
  hideNodesNotInDiff: boolean;
  flowView: ReviewFlowSplitView;
  openFlowSplitOnSelect: boolean;
  codePreviewTrigger: ReviewCodePreviewTrigger;
  onExcludeTestChangesChange: (exclude: boolean) => void;
  onHideNodesNotInDiffChange: (hide: boolean) => void;
  onFlowViewChange: (view: ReviewFlowSplitView) => void;
  onOpenFlowSplitOnSelectChange: (open: boolean) => void;
  onCodePreviewTriggerChange: (trigger: ReviewCodePreviewTrigger) => void;
  onClose: () => void;
}

const OPTION_DETAILS: Record<ReviewFlowSplitView, {
  label: string;
  description: string;
  recommended?: boolean;
}> = {
  timeline: {
    label: "Timeline",
    description: "Follow calls in execution order, including awaited and background work.",
    recommended: true,
  },
  graph: {
    label: "Execution graph",
    description: "Explore the same flow as connected execution nodes and wires.",
  },
  metro: {
    label: "Metro",
    description: "Trace branches and hand-offs as a transit map.",
  },
  blocks: {
    label: "Blocks",
    description: "Read nested control structures as a structogram.",
  },
};

// Keep the recommended default first, then follow the canonical static Logic-view order. Deriving
// the list here means a future reusable projection cannot silently disappear from preferences.
const OPTIONS = [
  "timeline" as const,
  ...STATIC_LOGIC_VIEW_MODES
    .map(({ mode }) => mode)
    .filter((mode) => mode !== "timeline"),
].map((value) => ({ value, ...OPTION_DETAILS[value] }));

const CODE_PREVIEW_OPTIONS: Array<{
  value: ReviewCodePreviewTrigger;
  label: string;
  description: string;
}> = [
  { value: "hover", label: "On hover", description: "Open after pausing over a source-backed graph node." },
  { value: "click", label: "On click", description: "Open when a source-backed graph node is clicked; keep it open until another node or the canvas is clicked." },
];

export function ReviewPreferencesPane(props: ReviewPreferencesPaneProps) {
  return (
    <section id="review-preferences-pane" style={PANE} role="region" aria-labelledby={HEADING_ID}>
      <div style={HEADER}>
        <div style={HEADER_COPY}>
          <h2 id={HEADING_ID} style={HEADING}>Review preferences</h2>
          <p style={INTRO}>Choose how the review workspace presents supporting context.</p>
        </div>
        <button type="button" style={CLOSE_BUTTON} aria-label="Close review preferences" title="Close preferences" onClick={props.onClose}>
          ×
        </button>
      </div>

      <fieldset style={BEHAVIOR_FIELDSET} aria-describedby={TEST_CHANGES_DESCRIPTION_ID}>
        <legend style={LEGEND}>Review content</legend>
        <label style={optionStyle(props.excludeTestChanges)}>
          <input
            type="checkbox"
            checked={props.excludeTestChanges}
            style={RADIO}
            onChange={(event) => props.onExcludeTestChangesChange(event.currentTarget.checked)}
          />
          <span style={OPTION_COPY}>
            <span style={OPTION_TITLE}>Exclude test changes</span>
            <span id={TEST_CHANGES_DESCRIPTION_ID} style={OPTION_DESCRIPTION}>
              Remove test files, affected nodes, flows, and comments from this PR review. Drafts and viewed progress return when tests are included again.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset style={BEHAVIOR_FIELDSET} aria-describedby={DIFF_ONLY_DESCRIPTION_ID}>
        <legend style={LEGEND}>Graph display</legend>
        <label style={optionStyle(props.hideNodesNotInDiff)}>
          <input
            type="checkbox"
            checked={props.hideNodesNotInDiff}
            style={RADIO}
            aria-describedby={DIFF_ONLY_DESCRIPTION_ID}
            onChange={(event) => props.onHideNodesNotInDiffChange(event.currentTarget.checked)}
          />
          <span style={OPTION_COPY}>
            <span style={OPTION_TITLE}>Hide nodes not in diff</span>
            <span id={DIFF_ONLY_DESCRIPTION_ID} style={OPTION_DESCRIPTION}>
              Keep changed code and the file or package containers needed to place it. Hide unchanged context nodes and their incident edges.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset style={BEHAVIOR_FIELDSET} aria-describedby={`${CODE_PREVIEW_DESCRIPTION_ID} ${NOTE_ID}`}>
        <legend style={LEGEND}>Code preview behavior</legend>
        <p id={CODE_PREVIEW_DESCRIPTION_ID} style={DESCRIPTION}>Choose how graph node code previews open.</p>
        <div style={OPTION_LIST}>
          {CODE_PREVIEW_OPTIONS.map((option) => {
            const selected = props.codePreviewTrigger === option.value;
            return (
              <label key={option.value} style={optionStyle(selected)}>
                <input
                  type="radio"
                  name={CODE_PREVIEW_RADIO_NAME}
                  value={option.value}
                  checked={selected}
                  style={RADIO}
                  onChange={() => props.onCodePreviewTriggerChange(option.value)}
                />
                <span style={OPTION_COPY}>
                  <span style={OPTION_TITLE}>{option.label}</span>
                  <span style={OPTION_DESCRIPTION}>{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset style={BEHAVIOR_FIELDSET} aria-describedby={NOTE_ID}>
        <legend style={LEGEND}>Logic flow behavior</legend>
        <label style={optionStyle(props.openFlowSplitOnSelect)}>
          <input
            type="checkbox"
            checked={props.openFlowSplitOnSelect}
            style={RADIO}
            onChange={(event) => props.onOpenFlowSplitOnSelectChange(event.currentTarget.checked)}
          />
          <span style={OPTION_COPY}>
            <span style={OPTION_TITLE}>Open split view when selecting a logic flow</span>
            <span style={OPTION_DESCRIPTION}>When off, the flow stays highlighted in the review graph without opening the lower panel.</span>
          </span>
        </label>
      </fieldset>

      <fieldset style={FIELDSET} aria-describedby={`${PROJECTION_DESCRIPTION_ID} ${NOTE_ID}`}>
        <legend style={LEGEND}>Split view presentation</legend>
        <p id={PROJECTION_DESCRIPTION_ID} style={DESCRIPTION}>Choose what appears below the graph when the split view opens.</p>
        <div style={OPTION_LIST}>
          {OPTIONS.map((option) => {
            const selected = props.flowView === option.value;
            return (
              <label key={option.value} style={optionStyle(selected)}>
                <input
                  type="radio"
                  name={FLOW_VIEW_RADIO_NAME}
                  value={option.value}
                  checked={selected}
                  style={RADIO}
                  onChange={() => props.onFlowViewChange(option.value)}
                />
                <span style={OPTION_COPY}>
                  <span style={OPTION_TITLE_ROW}>
                    <span style={OPTION_TITLE}>{option.label}</span>
                    {option.recommended ? <span style={RECOMMENDED}>Recommended</span> : null}
                  </span>
                  <span style={OPTION_DESCRIPTION}>{option.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p id={NOTE_ID} style={NOTE}>
        Flow and code preview preferences are saved in this browser. Graph display and test visibility apply to the current PR review.
      </p>
    </section>
  );
}

const PANE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "14px 16px 15px",
  boxSizing: "border-box",
  borderBottom: "1px solid #20262F",
  background: "linear-gradient(180deg, #10141B 0%, #0D1117 100%)",
  color: "#D6DEE9",
};

const HEADER: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 };
const HEADER_COPY: CSSProperties = { flex: 1, minWidth: 0 };
const HEADING: CSSProperties = { margin: 0, color: "#E6EDF3", fontSize: 14, fontWeight: 700, lineHeight: 1.3 };
const INTRO: CSSProperties = { margin: "3px 0 0", color: "#7D8695", fontSize: 11, lineHeight: 1.45 };

const CLOSE_BUTTON: CSSProperties = {
  width: 24,
  height: 24,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #2A2F37",
  borderRadius: 6,
  background: "transparent",
  color: "#9AA4B2",
  cursor: "pointer",
  font: "inherit",
  fontSize: 16,
  lineHeight: 1,
};

const FIELDSET: CSSProperties = { minWidth: 0, margin: 0, padding: 0, border: "none" };
const BEHAVIOR_FIELDSET: CSSProperties = { ...FIELDSET, marginBottom: 14 };
const LEGEND: CSSProperties = {
  padding: 0,
  color: "#9AA4B2",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};
const DESCRIPTION: CSSProperties = { margin: "4px 0 9px", color: "#7D8695", fontSize: 10.5, lineHeight: 1.45 };
const OPTION_LIST: CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };

function optionStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "9px 10px",
    border: `1px solid ${selected ? "#39754A" : "#262D37"}`,
    borderRadius: 7,
    background: selected ? "rgba(86,194,113,0.10)" : "#121720",
    boxShadow: selected ? "inset 2px 0 0 #56C271" : "none",
    cursor: "pointer",
  };
}

const RADIO: CSSProperties = { width: 14, height: 14, margin: "2px 0 0", flexShrink: 0, accentColor: "#56C271", cursor: "pointer" };
const OPTION_COPY: CSSProperties = { display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 2 };
const OPTION_TITLE_ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 7, minWidth: 0 };
const OPTION_TITLE: CSSProperties = { color: "#E6EDF3", fontSize: 12, fontWeight: 650 };
const OPTION_DESCRIPTION: CSSProperties = { color: "#7D8695", fontSize: 10.5, lineHeight: 1.4 };
const RECOMMENDED: CSSProperties = {
  padding: "1px 5px",
  border: "1px solid #315D3D",
  borderRadius: 4,
  color: "#72D38A",
  background: "rgba(86,194,113,0.08)",
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};
const NOTE: CSSProperties = { margin: "10px 1px 0", color: "#7D8695", fontSize: 10, lineHeight: 1.45 };
