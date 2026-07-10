/**
 * A unit for the Map lens: one class/interface/object — the service definition. With members it is
 * an expandable card that can become a titled FRAME whose method nodes nest inside (methods are
 * first-class nodes, so wires attach to the specific code that uses a dependency, and logic flows
 * can later chart in place); memberless it is a compact identity card. Deliberately light-weight:
 * dependencies are the violet wires' story, not the card's. A green ring marks selection.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind } from "../../../theme/kindColors";
import type { UnitCardData } from "../../../derive/moduleLevel";
import { cardSelectedStyle, CodeButton, ExpandChevron, FrameTitleBar, frameSelectedStyle, frameStyle, MONO, PIN } from "./frameChrome";
import { borderFor, DeltaChip, useNodeDiff } from "./changed";

type UnitRfNode = Node<UnitCardData, "unit">;

function UnitCardNodeImpl({ id, data }: NodeProps<UnitRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const diff = useNodeDiff(id);
  const accent = accentForKind(data.unitKind);
  const chevron = data.isContainer ? (
    <ExpandChevron id={id} isExpanded={data.isExpanded} collapsedTitle={`Expand — ${data.memberCount} member(s) in this unit`} />
  ) : null;

  // The uppercase kind chip is the ONE kind marker — the old ◆/◇/❑ glyphs are retired.
  const identity = (
    <>
      <span style={LABEL} title={id}>{data.label}</span>
      <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{data.unitKind.toUpperCase()}</span>
      <DeltaChip diff={diff} />
      <CodeButton id={id} />
    </>
  );

  if (data.isFrame) {
    return (
      <div style={borderFor(frameStyle(accent), frameSelectedStyle(accent), selected, diff)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <FrameTitleBar chevron={chevron}>{identity}</FrameTitleBar>
      </div>
    );
  }

  if (data.isContainer) {
    return (
      <div style={borderFor(CARD, cardSelectedStyle(CARD, accent), selected, diff)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <div style={{ ...ACCENT_BAR, background: accent }} />
        <div style={INNER_STACK}>
          <div style={HEADER}>
            {chevron}
            <span style={LABEL} title={id}>{data.label}</span>
            <DeltaChip diff={diff} />
            <CodeButton id={id} />
          </div>
          <div style={META}>
            <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{data.unitKind.toUpperCase()}</span>
            <span style={MEMBERS} title={`${data.memberCount} member declaration(s)`}>{data.memberCount} members</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={borderFor(CARD, cardSelectedStyle(CARD, accent), selected, diff)}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={INNER}>
        {identity}
      </div>
    </div>
  );
}

export const UnitCardNode = memo(UnitCardNodeImpl);

const CARD: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px solid #2A3140",
  borderRadius: 8,
  background: "#171D26",
  overflow: "hidden",
  fontFamily: MONO,
};
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, height: "100%", padding: "0 10px 0 12px" };
const INNER_STACK: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 6,
  height: "100%",
  padding: "0 10px 0 12px",
};
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
const LABEL: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const META: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, flexShrink: 0 };
const KIND_CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
const MEMBERS: React.CSSProperties = { fontSize: 10.5, color: "#9AA4B2" };
