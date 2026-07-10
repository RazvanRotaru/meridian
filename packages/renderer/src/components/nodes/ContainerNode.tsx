/**
 * A container node (package/module/class with children). Collapsed it is a solid box showing
 * "N items"; expanded it is a titled frame whose transparent body lets React Flow draw the
 * child sub-flow inside it. The header is the expand/collapse toggle.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { accentForKind } from "../../theme/kindColors";
import { coverageAccent } from "../../theme/coverageColors";
import { ellipsize } from "../../theme/displayName";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { BlueprintNode } from "../../layout/rfTypes";
import { NodeHeader } from "./NodeHeader";
import { TelemetryBadges } from "../TelemetryBadges";
import { CoverageBadge } from "../CoverageBadge";
import { changedColor, changedFill } from "../ChangedBadge";

export function ContainerNode(props: NodeProps<BlueprintNode>) {
  const { node, isExpanded, childCount } = props.data;
  const coverage = useBlueprint((state) => (state.coverageMode ? state.coverage : null));
  const accent = coverage ? coverageAccent(props.id, coverage) : accentForKind(node.kind);
  const metrics = useBlueprint((state) => state.telemetry[props.id]);
  const selected = useBlueprint((state) => state.selectedId === props.id);
  const isEntry = useBlueprint((state) => state.flowRootId === props.id);
  const toggleExpand = useBlueprintActions().toggleExpand;
  // Only a directly-changed CODE BLOCK rings, in its status colour (green added / gold modified / red
  // deleted). A file/module/package container that merely CONTAINS changes is left uncoloured — its
  // changed children carry the highlight instead.
  const changedStatus = useBlueprint((state) => state.index.changedStatus.get(props.id));
  const changed = changedStatus !== undefined;
  const changedRing = changedColor(changedStatus);
  return (
    <div style={frameStyle(accent, isExpanded, selected, isEntry, changed, changedRing)}>
      <Handle type="target" position={Position.Left} id="in" style={HANDLE_STYLE} />
      <NodeHeader
        node={node}
        accent={accent}
        entry={isEntry}
        chevron={isExpanded ? "expanded" : "collapsed"}
        onToggle={() => toggleExpand(props.id)}
      >
        <TelemetryBadges metrics={metrics} />
        <CoverageBadge nodeId={props.id} />
      </NodeHeader>
      {isExpanded ? null : <CollapsedBody summary={node.summary} childCount={childCount} accent={accent} />}
      <Handle type="source" position={Position.Right} id="out" style={HANDLE_STYLE} />
    </div>
  );
}

function CollapsedBody(props: { summary: string | null | undefined; childCount: number; accent: string }) {
  return (
    <div style={BODY_STYLE}>
      <div style={{ ...COUNT_STYLE, color: props.accent }}>{props.childCount} items</div>
      {props.summary ? <div style={SUMMARY_STYLE}>{ellipsize(props.summary, 84)}</div> : null}
    </div>
  );
}

// Ring precedence mirrors LeafNode: entry > selected > changed.
function frameStyle(
  accent: string,
  isExpanded: boolean,
  selected: boolean,
  isEntry: boolean,
  changed: boolean,
  changedRing: string,
): React.CSSProperties {
  return {
    width: "100%",
    height: "100%",
    boxSizing: "border-box",
    borderRadius: 10,
    border: isEntry ? "2px solid #56C271" : `1px solid ${selected ? accent : changed ? changedRing : "#2A2F37"}`,
    // Expanded frames stay near-transparent so nested children read as "inside" the box.
    background: isExpanded
      ? (changed ? changedFill(changedRing) : "rgba(18,21,27,0.55)")
      : changed ? `linear-gradient(0deg, ${changedFill(changedRing)}, ${changedFill(changedRing)}), #161A21` : "#161A21",
    boxShadow: isEntry
      ? "0 0 0 3px rgba(86,194,113,0.30)"
      : selected
        ? `0 0 0 1px ${accent}66`
        : changed
          ? `0 0 0 1px ${changedRing}44`
          : "0 1px 2px rgba(0,0,0,0.4)",
    overflow: "hidden",
  };
}

const HANDLE_STYLE: React.CSSProperties = { background: "#3A414C", width: 7, height: 7, border: "none" };
const BODY_STYLE: React.CSSProperties = { padding: "8px 12px 10px" };
const COUNT_STYLE: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const SUMMARY_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", marginTop: 4, lineHeight: "15px" };
