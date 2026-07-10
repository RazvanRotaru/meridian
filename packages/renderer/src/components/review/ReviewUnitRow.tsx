/**
 * One touched code unit inside a file row of the files checklist: kind glyph (the graph's own
 * accent), name, start line, a comment button, and its reviewed tick. Hover lights exactly this
 * block on the graph; clicking the name selects it there. Drafts and the shared composer render
 * directly under the row.
 */

import { useState } from "react";
import { useBlueprintActions } from "../../state/StoreContext";
import { checkStateOf, type ReviewUnitRow as UnitRowData } from "../../derive/reviewFiles";
import type { ReviewComment, ReviewTick } from "../../state/reviewTicksPref";
import { accentForKind } from "../../theme/kindColors";
import { CommentButton, CommentComposer, CommentList } from "./ReviewComments";
import { KIND_CHIP, kindChipText, MONO, NO_FOCUS_RING, TEST_CHIP, TICK_BTN, TICK_COLOR, TICK_GLYPH, type CommentTarget } from "./reviewPanelKit";

export function UnitRow(props: {
  unit: UnitRowData;
  path: string;
  tick: ReviewTick | undefined;
  drafts: readonly ReviewComment[];
  composer: CommentTarget | null;
  onComposer: (target: CommentTarget | null) => void;
}) {
  const { unit, path, tick, drafts, composer, onComposer } = props;
  const { toggleReviewUnitTick, addReviewComment, setReviewLit, selectReviewNode } = useBlueprintActions();
  const [hovered, setHovered] = useState(false);
  const state = checkStateOf(unit.fingerprint, tick);
  const composerHere = composer !== null && composer.nodeId === unit.nodeId;
  const chip = kindChipText(unit.kind);
  const accent = accentForKind(unit.kind);
  return (
    <>
      <div
        style={{ ...ROW, paddingLeft: 24 + unit.depth * 14 }}
        onMouseEnter={() => {
          setHovered(true);
          setReviewLit(new Set([unit.nodeId]));
        }}
        onMouseLeave={() => {
          setHovered(false);
          setReviewLit(null);
        }}
      >
        <button type="button" style={MAIN} title={`${unit.displayName} · ${unit.kind} — click to reveal on the graph`} onClick={() => selectReviewNode(unit.nodeId)}>
          <span style={NAME}>{unit.displayName}</span>
          {chip !== null && <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{chip}</span>}
          {unit.isTest && <span style={TEST_CHIP}>test</span>}
          <span style={LOC}>:{unit.startLine}</span>
        </button>
        <CommentButton count={drafts.length} active={composerHere} visible={hovered} onClick={() => onComposer(composerHere ? null : { path, nodeId: unit.nodeId })} />
        <button
          type="button"
          style={{ ...TICK_BTN, color: TICK_COLOR[state] }}
          title={state === "stale" ? "Changed since checked — click to re-check" : "Mark as reviewed"}
          onClick={() => toggleReviewUnitTick(unit.nodeId)}
        >
          {TICK_GLYPH[state]}
        </button>
      </div>
      <CommentList comments={drafts} />
      {composerHere && (
        <CommentComposer placeholder={`Comment on ${unit.displayName}…`} onAdd={(body) => addReviewComment(path, unit.nodeId, body)} onCancel={() => onComposer(null)} />
      )}
    </>
  );
}

const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "1px 6px 1px 0", borderRadius: 6 };
const MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "3px 0", textAlign: "left", ...NO_FOCUS_RING };
const NAME: React.CSSProperties = { minWidth: 0, fontSize: 12, color: "#C9D1D9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
