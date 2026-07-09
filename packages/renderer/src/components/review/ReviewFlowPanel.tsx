/**
 * The PR-review side panel: every logic flow the change touches, grouped and hierarchical.
 *
 * Two groups — "Changed flows" (the flow's own code was edited) and "Impacted flows" (it calls into
 * changed code) — each preserving core's sort. A flow expands in place to its FlowStepTree, so the
 * reader sees the flow's control structure and the exact calls into changed blocks without leaving
 * the page. A per-flow tick (todo / done / stale) persists to localStorage under the reviewKey; the
 * header tracks done/total and offers a reset. Hovering a flow lights its owner + changed call
 * targets on the graph; clicking a changed call selects that block.
 */

import { memo, useMemo, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { tickStateOf, type AffectedFlowRow, type ReviewData, type TickState } from "../../derive/reviewData";
import { FlowStepTree } from "./FlowStepTree";
import type { ReviewTick } from "../../state/reviewTicksPref";
import type { GraphIndex } from "../../graph/graphIndex";
import type { FlowStep } from "@meridian/core";

const TICK_GLYPH: Record<TickState, string> = { todo: "○", done: "✓", stale: "◐" };
const TICK_COLOR: Record<TickState, string> = { todo: "#7D8695", done: "#3FB950", stale: "#D29922" };

function ReviewFlowPanelImpl() {
  const review = useBlueprint((state) => state.review);
  const ticks = useBlueprint((state) => state.reviewTicks);
  const affectedIds = useBlueprint((state) => state.reviewAffectedIds);
  const unmapped = useBlueprint((state) => state.reviewUnmapped);
  const index = useBlueprint((state) => state.index);
  if (!review) {
    return null;
  }
  return (
    <div style={PANEL}>
      <Header review={review} ticks={ticks} />
      <div style={SCROLL}>
        <FlowGroup title="Changed flows" hint="the flow's own code was edited" rows={review.rows.filter((r) => r.group === "changed")} review={review} affectedIds={affectedIds} index={index} ticks={ticks} />
        <FlowGroup title="Impacted flows" hint="calls into changed code" rows={review.rows.filter((r) => r.group === "impacted")} review={review} affectedIds={affectedIds} index={index} ticks={ticks} />
        {review.rows.length === 0 && <div style={EMPTY}>No logic flows touch this change.</div>}
        <UnmappedList files={unmapped} />
      </div>
    </div>
  );
}

function Header({ review, ticks }: { review: ReviewData; ticks: Record<string, ReviewTick> }) {
  const { resetReviewTicks } = useBlueprintActions();
  const done = review.rows.filter((row) => tickStateOf(row, ticks) === "done").length;
  const total = review.rows.length;
  const ctx = review.context;
  return (
    <div style={HEADER}>
      <div style={HEADER_TOP}>
        <span style={HEADER_TITLE}>PR review</span>
        {total > 0 && <button type="button" style={RESET_BTN} onClick={resetReviewTicks}>Reset</button>}
      </div>
      <div style={HEADER_REF}>
        <span style={REF_BRANCH}>{ctx.headRef ?? "working tree"}</span>
        <span style={REF_ARROW}>vs</span>
        <span style={REF_BASE}>{ctx.baseRef ?? "explicit files"}</span>
      </div>
      {total > 0 && (
        <div style={PROGRESS_ROW}>
          <div style={PROGRESS_TRACK}>
            <div style={{ ...PROGRESS_FILL, width: `${total ? (done / total) * 100 : 0}%` }} />
          </div>
          <span style={PROGRESS_LABEL}>{done}/{total} reviewed</span>
        </div>
      )}
      {ctx.warnings.map((warning, index) => (
        <div key={index} style={WARNING}>{warning}</div>
      ))}
    </div>
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
    <section style={GROUP}>
      <div style={GROUP_HEAD}>
        <span style={GROUP_TITLE}>{props.title}</span>
        <span style={GROUP_COUNT}>{props.rows.length}</span>
        <span style={GROUP_HINT}>{props.hint}</span>
      </div>
      {props.rows.map((row) => (
        <FlowRow key={row.flow.flowId} row={row} review={props.review} affectedIds={props.affectedIds} index={props.index} ticks={props.ticks} />
      ))}
    </section>
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

function UnmappedList({ files }: { files: ReviewData["context"]["changedFiles"] }) {
  if (files.length === 0) {
    return null;
  }
  return (
    <section style={GROUP}>
      <div style={GROUP_HEAD}>
        <span style={GROUP_TITLE}>Not in the graph</span>
        <span style={GROUP_COUNT}>{files.length}</span>
      </div>
      {files.map((file) => (
        <div key={file.path} style={UNMAPPED_ROW} title={file.path}>
          <span style={UNMAPPED_STATUS}>{file.status[0].toUpperCase()}</span>
          <span style={UNMAPPED_PATH}>{file.path}</span>
        </div>
      ))}
    </section>
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

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export const ReviewFlowPanel = memo(ReviewFlowPanelImpl);

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
const HEADER_TOP: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const HEADER_TITLE: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "#E6EDF3" };
const RESET_BTN: React.CSSProperties = { border: "1px solid #2A2F37", background: "transparent", color: "#9AA4B2", borderRadius: 6, padding: "2px 8px", fontSize: 11, cursor: "pointer", font: "inherit" };
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
const GROUP: React.CSSProperties = { marginTop: 8 };
const GROUP_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 6px 4px" };
const GROUP_TITLE: React.CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#9AA4B2" };
const GROUP_COUNT: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: "#9AA4B2", background: "#1B212A", borderRadius: 9, padding: "0 6px" };
const GROUP_HINT: React.CSSProperties = { fontSize: 10.5, color: "#5A6472", fontStyle: "italic" };
const ROW: React.CSSProperties = { borderRadius: 7, border: "1px solid transparent", padding: "2px 4px", marginBottom: 2 };
const ROW_SELECTED: React.CSSProperties = { ...ROW, borderColor: "#2E3A4D", background: "rgba(46,58,77,0.25)" };
const ROW_HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4 };
const TICK_BTN: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 4px", flexShrink: 0 };
const ROW_MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "4px 2px", textAlign: "left" };
const CARET: React.CSSProperties = { fontSize: 9, color: "#5A6472", width: 10, flexShrink: 0 };
const ROW_NAME: React.CSSProperties = { flex: 1, minWidth: 0, fontSize: 12.5, color: "#E6EDF3", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const ROW_LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
const TEST_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#8B7DF0", border: "1px solid #3A3357", borderRadius: 4, padding: "0 4px", flexShrink: 0 };
const EDITED_CHIP: React.CSSProperties = { fontSize: 9, fontWeight: 700, color: "#6BE38A", border: "1px solid #2E5A3A", borderRadius: 4, padding: "0 4px", flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 };
const HITS: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px 4px 26px" };
const HIT_CHIP: React.CSSProperties = { fontSize: 9.5, color: "#E6C07A", background: "rgba(210,153,34,0.1)", border: "1px solid #5A4A22", borderRadius: 4, padding: "0 5px", fontFamily: MONO };
const TREE_WRAP: React.CSSProperties = { padding: "4px 6px 8px 22px" };
const EMPTY: React.CSSProperties = { fontSize: 12, color: "#7D8695", padding: "16px 8px", textAlign: "center" };
const UNMAPPED_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", fontFamily: MONO, fontSize: 11 };
const UNMAPPED_STATUS: React.CSSProperties = { color: "#7D8695", fontWeight: 700, width: 12, flexShrink: 0 };
const UNMAPPED_PATH: React.CSSProperties = { color: "#7D8695", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
