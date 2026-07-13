/**
 * The compact inline source panel shared by the Call-flow and Logic-flow views: an
 * absolutely-positioned box hanging just below a node (`top:100%`, a SIBLING of the node's clipped
 * body so `overflow:hidden` can't cut it off). It overlays neighbours without changing the node's
 * laid-out box (no relayout). Its header shows the source range plus a ⤢ that blows the same code
 * up into the centered modal (CodePanel) and a × that closes it; the body is the code (via the
 * shared CodeBlock) with its loading/error/truncated states. All pointer events are swallowed so
 * interacting with the box never pans the canvas, drags the node, or triggers select/dive.
 *
 * The one per-view difference is `showGutter`: the Call-flow leaf keeps its line-number gutter; the
 * Logic-flow block shows none. Each view keeps its own `</>` trigger (placed differently) and its
 * own show/hide gating — this component is just the opened panel.
 */

import { useEffect, useMemo, useState } from "react";
import { anchorableHunks } from "../derive/reviewSubmit";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { CodeView } from "../state/store";
import { CodeBlock } from "./CodeBlock";
import { useCodeReviewComments, useGitHubCommentableReviewLines, usePendingCodeReviewComments } from "./review/useCodeReviewComments";
import { summarizeChangeKinds, useChangeSummary, useChangedLines, useLineChangeKinds } from "./useChangedLines";

export function CodeInlinePanel({
  codeView,
  onExpand,
  onClose,
  showGutter,
}: {
  codeView: CodeView;
  onExpand(): void;
  onClose(): void;
  showGutter?: boolean;
}) {
  const { node, code, loading, error, truncated } = codeView;
  const review = useBlueprint((state) => state.review);
  const prReviewed = useBlueprint((state) => state.prReviewed);
  const removed = useBlueprint((state) => state.reviewRemovedByFile[node.location?.file ?? ""] ?? EMPTY_REMOVED);
  const removedTruncated = useBlueprint((state) => state.reviewRemovedTruncatedByFile[node.location?.file ?? ""] === true);
  const { addReviewComment } = useBlueprintActions();
  const wholeFile = codeView.wholeFile ?? false;
  // Prefer the PR-review panel's own head-relative diff; else the artifact's `changedSince`. Hooks run
  // unconditionally (rules of hooks) and are overridden when the panel carries its own.
  const hookChangedLines = useChangedLines(node, wholeFile);
  const hookChangedLineKinds = useLineChangeKinds(node, wholeFile);
  const hookSummary = useChangeSummary(node, wholeFile);
  const changedLines = codeView.changedLines ?? hookChangedLines;
  const changedLineKinds = codeView.changedLineKinds ?? hookChangedLineKinds;
  const summary = codeView.changedLineKinds ? summarizeChangeKinds(codeView.changedLineKinds) : hookSummary;
  const { file, startLine, endLine } = node.location;
  const baseLine = codeView.baseLine ?? startLine;
  const existingComments = useCodeReviewComments(file, baseLine, code);
  const pendingComments = usePendingCodeReviewComments(file, baseLine, code);
  const githubCommentableLines = useGitHubCommentableReviewLines(file, baseLine, code);
  const visibleLineCount = code === null ? 0 : code.split("\n").length;
  const visibleEnd = baseLine + Math.max(visibleLineCount - 1, 0);
  const commentableLines = useMemo(() => {
    if (review === null) {
      return EMPTY_COMMENTABLE_LINES;
    }
    if (prReviewed !== null) {
      return githubCommentableLines;
    }
    if (anchorableHunks(file, review.context).length === 0) {
      return EMPTY_COMMENTABLE_LINES;
    }
    // Review code is HEAD-side in both modes: sync fetches the head file, while swapped graph
    // locations are head-native. These absolute values therefore map directly to RIGHT-side lines.
    return changedLineKinds.size > 0
      ? new Set([...changedLineKinds].filter(([, kind]) => kind === "added" || kind === "modified").map(([line]) => line))
      : new Set(changedLines);
  }, [changedLineKinds, changedLines, file, githubCommentableLines, prReviewed, review]);
  const visibleRemovedRows = useMemo(() => {
    const rows = new Map<number, string[]>();
    for (const entry of removed) {
      if ((entry.afterNewLine === 0 && baseLine === 1) || (entry.afterNewLine >= baseLine && entry.afterNewLine <= visibleEnd)) {
        rows.set(entry.afterNewLine, [...(rows.get(entry.afterNewLine) ?? []), ...entry.lines]);
      }
    }
    return rows;
  }, [baseLine, removed, visibleEnd]);
  const [activeCommentLine, setActiveCommentLine] = useState<number | null>(null);
  useEffect(() => setActiveCommentLine(null), [node.id, baseLine]);
  // Head-review slice: the shown lines are baseLine..+len (where the unit moved to), not the base span.
  const isHead = codeView.changedLineKinds !== undefined;
  const shownEnd = isHead ? baseLine + Math.max((code?.split("\n").length ?? 1) - 1, 0) : endLine ?? startLine;
  const range = shownEnd !== baseLine ? `${baseLine}-${shownEnd}` : String(baseLine);
  const location = wholeFile ? file : `${file}:${range}`;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div style={PANEL_STYLE} onClick={stop} onDoubleClick={stop} onMouseDown={stop}>
      <div style={HEADER_STYLE}>
        <span style={LOCATION_STYLE} title={file}>{location}</span>
        {summary ? (
          <span style={SUMMARY_STYLE}>{`+${summary.added}  -${summary.deleted}`}</span>
        ) : null}
        <button
          type="button"
          style={ICON_STYLE}
          aria-label="Open in modal"
          title="Open in modal"
          onClick={(event) => {
            stop(event);
            onExpand();
          }}
        >
          ⤢
        </button>
        <button
          type="button"
          style={ICON_STYLE}
          aria-label="Close source"
          title="Close"
          onClick={(event) => {
            stop(event);
            onClose();
          }}
        >
          ×
        </button>
      </div>
      <div style={BODY_STYLE}>
        {loading ? <div style={STATUS_STYLE}>Loading…</div> : null}
        {error ? <div style={ERROR_STYLE}>{error}</div> : null}
        {code !== null ? (
          <CodeBlock
            code={code}
            maxHeight={340}
            startLine={baseLine}
            showGutter={showGutter}
            changedLines={changedLines}
            changedLineKinds={changedLineKinds}
            commentableLines={commentableLines}
            onLineClick={commentableLines.size > 0 ? setActiveCommentLine : undefined}
            lineComposer={activeCommentLine === null || !commentableLines.has(activeCommentLine) ? null : {
              line: activeCommentLine,
              onAdd: (body) => addReviewComment(file, null, body, activeCommentLine),
              onCancel: () => setActiveCommentLine(null),
            }}
            existingComments={existingComments}
            pendingComments={pendingComments}
            removedRows={visibleRemovedRows}
            removedTruncated={removedTruncated}
          />
        ) : null}
        {truncated ? <div style={TRUNCATED_STYLE}>…truncated</div> : null}
      </div>
    </div>
  );
}

const EMPTY_COMMENTABLE_LINES: ReadonlySet<number> = new Set<number>();
const EMPTY_REMOVED: readonly { afterNewLine: number; lines: string[] }[] = [];

const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 6,
  width: 640,
  maxWidth: "74vw",
  zIndex: 20,
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  overflow: "hidden",
  cursor: "default",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 8px",
  background: "#161B22",
  borderBottom: "1px solid #2A2F37",
};
const LOCATION_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "#7B8695",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUMMARY_STYLE: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 700,
  color: "#E2A33C",
  border: "1px solid rgba(226,163,60,0.55)",
  borderRadius: 4,
  padding: "1px 5px",
  background: "rgba(226,163,60,0.12)",
};
const ICON_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 5,
  width: 20,
  height: 20,
  fontSize: 12,
  lineHeight: 1,
  cursor: "pointer",
};
const BODY_STYLE: React.CSSProperties = { padding: 8 };
const STATUS_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695" };
const ERROR_STYLE: React.CSSProperties = { fontSize: 11, color: "#f2777a" };
const TRUNCATED_STYLE: React.CSSProperties = { marginTop: 6, fontSize: 10, color: "#7B8695" };
