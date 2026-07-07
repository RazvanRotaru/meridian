/**
 * The list pane's header: "N / M reviewed" + a thin progress bar (green + "All flows reviewed"
 * at 100%), a header checkbox that bulk-marks/clears every currently visible row (indeterminate
 * when the visible set is a mix), a "Hide reviewed" mode toggle, and — when a graph file-click
 * set a filter — a dismissible "Filtered: <file>" chip.
 */

import { useEffect, useRef, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { REVIEW_COLORS } from "../theme/reviewColors";
import { basename } from "./reviewListText";

const UNDO_WINDOW_MS = 5000;

interface UndoState {
  ids: string[];
  marked: boolean;
}

export function ReviewListHeader(props: {
  reviewedCount: number;
  total: number;
  visibleFlowIds: string[];
  reviewedFlowIds: ReadonlySet<string>;
  filterFileId: string | null;
}) {
  const { reviewedCount, total, visibleFlowIds, reviewedFlowIds, filterFileId } = props;
  const reviewHideReviewed = useBlueprint((state) => state.reviewHideReviewed);
  const { markVisibleReviewed, clearVisibleReviewed, toggleReviewHideReviewed, setReviewListFilter } =
    useBlueprintActions();
  const [undo, setUndo] = useState<UndoState | null>(null);
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  const allChecked = visibleFlowIds.length > 0 && visibleFlowIds.every((id) => reviewedFlowIds.has(id));
  const someChecked = !allChecked && visibleFlowIds.some((id) => reviewedFlowIds.has(id));
  const percent = total > 0 ? Math.round((reviewedCount / total) * 100) : 0;
  const complete = total > 0 && reviewedCount === total;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = someChecked;
    }
  }, [someChecked]);

  useEffect(() => {
    if (!undo) {
      return;
    }
    const timer = setTimeout(() => setUndo(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  function toggleAll() {
    if (visibleFlowIds.length === 0) {
      return;
    }
    if (allChecked) {
      clearVisibleReviewed(visibleFlowIds);
      setUndo({ ids: visibleFlowIds, marked: false });
    } else {
      markVisibleReviewed(visibleFlowIds);
      setUndo({ ids: visibleFlowIds, marked: true });
    }
  }

  function handleUndo() {
    if (!undo) {
      return;
    }
    if (undo.marked) {
      clearVisibleReviewed(undo.ids);
    } else {
      markVisibleReviewed(undo.ids);
    }
    setUndo(null);
  }

  return (
    <div style={HEADER_STYLE}>
      {filterFileId ? <FilterChip file={filterFileId} onClear={() => setReviewListFilter(null)} /> : null}
      <div style={TOP_ROW_STYLE}>
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allChecked}
          disabled={visibleFlowIds.length === 0}
          aria-label="Select all visible flows"
          style={CHECKBOX_STYLE}
          onChange={toggleAll}
        />
        <span style={complete ? COUNT_COMPLETE_STYLE : COUNT_STYLE}>
          {complete ? "All flows reviewed" : `${reviewedCount} / ${total} reviewed`}
        </span>
        <button type="button" style={hideToggleStyle(reviewHideReviewed)} aria-pressed={reviewHideReviewed} onClick={toggleReviewHideReviewed}>
          Hide reviewed
        </button>
      </div>
      <div style={PROGRESS_TRACK_STYLE}>
        <div style={progressFillStyle(percent, complete)} />
      </div>
      {undo ? (
        <div style={UNDO_ROW_STYLE}>
          <span>{undo.marked ? `Marked ${undo.ids.length} flow(s) reviewed.` : `Cleared ${undo.ids.length} flow(s).`}</span>
          <button type="button" style={UNDO_BUTTON_STYLE} onClick={handleUndo}>
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip(props: { file: string; onClear: () => void }) {
  return (
    <div style={CHIP_ROW_STYLE}>
      <span style={CHIP_STYLE} title={props.file}>
        Filtered: {basename(props.file)}
        <button type="button" style={CHIP_CLOSE_STYLE} aria-label="Clear filter" onClick={props.onClear}>
          ×
        </button>
      </span>
    </div>
  );
}

function hideToggleStyle(active: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    background: active ? "#1F2530" : "transparent",
    color: active ? "#E6EDF3" : "#9AA4B2",
    border: "1px solid #2A2F37",
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 11,
    cursor: "pointer",
    font: "inherit",
  };
}

function progressFillStyle(percent: number, complete: boolean): React.CSSProperties {
  return {
    height: "100%",
    width: `${percent}%`,
    borderRadius: 2,
    background: complete ? REVIEW_COLORS.reviewed : REVIEW_COLORS.callsInto,
    transition: "width 200ms ease, background 200ms ease",
  };
}

const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "10px 12px",
  borderBottom: "1px solid #2A2F37",
};
const TOP_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const CHECKBOX_STYLE: React.CSSProperties = { accentColor: REVIEW_COLORS.reviewed, colorScheme: "dark" };
const COUNT_STYLE: React.CSSProperties = { flex: 1, fontSize: 12, color: "#9AA4B2" };
const COUNT_COMPLETE_STYLE: React.CSSProperties = { ...COUNT_STYLE, color: REVIEW_COLORS.reviewed, fontWeight: 600 };
const PROGRESS_TRACK_STYLE: React.CSSProperties = { height: 3, borderRadius: 2, background: "#1A1F27", overflow: "hidden" };
const UNDO_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 11,
  color: "#9AA4B2",
};
const UNDO_BUTTON_STYLE: React.CSSProperties = {
  background: "transparent",
  color: REVIEW_COLORS.callsInto,
  border: "none",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  font: "inherit",
};
const CHIP_ROW_STYLE: React.CSSProperties = { display: "flex" };
const CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  color: "#E6EDF3",
  background: "#1A1F27",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  padding: "2px 8px",
};
const CHIP_CLOSE_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#9AA4B2",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
};
