/**
 * One touched code unit inside a file row of the files checklist: kind glyph (the graph's own
 * accent), name, start line, a comment button, and its reviewed tick. Hover lights exactly this
 * block on the graph; clicking the name selects it there. Drafts and the shared composer render
 * directly under the row.
 */

import { useState } from "react";
import { useBlueprintActions } from "../../state/StoreContext";
import { type CheckState, type ReviewUnitRow as UnitRowData } from "../../derive/reviewFiles";
import type { ReviewComment } from "../../state/reviewTicksPref";
import { accentForKind } from "../../theme/kindColors";
import { CommentButton, CommentComposer, CommentList } from "./ReviewComments";
import { KIND_CHIP, kindChipText, MONO, NO_FOCUS_RING, TEST_CHIP, TICK_BTN, TICK_COLOR, TICK_GLYPH, type CommentTarget } from "./reviewPanelKit";

export function UnitRow(props: {
  unit: UnitRowData;
  path: string;
  /** GitHub viewed state is file-atomic; every unit in this row shares its owning file's state. */
  viewState: CheckState;
  drafts: readonly ReviewComment[];
  composer: CommentTarget | null;
  onComposer: (target: CommentTarget | null) => void;
  viewedBlockedReason?: string | null;
}) {
  const { unit, path, viewState, drafts, composer, onComposer, viewedBlockedReason = null } = props;
  const { toggleReviewUnitTick, addReviewComment, setReviewLit, selectReviewNode } = useBlueprintActions();
  const [hovered, setHovered] = useState(false);
  const state = viewState;
  const isBaseOnly = unit.sourceSide === "base";
  const composerHere = !isBaseOnly && composer !== null && composer.nodeId === unit.nodeId;
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
        <button
          type="button"
          style={MAIN}
          title={isBaseOnly
            ? `${unit.displayName} · ${unit.kind} · deleted in this pull request — click to reveal on the graph`
            : `${unit.displayName} · ${unit.kind} — click to reveal on the graph`}
          onClick={() => selectReviewNode(unit.nodeId)}
        >
          <span style={NAME}>{unit.displayName}</span>
          {chip !== null && <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{chip}</span>}
          {unit.isTest && <span style={TEST_CHIP}>test</span>}
          {isBaseOnly && <span style={DELETED_CHIP} aria-label="Deleted in this pull request">deleted</span>}
          <span style={LOC}>:{unit.startLine}</span>
        </button>
        {!isBaseOnly && (
          <CommentButton count={drafts.length} active={composerHere} visible={hovered} onClick={() => onComposer(composerHere ? null : { path, nodeId: unit.nodeId })} />
        )}
        <button
          type="button"
          style={{ ...TICK_BTN, color: TICK_COLOR[state], ...(viewedBlockedReason === null ? {} : VIEWED_DISABLED) }}
          disabled={viewedBlockedReason !== null}
          title={viewedBlockedReason
            ?? (state === "done"
              ? `Viewed ${path} — click to unmark the file`
              : state === "stale"
                ? `${path} changed since viewed — click to mark the file again`
                : `Mark ${path} as viewed`)}
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
const VIEWED_DISABLED: React.CSSProperties = { cursor: "wait", opacity: 0.55 };
const MAIN: React.CSSProperties = { flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 5, border: "none", background: "transparent", cursor: "pointer", font: "inherit", padding: "3px 0", textAlign: "left", ...NO_FOCUS_RING };
const NAME: React.CSSProperties = { minWidth: 0, fontSize: 12, color: "#C9D1D9", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const LOC: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "#5A6472", flexShrink: 0 };
const DELETED_CHIP: React.CSSProperties = { flexShrink: 0, fontSize: 9, fontWeight: 700, color: "#F85149", border: "1px solid #6E3030", borderRadius: 4, padding: "0 4px" };
