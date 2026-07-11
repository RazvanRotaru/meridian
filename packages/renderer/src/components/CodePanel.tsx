/**
 * The source-code modal: a centered overlay that blows up the code shown inline on a node (its
 * ⤢ expand button flips `codeView.mode` to "modal"). Its whole state lives on the store's
 * `codeView`; this component renders only when the mode is "modal" and offers three ways out —
 * the close button, Escape, and a backdrop click. The code is syntax-highlighted by CodeBlock,
 * which escapes it as plain text children (never dangerouslySetInnerHTML).
 */

import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { useClearOnEscape } from "./canvas/useClearOnEscape";
import { CodeBlock } from "./CodeBlock";
import { summarizeChangeKinds, useChangeSummary, useChangedLines, useLineChangeKinds } from "./useChangedLines";

export function CodePanel() {
  const codeView = useBlueprint((state) => state.codeView);
  const { closeCode } = useBlueprintActions();
  const wholeFile = codeView?.wholeFile ?? false;
  // A PR-review panel carries its own head-relative diff; otherwise the artifact's `changedSince`
  // drives the paint. The hooks run unconditionally (rules of hooks) and are overridden when carried.
  const hookChangedLines = useChangedLines(codeView?.node, wholeFile);
  const hookChangedLineKinds = useLineChangeKinds(codeView?.node, wholeFile);
  const hookSummary = useChangeSummary(codeView?.node, wholeFile);
  const changedLines = codeView?.changedLines ?? hookChangedLines;
  const changedLineKinds = codeView?.changedLineKinds ?? hookChangedLineKinds;
  const summary = codeView?.changedLineKinds ? summarizeChangeKinds(codeView.changedLineKinds) : hookSummary;
  const open = codeView?.mode === "modal";

  // Escape closes the modal while it's open — but as the TOP layer, so a modal opened over the
  // PR-review overlay closes just itself and the next Escape reaches the overlay beneath it.
  useClearOnEscape(closeCode, open);

  if (!codeView || codeView.mode !== "modal") {
    return null;
  }
  const { node, code, loading, error, truncated } = codeView;
  const { file, startLine, endLine } = node.location;
  const baseLine = codeView.baseLine ?? startLine;
  // A PR-review panel shows the HEAD file sliced to where the unit moved to, so the subtitle range
  // must track the shown lines (baseLine..+len), not the node's base span. Whole-file view titles by
  // the file and lands on the first change, so its own span in the subtitle would be misleading too.
  const isHead = codeView.changedLineKinds !== undefined;
  const shownEnd = isHead ? baseLine + Math.max((code?.split("\n").length ?? 1) - 1, 0) : endLine ?? startLine;
  const title = wholeFile ? (file.split("/").pop() ?? file) : node.displayName;
  const range = shownEnd !== baseLine ? `${baseLine}-${shownEnd}` : String(baseLine);
  const location = wholeFile ? file : `${file}:${range}`;

  // A backdrop click closes; clicks inside the panel are swallowed so they don't reach it.
  return (
    <div style={BACKDROP_STYLE} onClick={closeCode}>
      <div
        style={PANEL_STYLE}
        role="dialog"
        aria-modal
        aria-label="Source code"
        onClick={(event) => event.stopPropagation()}
      >
        <header style={HEADER_STYLE}>
          <div style={HEADER_TEXT_STYLE}>
            <div style={TITLE_STYLE} title={node.qualifiedName}>{title}</div>
            <div style={LOCATION_STYLE} title={file}>{location}</div>
            {summary ? (
              <div style={SUMMARY_ROW_STYLE}>
                <span style={ADDED_STYLE}>{`+${summary.added} lines`}</span>
                <span style={DELETED_STYLE}>{`-${summary.deleted} lines`}</span>
              </div>
            ) : null}
          </div>
          <button type="button" style={CLOSE_STYLE} onClick={closeCode} aria-label="Close source">
            ×
          </button>
        </header>
        <div style={BODY_STYLE}>
          {loading ? <div style={STATUS_STYLE}>Loading source…</div> : null}
          {error ? <div style={ERROR_STYLE}>{error}</div> : null}
          {code !== null ? (
            <CodeBlock
              code={code}
              maxHeight="70vh"
              startLine={baseLine}
              showGutter
              changedLines={changedLines}
              changedLineKinds={changedLineKinds}
            />
          ) : null}
          {truncated ? <div style={TRUNCATED_STYLE}>Snippet truncated by the server.</div> : null}
        </div>
      </div>
    </div>
  );
}

const BACKDROP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(8,10,14,0.6)",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const PANEL_STYLE: React.CSSProperties = {
  width: "70vw",
  maxWidth: 900,
  height: "75vh",
  display: "flex",
  flexDirection: "column",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  overflow: "hidden",
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "12px 14px",
  borderBottom: "1px solid #2A2F37",
  background: "#161B22",
};
const HEADER_TEXT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const LOCATION_STYLE: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: "#7B8695",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUMMARY_ROW_STYLE: React.CSSProperties = {
  marginTop: 6,
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};
const ADDED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#56C271",
  border: "1px solid rgba(86,194,113,0.45)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "rgba(86,194,113,0.1)",
};
const DELETED_STYLE: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: "#F0787C",
  border: "1px solid rgba(240,120,124,0.45)",
  borderRadius: 4,
  padding: "1px 6px",
  background: "rgba(240,120,124,0.1)",
};
const CLOSE_STYLE: React.CSSProperties = {
  flexShrink: 0,
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  width: 26,
  height: 26,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
};
const BODY_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: 12,
};
const STATUS_STYLE: React.CSSProperties = { fontSize: 12, color: "#7B8695" };
const ERROR_STYLE: React.CSSProperties = { fontSize: 12, color: "#f2777a" };
const TRUNCATED_STYLE: React.CSSProperties = { marginTop: 8, fontSize: 11, color: "#7B8695" };
