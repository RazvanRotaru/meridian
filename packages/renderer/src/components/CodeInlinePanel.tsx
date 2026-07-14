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
import { SourceDiffBody, useSourceDiffModel } from "./SourceDiffBody";

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
  const { node } = codeView;
  const model = useSourceDiffModel(codeView);
  const wholeFile = codeView.wholeFile ?? false;
  const { file, startLine, endLine } = node.location;
  const baseLine = model.baseLine;
  const shownEnd = codeView.code === null ? endLine ?? startLine : model.shownEnd;
  const emptySource = codeView.code !== null && model.sourceLineCount === 0;
  const range = emptySource
    ? "empty"
    : shownEnd !== baseLine ? `${baseLine}-${shownEnd}` : String(baseLine);
  const location = wholeFile ? `${file}${emptySource ? " · empty" : ""}` : `${file}:${range}`;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div style={PANEL_STYLE} onClick={stop} onDoubleClick={stop} onMouseDown={stop}>
      <div style={HEADER_STYLE}>
        <span style={LOCATION_STYLE} title={file}>{location}</span>
        {model.summary ? (
          <span style={SUMMARY_STYLE}>{`+${model.summary.added}  -${model.summary.deleted}`}</span>
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
        <SourceDiffBody model={model} maxHeight={340} showGutter={showGutter} />
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
