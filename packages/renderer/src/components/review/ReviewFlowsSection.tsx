/**
 * The pinned "Affected logic flows" section of the review panel. It deliberately includes directly
 * changed flow roots as well as callers into changed code: the prepared HEAD/merge-base comparison
 * can therefore expose a newly chartable flow with a NEW badge. Selecting a row highlights it in
 * the upper graph; the explicit View flow action opens the sequence presentation below regardless
 * of the reader's automatic-open preference.
 */

import { memo, useMemo, useState } from "react";
import type { ChangeGroup } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { affectedFlowTouchesIds, tickStateOf, type AffectedFlowRow } from "../../derive/reviewData";
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
  const prSelected = useBlueprint((state) => state.prSelected);
  const preparedHeadCurrent = useBlueprint((state) => state.prPreparedArtifactCurrent);
  const activeGroup = useActiveChangeGroup();
  const [open, setOpen] = useState(true);
  const allAffected = useMemo(
    () => visibleAffectedFlows(review?.rows ?? [], prSelected === null || preparedHeadCurrent),
    [preparedHeadCurrent, prSelected, review],
  );
  // An isolated change group scopes the affected list to its own flows; a flow crossing groups
  // appears in every group it touches, marked with the "spans groups" chip.
  const rows = useMemo(() => {
    let scoped = allAffected;
    if (activeGroup !== null) {
      const member = new Set(activeGroup.flowIds);
      scoped = scoped.filter((row) => affectedFlowTouchesIds(row, member));
    }
    if (pathScope !== null) {
      scoped = scoped.filter((row) => affectedFlowFiles(row).some((file) => isReviewPathInScope(file, pathScope)));
    }
    if (focusedSubgraphPaths !== null) {
      const member = new Set(focusedSubgraphPaths);
      scoped = scoped.filter((row) => affectedFlowFiles(row).some((file) => member.has(file)));
    }
    // NEW is the highest-signal PR finding. Stable sort keeps core's file/line order inside the
    // new and existing partitions while making newly chartable behavior immediately discoverable.
    return scoped
      .map((row, order) => ({ row, order }))
      .sort((left, right) => Number(right.row.flowChange === "new") - Number(left.row.flowChange === "new") || left.order - right.order)
      .map(({ row }) => row);
  }, [allAffected, activeGroup, focusedSubgraphPaths, pathScope]);
  const crossGroup = useMemo(() => new Set(reviewGroups?.crossGroupFlowIds ?? []), [reviewGroups]);
  if (!review || allAffected.length === 0) {
    return null;
  }
  const done = rows.filter((row) => tickStateOf(row, ticks) === "done").length;
  const newCount = rows.filter((row) => row.flowChange === "new").length;
  return (
    <section style={SECTION}>
      <button type="button" style={SECTION_HEAD} onClick={() => setOpen((value) => !value)}>
        <span style={CARET}>{open ? "▾" : "▸"}</span>
        <span style={SECTION_TITLE}>Affected logic flows</span>
        <span style={SECTION_COUNT}>{done}/{rows.length}</span>
        {newCount > 0 ? <span style={SECTION_NEW_COUNT}>{newCount} new</span> : null}
        <span style={SECTION_HINT}>changed or reaches changed code</span>
      </button>
      {open && (
        <div style={FLOW_LIST} role="region" aria-label="Affected logic flows list">
          {rows.length === 0
            ? <div style={EMPTY_NOTE}>No affected flows in this review scope.</div>
            : rows.map((row) => (
              <FlowRow
                key={row.flow.flowId}
                row={row}
                ticks={ticks}
                spansGroups={affectedFlowTouchesIds(row, crossGroup)
                  || affectedFlowGroupCount(row, reviewGroups?.groups ?? []) > 1}
              />
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
  const preferredFlowView = useBlueprint((state) => state.reviewFlowSplitView);
  const openFlowSplitOnSelect = useBlueprint((state) => state.reviewOpenFlowSplitOnSelect);
  const explicitFlowView = useBlueprint((state) => state.reviewFlowExplicitView);
  const {
    toggleReviewTick,
    setReviewLit,
    selectFlowEntry,
    openReviewFlow,
    requestSyntheticEditor,
  } = useBlueprintActions();
  const tick = tickStateOf(row, ticks);
  const ref = useMemo(() => ({ rootId: row.flow.flowId, blockPath: [] }), [row.flow.flowId]);
  // A nested block selection still belongs to this flow. Keep its owning row active, and let the
  // row's toggle close the whole inspection rather than pretending the split collapsed.
  const selected = flowSelection !== null && row.memberFlowIds.includes(flowSelection.rootId);
  const splitEnabled = openFlowSplitOnSelect || (selected && explicitFlowView !== null);
  const splitOpen = selected && splitEnabled;
  const actionTitle = selected
    ? splitOpen ? "Close logic flow review" : "Clear logic flow highlight"
    : splitEnabled ? "Review this logic flow below the graph" : "Highlight this logic flow in the graph";
  const disclosureGlyph = splitEnabled ? selected ? "▾" : "▸" : selected ? "•" : "";
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
          aria-expanded={splitEnabled ? selected : undefined}
          aria-controls={splitEnabled ? REVIEW_FLOW_SPLIT_ID : undefined}
          onClick={() => {
            setReviewLit(null);
            selectFlowEntry(selected ? null : ref);
          }}
        >
          <span style={CARET} aria-hidden="true">{disclosureGlyph}</span>
          <span style={ROW_NAME} title={row.displayName}>{row.displayName}</span>
          {row.flowChange === "new" && <span style={NEW_CHIP} title="This logic flow is present in the PR head but not its merge base">NEW</span>}
          {spansGroups && <span style={SPANS_CHIP} title="this flow touches multiple change groups">spans groups</span>}
          {row.isTest && <span style={TEST_CHIP}>test</span>}
          <span style={ROW_LOC}>{row.file ? `${basename(row.file)}:${row.startLine}` : "—"}</span>
        </button>
        <button
          type="button"
          style={VIEW_FLOW_BUTTON}
          aria-label={`View sequence for ${row.displayName}`}
          title="Open this logic flow as a sequence diagram"
          aria-controls={REVIEW_FLOW_SPLIT_ID}
          onClick={(event) => {
            event.stopPropagation();
            setReviewLit(null);
            openReviewFlow(ref, "timeline");
          }}
        >
          View flow
        </button>
        <button
          type="button"
          style={SYNTHETIC_RUN_BUTTON}
          aria-label={`Generate synthetic data for ${row.displayName}`}
          title="Generate synthetic data"
          aria-controls={REVIEW_FLOW_SPLIT_ID}
          onClick={(event) => {
            event.stopPropagation();
            setReviewLit(null);
            openReviewFlow(ref, explicitFlowView ?? preferredFlowView);
            requestSyntheticEditor(ref.rootId, "flow-pane");
          }}
        >
          <span aria-hidden="true">ƒ</span>
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

/** Files that make an affected row relevant to the current review scope. Direct owner changes often
 * have no `changedFilesHit`, so the owner file must participate in the same filter as call hits. */
export function affectedFlowFiles(row: AffectedFlowRow): string[] {
  const files = row.memberEvidence.flatMap((member) => member.flow.ownerChanged && member.flow.ownerFile !== null
    ? [member.flow.ownerFile, ...member.flow.changedFilesHit]
    : [...member.flow.changedFilesHit]);
  return [...new Set(files)];
}

/** Number of independently isolated review groups containing at least one story member. */
export function affectedFlowGroupCount(row: AffectedFlowRow, groups: readonly ChangeGroup[]): number {
  return groups.filter((group) => affectedFlowTouchesIds(row, new Set(group.flowIds))).length;
}

/** Direct changed roots are only safe to open when the active graph is the PR HEAD (or the review
 * came from an already-extracted review artifact). Base-only synchronous reviews keep the useful
 * caller impact rows, but never present stale base behavior as the PR's changed flow. */
export function visibleAffectedFlows(rows: AffectedFlowRow[], headAccurate: boolean): AffectedFlowRow[] {
  return headAccurate ? rows : rows.filter((row) => row.group === "impacted");
}

const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column", width: "100%", height: "100%", boxSizing: "border-box", minHeight: 0, overflow: "hidden", padding: "4px 10px 8px", background: "#0B0E13" };
const SECTION_HINT: React.CSSProperties = { marginLeft: "auto", fontSize: 10, color: "#5A6472", whiteSpace: "nowrap" };
const SECTION_NEW_COUNT: React.CSSProperties = { fontSize: 9, fontWeight: 750, color: "#65D58A", border: "1px solid #315B3C", borderRadius: 999, padding: "0 5px", whiteSpace: "nowrap" };
const FLOW_LIST: React.CSSProperties = { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", paddingRight: 2 };
const ROW: React.CSSProperties = { borderRadius: 7, padding: "2px 4px", marginBottom: 2 };
const ROW_SELECTED: React.CSSProperties = { ...ROW, background: "rgba(86,194,113,0.12)", boxShadow: "inset 2px 0 0 #56C271" };
const ROW_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "4px 2px", textAlign: "left", ...NO_FOCUS_RING };
const ROW_NAME: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
const VIEW_FLOW_BUTTON: React.CSSProperties = { flexShrink: 0, border: "1px solid #34577D", borderRadius: 5, background: "rgba(59,122,192,0.12)", color: "#9BC6F5", padding: "3px 6px", fontFamily: MONO, fontSize: 8.5, cursor: "pointer", whiteSpace: "nowrap" };
const SYNTHETIC_RUN_BUTTON: React.CSSProperties = { flexShrink: 0, width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid #315B50", borderRadius: 5, background: "rgba(88,201,163,0.09)", color: "#78D8B7", padding: 0, fontFamily: MONO, fontSize: 10, cursor: "pointer" };
const NEW_CHIP: React.CSSProperties = { fontSize: 8.5, fontWeight: 800, letterSpacing: "0.04em", color: "#65D58A", border: "1px solid #315B3C", borderRadius: 4, background: "rgba(63,185,80,0.1)", padding: "0 4px", flexShrink: 0 };
const SPANS_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#E6C07A", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 4px", flexShrink: 0 };
const HITS: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px 4px 26px" };
const HIT_CHIP: React.CSSProperties = { fontSize: 9.5, color: "#E6C07A", background: "rgba(210,153,34,0.1)", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 5px", fontFamily: MONO };
