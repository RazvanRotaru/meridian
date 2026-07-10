/**
 * The "Logic flows" section of the review panel: every flow the change touches, grouped into
 * "Changed" (the flow's own code was edited) and "Impacted" (it calls into changed code), each
 * preserving core's sort. A flow expands in place to its FlowStepTree so the reader sees its
 * control structure and the exact calls into changed blocks. A per-flow tick (todo / done /
 * stale) persists under the reviewKey. Hovering a flow lights its owner + changed call targets
 * on the graph; clicking a changed call selects that block. Secondary to the files checklist —
 * the whole section collapses behind its header.
 */

import { memo, useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { tickStateOf, type AffectedFlowRow, type ReviewData } from "../../derive/reviewData";
import { FlowStepTree } from "./FlowStepTree";
import { basename, CARET, EMPTY_NOTE, MONO, SECTION_COUNT, SECTION_HEAD, SECTION_TITLE, TEST_CHIP, TICK_BTN, TICK_COLOR, TICK_GLYPH } from "./reviewPanelKit";
import type { ReviewTick } from "../../state/reviewTicksPref";
import type { GraphIndex } from "../../graph/graphIndex";
import type { FlowStep } from "@meridian/core";

function ReviewFlowsSectionImpl() {
  const review = useBlueprint((state) => state.review);
  const ticks = useBlueprint((state) => state.reviewTicks);
  const affectedIds = useBlueprint((state) => state.reviewAffectedIds);
  const index = useBlueprint((state) => state.index);
  const [open, setOpen] = useState(true);
  if (!review) {
    return null;
  }
  const done = review.rows.filter((row) => tickStateOf(row, ticks) === "done").length;
  return (
    <section style={SECTION}>
      <button type="button" style={SECTION_HEAD} onClick={() => setOpen((value) => !value)}>
        <span style={CARET}>{open ? "▾" : "▸"}</span>
        <span style={SECTION_TITLE}>Logic flows</span>
        <span style={SECTION_COUNT}>{done}/{review.rows.length}</span>
      </button>
      {open && review.rows.length === 0 && (
        // The analysis ran and found nothing — say so, or its absence reads as a silent failure.
        <div style={EMPTY_NOTE}>No logic flows touch this change.</div>
      )}
      {open && (
        <>
          <FlowGroup title="Changed" hint="the flow's own code was edited" rows={review.rows.filter((r) => r.group === "changed")} review={review} affectedIds={affectedIds} index={index} ticks={ticks} />
          <FlowGroup title="Impacted" hint="calls into changed code" rows={review.rows.filter((r) => r.group === "impacted")} review={review} affectedIds={affectedIds} index={index} ticks={ticks} />
        </>
      )}
    </section>
  );
}

function FlowGroup(props: {
  title: string;
  hint: string;
  rows: AffectedFlowRow[];
  review: ReviewData;
  affectedIds: ReadonlySet<string>;
  index: GraphIndex;
  ticks: Record<string, ReviewTick>;
}) {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <div style={GROUP}>
      <div style={GROUP_HEAD}>
        <span style={GROUP_TITLE}>{props.title}</span>
        <span style={SECTION_COUNT}>{props.rows.length}</span>
        <span style={GROUP_HINT}>{props.hint}</span>
      </div>
      {props.rows.map((row) => (
        <FlowRow key={row.flow.flowId} row={row} review={props.review} affectedIds={props.affectedIds} index={props.index} ticks={props.ticks} />
      ))}
    </div>
  );
}

function FlowRow(props: {
  row: AffectedFlowRow;
  review: ReviewData;
  affectedIds: ReadonlySet<string>;
  index: GraphIndex;
  ticks: Record<string, ReviewTick>;
}) {
  const { row, review, affectedIds, index, ticks } = props;
  const [open, setOpen] = useState(false);
  const { toggleReviewTick, setReviewLit, selectReviewNode } = useBlueprintActions();
  const selected = useBlueprint((state) => state.reviewSelectedId === row.flow.flowId);
  const tick = tickStateOf(row, ticks);
  const steps = review.flows[row.flow.flowId] ?? [];
  // The blocks this flow lights on the graph; empty ⇒ null so nothing dims (the flow owns no visible block).
  const litSet = useMemo(() => {
    const set = flowLitSet(row, steps, affectedIds);
    return set.size > 0 ? set : null;
  }, [row, steps, affectedIds]);
  const resolveName = (id: string) => index.nodesById.get(id)?.displayName ?? id;
  return (
    <div
      style={selected ? ROW_SELECTED : ROW}
      onMouseEnter={() => setReviewLit(litSet)}
      onMouseLeave={() => setReviewLit(null)}
    >
      <div style={ROW_HEAD}>
        <button type="button" style={{ ...TICK_BTN, color: TICK_COLOR[tick] }} title={tick} onClick={(e) => { e.stopPropagation(); toggleReviewTick(row.flow.flowId); }}>
          {TICK_GLYPH[tick]}
        </button>
        <button type="button" style={ROW_MAIN} onClick={() => { setOpen((v) => !v); selectReviewNode(row.flow.flowId); setReviewLit(litSet); }}>
          <span style={CARET}>{open ? "▾" : "▸"}</span>
          <span style={ROW_NAME} title={row.displayName}>{row.displayName}</span>
          {/* A flow whose OWN block overlaps a hunk is on the graph — the node-level "edited" mark that
              distinguishes a directly-changed flow from one merely sharing a touched file. */}
          {affectedIds.has(row.flow.flowId) && <span style={EDITED_CHIP} title="this block is on the graph">edited</span>}
          {row.isTest && <span style={TEST_CHIP}>test</span>}
          <span style={ROW_LOC}>{row.file ? `${basename(row.file)}:${row.startLine}` : "—"}</span>
        </button>
      </div>
      {row.group === "impacted" && row.flow.changedFilesHit.length > 0 && (
        <div style={HITS}>
          {row.flow.changedFilesHit.map((file) => (
            <span key={file} style={HIT_CHIP} title={file}>{basename(file)}</span>
          ))}
        </div>
      )}
      {open && (
        <div style={TREE_WRAP}>
          <FlowStepTree steps={steps} affectedIds={affectedIds} resolveName={resolveName} onHoverNode={(id) => setReviewLit(id === null ? litSet : new Set([id]))} onSelectNode={(id) => selectReviewNode(id)} />
        </div>
      )}
    </div>
  );
}

/** The graph nodes a flow lights: its own owner block plus every changed call target inside it. */
function flowLitSet(row: AffectedFlowRow, steps: readonly FlowStep[], affectedIds: ReadonlySet<string>): Set<string> {
  const lit = new Set<string>();
  if (affectedIds.has(row.flow.flowId)) {
    lit.add(row.flow.flowId);
  }
  const stack: FlowStep[] = [...steps];
  let step: FlowStep | undefined;
  while ((step = stack.pop()) !== undefined) {
    if (step.kind === "call") {
      if (step.target !== null && affectedIds.has(step.target)) {
        lit.add(step.target);
      }
    } else if (step.kind === "loop" || step.kind === "callback") {
      stack.push(...step.body);
    } else if (step.kind === "branch") {
      for (const path of step.paths) {
        stack.push(...path.body);
      }
    }
  }
  return lit;
}

export const ReviewFlowsSection = memo(ReviewFlowsSectionImpl);

const SECTION: React.CSSProperties = { marginTop: 12, borderTop: "1px solid #1B212A", paddingTop: 6 };
const GROUP: React.CSSProperties = { marginTop: 4 };
const GROUP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "4px 6px 2px 20px" };
const GROUP_TITLE: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: "#7D8695", textTransform: "uppercase", letterSpacing: 0.4 };
const GROUP_HINT: React.CSSProperties = { fontSize: 10.5, color: "#5A6472", fontStyle: "italic" };
const ROW: React.CSSProperties = { borderRadius: 7, border: "1px solid transparent", padding: "2px 4px", marginBottom: 2 };
const ROW_SELECTED: React.CSSProperties = { ...ROW, borderColor: "#2E3A4D", background: "rgba(46,58,77,0.25)" };
const ROW_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "4px 2px", textAlign: "left" };
const ROW_NAME: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
const EDITED_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#6BE38A", border: "1px solid #2E5A3A", borderRadius: 4, padding: "0 4px", flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 };
const HITS: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px 4px 26px" };
const HIT_CHIP: React.CSSProperties = { fontSize: 9.5, color: "#E6C07A", background: "rgba(210,153,34,0.1)", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 5px", fontFamily: MONO };
const TREE_WRAP: React.CSSProperties = { padding: "4px 6px 8px 22px" };
