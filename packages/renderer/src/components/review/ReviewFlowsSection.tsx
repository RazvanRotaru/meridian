/**
 * The pinned "Impacted logic flows" section of the review panel. Directly changed flows are already
 * represented by their changed file/code-block rows and by the review graph, so this list contains
 * only flows that call into changed code. Selecting a row highlights and reveals the flow in the
 * upper graph; the reader's review preference decides whether its reusable Logic pane also opens
 * below. The capped row list scrolls independently so it and Change groups stay visible above the
 * primary changed-files scroller.
 */

import { memo, useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { tickStateOf, type AffectedFlowRow } from "../../derive/reviewData";
import { useActiveChangeGroup } from "./ChangeGroupStrip";
import { basename, CARET, EMPTY_NOTE, MONO, NO_FOCUS_RING, SECTION_COUNT, SECTION_HEAD, SECTION_TITLE, TEST_CHIP, TICK_BTN, TICK_COLOR, TICK_GLYPH } from "./reviewPanelKit";
import type { ReviewTick } from "../../state/reviewTicksPref";
import { REVIEW_FLOW_SPLIT_ID } from "../flowexplorer/flowSelection";
import { isReviewPathInScope } from "../../derive/reviewPathScope";

function ReviewFlowsSectionImpl() {
  const review = useBlueprint((state) => state.review);
  const ticks = useBlueprint((state) => state.reviewTicks);
  const reviewGroups = useBlueprint((state) => state.reviewGroups);
  const pathScope = useBlueprint((state) => state.reviewPathScope);
  const focusedSubgraphPaths = useBlueprint((state) => state.reviewFocusedSubgraph?.filePaths ?? null);
  const activeGroup = useActiveChangeGroup();
  const [open, setOpen] = useState(true);
  const allImpacted = useMemo(() => review?.rows.filter((row) => row.group === "impacted") ?? [], [review]);
  // An isolated change group scopes the impacted list to its own flows; a flow crossing groups
  // appears in every group it touches, marked with the "spans groups" chip.
  const rows = useMemo(() => {
    let scoped = allImpacted;
    if (activeGroup !== null) {
      const member = new Set(activeGroup.flowIds);
      scoped = scoped.filter((row) => member.has(row.flow.flowId));
    }
    if (pathScope !== null) {
      scoped = scoped.filter((row) => row.flow.changedFilesHit.some((file) => isReviewPathInScope(file, pathScope)));
    }
    if (focusedSubgraphPaths !== null) {
      const member = new Set(focusedSubgraphPaths);
      scoped = scoped.filter((row) => row.flow.changedFilesHit.some((file) => member.has(file)));
    }
    return scoped;
  }, [allImpacted, activeGroup, focusedSubgraphPaths, pathScope]);
  const crossGroup = useMemo(() => new Set(reviewGroups?.crossGroupFlowIds ?? []), [reviewGroups]);
  if (!review || allImpacted.length === 0) {
    return null;
  }
  const done = rows.filter((row) => tickStateOf(row, ticks) === "done").length;
  return (
    <section style={SECTION}>
      <button type="button" style={SECTION_HEAD} onClick={() => setOpen((value) => !value)}>
        <span style={CARET}>{open ? "▾" : "▸"}</span>
        <span style={SECTION_TITLE}>Impacted logic flows</span>
        <span style={SECTION_COUNT}>{done}/{rows.length}</span>
        <span style={SECTION_HINT}>calls into changed code</span>
      </button>
      {open && (
        <div style={FLOW_LIST} role="region" aria-label="Impacted logic flows list">
          {rows.length === 0
            ? <div style={EMPTY_NOTE}>No impacted flows in this review scope.</div>
            : rows.map((row) => (
              <FlowRow key={row.flow.flowId} row={row} ticks={ticks} spansGroups={crossGroup.has(row.flow.flowId)} />
            ))}
        </div>
      )}
    </section>
  );
}

function FlowRow(props: {
  row: AffectedFlowRow;
  ticks: Record<string, ReviewTick>;
  spansGroups: boolean;
}) {
  const { row, ticks, spansGroups } = props;
  const flowSelection = useBlueprint((state) => state.flowSelection);
  const openFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const { toggleReviewTick, setReviewLit, selectFlowEntry } = useBlueprintActions();
  const tick = tickStateOf(row, ticks);
  const ref = useMemo(() => ({ rootId: row.flow.flowId, blockPath: [] }), [row.flow.flowId]);
  // A nested block selection still belongs to this flow. Keep its owning row active, and let the
  // row's toggle close the whole inspection rather than pretending the split collapsed.
  const selected = flowSelection?.rootId === ref.rootId;
  const splitOpen = selected && openFlowSplitOnSelect;
  const actionTitle = selected
    ? splitOpen ? "Close logic flow review" : "Clear logic flow highlight"
    : openFlowSplitOnSelect ? "Review this logic flow below the graph" : "Highlight this logic flow in the graph";
  const disclosureGlyph = openFlowSplitOnSelect ? selected ? "▾" : "▸" : selected ? "•" : "";
  return (
    <div style={selected ? ROW_SELECTED : ROW}>
      <div style={ROW_HEAD}>
        <button type="button" style={{ ...TICK_BTN, color: TICK_COLOR[tick] }} title={tick} onClick={(e) => { e.stopPropagation(); toggleReviewTick(row.flow.flowId); }}>
          {TICK_GLYPH[tick]}
        </button>
        <button
          type="button"
          style={ROW_MAIN}
          title={actionTitle}
          aria-pressed={selected}
          aria-expanded={openFlowSplitOnSelect ? selected : undefined}
          aria-controls={openFlowSplitOnSelect ? REVIEW_FLOW_SPLIT_ID : undefined}
          onClick={() => {
            setReviewLit(null);
            selectFlowEntry(selected ? null : ref);
          }}
        >
          <span style={CARET} aria-hidden="true">{disclosureGlyph}</span>
          <span style={ROW_NAME} title={row.displayName}>{row.displayName}</span>
          {spansGroups && <span style={SPANS_CHIP} title="this flow touches multiple change groups">spans groups</span>}
          {row.isTest && <span style={TEST_CHIP}>test</span>}
          <span style={ROW_LOC}>{row.file ? `${basename(row.file)}:${row.startLine}` : "—"}</span>
        </button>
      </div>
      {row.flow.changedFilesHit.length > 0 && (
        <div style={HITS}>
          {row.flow.changedFilesHit.map((file) => (
            <span key={file} style={HIT_CHIP} title={file}>{basename(file)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export const ReviewFlowsSection = memo(ReviewFlowsSectionImpl);

const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", boxSizing: "border-box", maxHeight: "min(180px, 24%)", minHeight: 0, flexShrink: 1, overflow: "hidden", padding: "4px 10px 8px", borderBottom: "1px solid #20262F", background: "#0B0E13" };
const SECTION_HINT: React.CSSProperties = { marginLeft: "auto", fontSize: 10, color: "#5A6472", whiteSpace: "nowrap" };
const FLOW_LIST: React.CSSProperties = { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2 };
const ROW: React.CSSProperties = { borderRadius: 7, padding: "2px 4px", marginBottom: 2 };
const ROW_SELECTED: React.CSSProperties = { ...ROW, background: "rgba(86,194,113,0.12)", boxShadow: "inset 2px 0 0 #56C271" };
const ROW_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "4px 2px", textAlign: "left", ...NO_FOCUS_RING };
const ROW_NAME: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
const SPANS_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#E6C07A", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 4px", flexShrink: 0 };
const HITS: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px 4px 26px" };
const HIT_CHIP: React.CSSProperties = { fontSize: 9.5, color: "#E6C07A", background: "rgba(210,153,34,0.1)", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 5px", fontFamily: MONO };
