/**
 * A leaf node (no children): a function/method, or any childless declaration. Function and
 * method nodes reveal their monospace signature and typed input/output pins (the left/right
 * handles), so a reader sees what flows in and what flows out of the unit.
 */

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../theme/kindColors";
import { ellipsize } from "../../theme/displayName";
import { isCallable } from "../../layout/nodeSize";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintNode } from "../../layout/rfTypes";
import type { CodeView } from "../../state/store";
import { NodeHeader } from "./NodeHeader";
import { TelemetryBadges } from "../TelemetryBadges";

export function LeafNode(props: NodeProps<BlueprintNode>) {
  const node = props.data.node;
  const accent = accentForKind(node.kind);
  const metrics = useBlueprint((state) => state.telemetry[props.id]);
  const selected = useBlueprint((state) => state.selectedId === props.id);
  const isEntry = useBlueprint((state) => state.flowRootId === props.id);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const codeView = useBlueprint((state) => state.codeView);
  const { showCode, expandCode, closeCode } = useBlueprintActions();
  const callable = isCallable(node.kind);
  // Offer the source button only for a callable whose location the server can actually serve.
  const canShowCode = callable && Boolean(node.location) && Boolean(sourceUrl);
  const showingHere = codeView?.node.id === node.id;
  const toggleCode = () => (showingHere ? closeCode() : void showCode(node));
  return (
    // A fragment, not a lone card: the inline panel is a SIBLING of the card so the card's
    // overflow:hidden can't clip it. Both live inside React Flow's node wrapper, which is the
    // positioned box the panel's top:100% anchors to (it exactly equals the card's box).
    <>
      <div style={cardStyle(accent, selected, isEntry)}>
        <Handle type="target" position={Position.Left} id="in" style={pinStyle(callable)} />
        {canShowCode ? <CodeButton active={showingHere} onToggle={toggleCode} /> : null}
        <NodeHeader node={node} accent={accent} entry={isEntry} reserveRight={canShowCode}>
          <TelemetryBadges metrics={metrics} />
        </NodeHeader>
        <div style={BODY_STYLE}>
          {node.summary ? <div style={SUMMARY_STYLE}>{ellipsize(node.summary, 96)}</div> : null}
          {callable && node.signature ? <code style={SIGNATURE_STYLE}>{node.signature}</code> : null}
        </div>
        <Handle type="source" position={Position.Right} id="out" style={pinStyle(callable)} />
      </div>
      {codeView && showingHere && codeView.mode === "inline" ? (
        <InlineCodePanel codeView={codeView} onExpand={expandCode} onClose={closeCode} />
      ) : null}
    </>
  );
}

// The subtle </> control that toggles the source view. It lives OUTSIDE NodeHeader (a <button>
// can't nest a <button>) as an absolutely-positioned corner control; stopPropagation keeps its
// click off the node's select/dive handlers. Hover or an open panel lifts it to the accent green.
function CodeButton(props: { active: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  const lifted = hover || props.active;
  return (
    <button
      type="button"
      aria-label={props.active ? "Hide source" : "Show source"}
      title={props.active ? "Hide source" : "Show source"}
      style={lifted ? CODE_BUTTON_HOVER_STYLE : CODE_BUTTON_STYLE}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {"</>"}
    </button>
  );
}

// The compact inline code panel: an absolutely-positioned section hanging just below the card
// (top:100%), capped in width/height and scrollable, so it overlays neighbours without changing
// the node's laid-out box (no relayout). Clicks inside stay off the node's select/dive handlers.
// Its ⤢ button blows the same code up into the centered modal (CodePanel); × closes it.
function InlineCodePanel(props: { codeView: CodeView; onExpand: () => void; onClose: () => void }) {
  const { node, code, loading, error, truncated } = props.codeView;
  const { file, startLine, endLine } = node.location;
  const range = endLine && endLine !== startLine ? `${startLine}-${endLine}` : String(startLine);
  return (
    <div
      style={INLINE_PANEL_STYLE}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div style={INLINE_HEADER_STYLE}>
        <span style={INLINE_LOCATION_STYLE} title={file}>{`${file}:${range}`}</span>
        <button
          type="button"
          style={INLINE_ICON_STYLE}
          aria-label="Open in modal"
          title="Open in modal"
          onClick={(event) => {
            event.stopPropagation();
            props.onExpand();
          }}
        >
          ⤢
        </button>
        <button
          type="button"
          style={INLINE_ICON_STYLE}
          aria-label="Close source"
          title="Close"
          onClick={(event) => {
            event.stopPropagation();
            props.onClose();
          }}
        >
          ×
        </button>
      </div>
      <div style={INLINE_BODY_STYLE}>
        {loading ? <div style={INLINE_STATUS_STYLE}>Loading…</div> : null}
        {error ? <div style={INLINE_ERROR_STYLE}>{error}</div> : null}
        {code !== null ? <InlineCodeListing code={code} startLine={startLine} /> : null}
        {truncated ? <div style={INLINE_TRUNCATED_STYLE}>…truncated</div> : null}
      </div>
    </div>
  );
}

// A line-numbered listing: a gutter of numbers starting at `startLine`, next to the code.
function InlineCodeListing(props: { code: string; startLine: number }) {
  const lines = props.code.split("\n");
  const gutter = lines.map((_line, index) => props.startLine + index).join("\n");
  return (
    <div style={INLINE_LISTING_STYLE}>
      <pre style={INLINE_GUTTER_STYLE} aria-hidden>{gutter}</pre>
      <pre style={INLINE_CODE_STYLE}><code>{props.code}</code></pre>
    </div>
  );
}

function cardStyle(accent: string, selected: boolean, isEntry: boolean): React.CSSProperties {
  return {
    position: "relative",
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: isEntry ? "2px solid #56C271" : `1px solid ${selected ? accent : "#2A2F37"}`,
    background: "#161A21",
    boxShadow: isEntry
      ? "0 0 0 3px rgba(86,194,113,0.30)"
      : selected
        ? `0 0 0 1px ${accent}66`
        : "0 1px 2px rgba(0,0,0,0.4)",
    overflow: "hidden",
  };
}

// Callable pins are visible typed connectors; non-callable leaves keep them subtle.
function pinStyle(callable: boolean): React.CSSProperties {
  return {
    background: callable ? "#56C271" : "#3A414C",
    width: callable ? 9 : 7,
    height: callable ? 9 : 7,
    border: "none",
  };
}

const CODE_BUTTON_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 8,
  zIndex: 2,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: 1,
  color: "#7B8695",
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 5,
  padding: "1px 5px",
  cursor: "pointer",
};
const CODE_BUTTON_HOVER_STYLE: React.CSSProperties = {
  ...CODE_BUTTON_STYLE,
  color: "#56C271",
  borderColor: "#56C271",
};

const BODY_STYLE: React.CSSProperties = { padding: "6px 12px 10px" };
const SUMMARY_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: "15px" };
const SIGNATURE_STYLE: React.CSSProperties = {
  display: "block",
  marginTop: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#C9D3E0",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const INLINE_PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  marginTop: 6,
  width: "min(440px, 150%)",
  maxHeight: 200,
  overflow: "auto",
  zIndex: 5,
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  cursor: "default",
};
const INLINE_HEADER_STYLE: React.CSSProperties = {
  position: "sticky",
  top: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 8px",
  background: "#161B22",
  borderBottom: "1px solid #2A2F37",
};
const INLINE_LOCATION_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "#7B8695",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const INLINE_ICON_STYLE: React.CSSProperties = {
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
const INLINE_BODY_STYLE: React.CSSProperties = { padding: 8 };
const INLINE_STATUS_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695" };
const INLINE_ERROR_STYLE: React.CSSProperties = { fontSize: 11, color: "#f2777a" };
const INLINE_TRUNCATED_STYLE: React.CSSProperties = { marginTop: 6, fontSize: 10, color: "#7B8695" };
const INLINE_LISTING_STYLE: React.CSSProperties = {
  display: "flex",
  gap: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  lineHeight: "16px",
};
const INLINE_GUTTER_STYLE: React.CSSProperties = {
  margin: 0,
  textAlign: "right",
  color: "#4A525F",
  userSelect: "none",
  whiteSpace: "pre",
};
const INLINE_CODE_STYLE: React.CSSProperties = {
  margin: 0,
  flex: 1,
  color: "#C9D3E0",
  whiteSpace: "pre",
  overflowX: "auto",
};
