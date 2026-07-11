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

import type { CodeView } from "../state/store";
import { CodeBlock } from "./CodeBlock";
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
          />
        ) : null}
        {truncated ? <div style={TRUNCATED_STYLE}>…truncated</div> : null}
      </div>
    </div>
  );
}

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
