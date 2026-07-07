/**
 * A leaf node (no children): a function/method, or any childless declaration. Function and
 * method nodes reveal their monospace signature and typed input/output pins (the left/right
 * handles), so a reader sees what flows in and what flows out of the unit.
 */

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../theme/kindColors";
import { coverageAccent } from "../../theme/coverageColors";
import { ellipsize } from "../../theme/displayName";
import { isCallable } from "../../layout/nodeSize";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintNode } from "../../layout/rfTypes";
import { CodeInlinePanel } from "../CodeInlinePanel";
import { NodeHeader } from "./NodeHeader";
import { TelemetryBadges } from "../TelemetryBadges";
import { CoverageBadge } from "../CoverageBadge";

export function LeafNode(props: NodeProps<BlueprintNode>) {
  const node = props.data.node;
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const accent = coverage ? coverageAccent(props.id, coverage) : accentForKind(node.kind);
  const metrics = useBlueprint((state) => state.telemetry[props.id]);
  const selected = useBlueprint((state) => state.selectedId === props.id);
  const isEntry = useBlueprint((state) => state.flowRootId === props.id);
  const sourceUrl = useBlueprint((state) => state.sourceUrl);
  const codeView = useBlueprint((state) => state.codeView);
  const commentCount = useBlueprint((state) => state.comments?.[node.location?.file ?? ""]?.length ?? 0);
  const { showCode, expandCode, closeCode, openComments } = useBlueprintActions();
  const callable = isCallable(node.kind);
  // Offer the source button only for a callable whose location the server can actually serve.
  const canShowCode = callable && Boolean(node.location) && Boolean(sourceUrl);
  const showingHere = codeView?.node.id === node.id;
  const toggleCode = () => (showingHere ? closeCode() : void showCode(node));
  // The comments badge shows the FILE's PR-comment count (review comments anchor to files, not
  // callables); both corner controls present widens the header's reserved right edge.
  const showComments = commentCount > 0 && Boolean(node.location);
  const reserveRight = canShowCode && showComments ? 76 : canShowCode || showComments ? 34 : false;
  return (
    // A fragment, not a lone card: the inline panel is a SIBLING of the card so the card's
    // overflow:hidden can't clip it. Both live inside React Flow's node wrapper, which is the
    // positioned box the panel's top:100% anchors to (it exactly equals the card's box).
    <>
      <div style={cardStyle(accent, selected, isEntry)}>
        <Handle type="target" position={Position.Left} id="in" style={pinStyle(callable)} />
        {canShowCode ? <CodeButton active={showingHere} onToggle={toggleCode} /> : null}
        {showComments ? (
          <CommentsButton
            count={commentCount}
            offsetRight={canShowCode ? 42 : 8}
            onOpen={() => openComments(node.location.file)}
          />
        ) : null}
        <NodeHeader node={node} accent={accent} entry={isEntry} reserveRight={reserveRight}>
          <TelemetryBadges metrics={metrics} />
          <CoverageBadge nodeId={props.id} />
        </NodeHeader>
        <div style={BODY_STYLE}>
          {node.summary ? <div style={SUMMARY_STYLE}>{ellipsize(node.summary, 96)}</div> : null}
          {callable && node.signature ? <code style={SIGNATURE_STYLE}>{node.signature}</code> : null}
        </div>
        <Handle type="source" position={Position.Right} id="out" style={pinStyle(callable)} />
      </div>
      {codeView && showingHere && codeView.mode === "inline" ? (
        <CodeInlinePanel codeView={codeView} onExpand={expandCode} onClose={closeCode} showGutter />
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

// The 💬 corner control mirrors CodeButton: absolutely positioned, click swallowed off the
// node's select/dive handlers, opening the file's PR-comments modal.
function CommentsButton(props: { count: number; offsetRight: number; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const label = `${props.count} PR review comment${props.count === 1 ? "" : "s"}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ ...(hover ? CODE_BUTTON_HOVER_STYLE : CODE_BUTTON_STYLE), right: props.offsetRight }}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      💬{props.count}
    </button>
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
