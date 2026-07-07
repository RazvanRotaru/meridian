/**
 * A unit for the Map lens: one class/interface/object — the service definition. With members it is
 * a titled FRAME whose method nodes nest inside (methods are first-class nodes, so wires attach to
 * the specific code that uses a dependency, and logic flows can later chart in place); memberless
 * it is a compact identity card. Deliberately identity-only — no metric rows, no uses list: what
 * the unit depends on is the violet wires' story, not the card's. A green ring marks selection.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind, glyphForKind } from "../../../theme/kindColors";
import type { UnitCardData } from "../../../derive/moduleLevel";
import { frameSelectedStyle, frameStyle, MONO, PIN, SELECT_ACCENT } from "./frameChrome";

type UnitRfNode = Node<UnitCardData, "unit">;

function UnitCardNodeImpl({ id, data }: NodeProps<UnitRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const accent = accentForKind(data.unitKind);

  const identity = (
    <>
      <span style={{ ...GLYPH, color: accent }}>{glyphForKind(data.unitKind)}</span>
      <span style={LABEL} title={id}>{data.label}</span>
      <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{data.unitKind.toUpperCase()}</span>
    </>
  );

  if (data.isFrame) {
    return (
      <div style={selected ? frameSelectedStyle(accent) : frameStyle(accent)}>
        <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
        <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
        <div style={TITLE_BAR}>{identity}</div>
      </div>
    );
  }

  return (
    <div style={selected ? CARD_SELECTED : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={INNER}>{identity}</div>
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
const CARD_SELECTED: React.CSSProperties = { ...CARD, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, height: "100%", padding: "0 10px 0 12px" };
// A slightly shorter title bar than the file/package frames — a unit frame is an inner structure.
const TITLE_BAR: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  height: 28,
  padding: "0 10px",
  borderBottom: "1px solid #232935",
  background: "rgba(23,29,38,0.9)",
};
const GLYPH: React.CSSProperties = { fontSize: 11, flexShrink: 0 };
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
const KIND_CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "1px solid",
  borderRadius: 3,
  padding: "1px 4px",
};
