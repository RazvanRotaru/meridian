/**
 * The source-code modal: a centered overlay that blows up the code shown inline on a node (its
 * ⤢ expand button flips `codeView.mode` to "modal"). Its whole state lives on the store's
 * `codeView`; this component renders only when the mode is "modal" and offers three ways out —
 * the close button, Escape, and a backdrop click. Code is placed as a text child of <pre>/<code>
 * so React escapes it (never dangerouslySetInnerHTML).
 */

import { useEffect } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";

export function CodePanel() {
  const codeView = useBlueprint((state) => state.codeView);
  const { closeCode } = useBlueprintActions();
  const open = codeView?.mode === "modal";

  // Escape closes the modal while it's open. Rebinding on `open` keeps the listener off the
  // document when nothing is shown.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeCode();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, closeCode]);

  if (!codeView || codeView.mode !== "modal") {
    return null;
  }
  const { node, code, loading, error, truncated } = codeView;
  const { file, startLine, endLine } = node.location;
  const range = endLine && endLine !== startLine ? `${startLine}-${endLine}` : String(startLine);

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
            <div style={TITLE_STYLE} title={node.qualifiedName}>{node.displayName}</div>
            <div style={LOCATION_STYLE} title={file}>{`${file}:${range}`}</div>
          </div>
          <button type="button" style={CLOSE_STYLE} onClick={closeCode} aria-label="Close source">
            ×
          </button>
        </header>
        <div style={BODY_STYLE}>
          {loading ? <div style={STATUS_STYLE}>Loading source…</div> : null}
          {error ? <div style={ERROR_STYLE}>{error}</div> : null}
          {code !== null ? <CodeListing code={code} startLine={startLine} /> : null}
          {truncated ? <div style={TRUNCATED_STYLE}>Snippet truncated by the server.</div> : null}
        </div>
      </div>
    </div>
  );
}

/** A line-numbered listing: a gutter of numbers starting at `startLine`, next to the code. */
function CodeListing(props: { code: string; startLine: number }) {
  const lines = props.code.split("\n");
  const gutter = lines.map((_line, index) => props.startLine + index).join("\n");
  return (
    <div style={LISTING_STYLE}>
      <pre style={GUTTER_STYLE} aria-hidden>{gutter}</pre>
      <pre style={CODE_STYLE}><code>{props.code}</code></pre>
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
const LISTING_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  lineHeight: "18px",
};
const GUTTER_STYLE: React.CSSProperties = {
  margin: 0,
  textAlign: "right",
  color: "#4A525F",
  userSelect: "none",
  whiteSpace: "pre",
};
const CODE_STYLE: React.CSSProperties = {
  margin: 0,
  flex: 1,
  color: "#C9D3E0",
  whiteSpace: "pre",
  overflowX: "auto",
};
