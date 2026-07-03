/**
 * A container node (package/module/class with children). Collapsed it is a solid box showing
 * "N items"; expanded it is a titled frame whose transparent body lets React Flow draw the
 * child sub-flow inside it. The header is the expand/collapse toggle.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../theme/kindColors";
import { ellipsize } from "../../theme/displayName";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintNode } from "../../layout/rfTypes";
import { NodeHeader } from "./NodeHeader";
import { TelemetryBadges } from "../TelemetryBadges";
import { ChangePill } from "../ChangePill";
import { CommentBadge } from "../CommentBadge";

export function ContainerNode(props: NodeProps<BlueprintNode>) {
  const { node, isExpanded, childCount } = props.data;
  const accent = accentForKind(node.kind);
  const metrics = useBlueprint((state) => state.telemetry[props.id]);
  const selected = useBlueprint((state) => state.selectedId === props.id);
  // Dim when a path trace is active and this frame is not on it (ancestors of path nodes stay lit).
  const dimmed = useBlueprint((state) => state.pathNodeIds.size > 0 && !state.pathNodeIds.has(props.id));
  const changeEntry = useBlueprint((state) => state.changeRollup.get(props.id));
  const commentCount = useBlueprint((state) => state.commentCounts.get(props.id) ?? 0);
  const toggleExpand = useBlueprintActions().toggleExpand;
  return (
    <div style={{ ...frameStyle(accent, isExpanded, selected), ...dimStyle(dimmed) }}>
      <Handle type="target" position={Position.Left} id="in" style={HANDLE_STYLE} />
      <NodeHeader
        node={node}
        accent={accent}
        chevron={isExpanded ? "expanded" : "collapsed"}
        count={childCount}
        trailing={
          <>
            {changeEntry ? <ChangePill entry={changeEntry} /> : null}
            {commentCount > 0 ? <CommentBadge count={commentCount} /> : null}
          </>
        }
        onToggle={() => toggleExpand(props.id)}
      >
        <TelemetryBadges metrics={metrics} />
      </NodeHeader>
      {!isExpanded && node.summary ? <CollapsedBody summary={node.summary} /> : null}
      <Handle type="source" position={Position.Right} id="out" style={HANDLE_STYLE} />
    </div>
  );
}

function CollapsedBody(props: { summary: string }) {
  return (
    <div style={BODY_STYLE}>
      <div style={SUMMARY_STYLE}>{ellipsize(props.summary, 84)}</div>
    </div>
  );
}

function frameStyle(accent: string, isExpanded: boolean, selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: `1px solid ${selected ? accent : "#2A2F37"}`,
    // Expanded frames stay near-transparent so nested children read as "inside" the box.
    background: isExpanded ? "rgba(18,21,27,0.55)" : "#161A21",
    boxShadow: selected ? `0 0 0 1px ${accent}66` : "0 1px 2px rgba(0,0,0,0.4)",
    overflow: "hidden",
  };
}

function dimStyle(dimmed: boolean): React.CSSProperties {
  return {
    opacity: dimmed ? 0.25 : 1,
    filter: dimmed ? "saturate(0.5)" : undefined,
    transition: "opacity 140ms, filter 140ms",
  };
}

const HANDLE_STYLE: React.CSSProperties = { background: "#3A414C", width: 7, height: 7, border: "none" };
const BODY_STYLE: React.CSSProperties = { padding: "5px 12px 7px" };
const SUMMARY_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: "#9AA4B2",
  lineHeight: "15px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
