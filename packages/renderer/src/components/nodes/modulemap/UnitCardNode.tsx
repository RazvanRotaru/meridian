/**
 * A unit card for the Map lens: one class/interface/object nested inside its file frame — the level
 * the old Service-composition tab drew, merged into the Map's drill-down. The card answers three
 * questions in order: WHAT this is (kind glyph + name), WHAT IT DOES (its methods — each row is the
 * map→logic link: clicking opens that method's logic flow), and WHAT IT NEEDS (its service
 * dependencies — the units whose definitions its violet wires point at; selecting the card lights
 * them). Row caps mirror the layout's reserved bands so the card never clips.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint, useBlueprintActions } from "../../../state/StoreContext";
import { accentForKind, glyphForKind } from "../../../theme/kindColors";
import type { UnitCardData } from "../../../derive/moduleLevel";
import { UNIT_DEPS_SHOWN, UNIT_MEMBERS_SHOWN } from "../../../layout/moduleLevelLayout";
import { MONO, PIN, SELECT_ACCENT } from "./frameChrome";

// The dependency violet shared with the unit-dependency wires, so the "uses" rows and the lit
// edges to the definitions read as one story.
const DEP_ACCENT = "#A78BFA";

type UnitRfNode = Node<UnitCardData, "unit">;

function UnitCardNodeImpl({ id, data }: NodeProps<UnitRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelectedId) === id;
  const openLogicFlow = useBlueprintActions().openLogicFlow;
  const accent = accentForKind(data.unitKind);
  const methods = data.members.slice(0, UNIT_MEMBERS_SHOWN);
  const deps = data.deps.slice(0, UNIT_DEPS_SHOWN);
  return (
    <div style={selected ? CARD_SELECTED : CARD}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={{ ...ACCENT_BAR, background: accent }} />
      <div style={INNER}>
        <div style={HEADER}>
          <span style={{ ...GLYPH, color: accent }}>{glyphForKind(data.unitKind)}</span>
          <span style={LABEL} title={id}>{data.label}</span>
          <span style={{ ...KIND_CHIP, color: accent, borderColor: accent }}>{data.unitKind.toUpperCase()}</span>
        </div>
        {methods.length > 0 ? (
          <div style={SECTION}>
            <div style={SECTION_HEADER}>methods</div>
            {methods.map((member) => (
              <button
                key={member.id}
                type="button"
                style={METHOD_ROW}
                title={`Open the logic flow of ${member.name}`}
                // stopPropagation so the click doesn't also select the card (onNodeClick).
                onClick={(event) => {
                  event.stopPropagation();
                  openLogicFlow(member.id);
                }}
              >
                <span style={METHOD_GLYPH}>ƒ</span>
                <span style={ROW_NAME} title={member.name}>{member.name}</span>
              </button>
            ))}
            {data.members.length > methods.length ? <div style={MORE}>+{data.members.length - methods.length} more</div> : null}
          </div>
        ) : null}
        {deps.length > 0 ? (
          <div style={SECTION}>
            <div style={SECTION_HEADER}>uses</div>
            {deps.map((dep) => (
              <div key={dep.id} style={DEP_ROW} title={dep.id}>
                <span style={DEP_GLYPH}>→</span>
                <span style={ROW_NAME} title={dep.label}>{dep.label}</span>
              </div>
            ))}
            {data.deps.length > deps.length ? <div style={MORE}>+{data.deps.length - deps.length} more</div> : null}
          </div>
        ) : null}
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
const CARD_SELECTED: React.CSSProperties = { ...CARD, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const ACCENT_BAR: React.CSSProperties = { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 };
const INNER: React.CSSProperties = { display: "flex", flexDirection: "column", height: "100%", padding: "8px 10px 6px 12px", boxSizing: "border-box" };
const HEADER: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 24, marginBottom: 4 };
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
const SECTION: React.CSSProperties = { display: "flex", flexDirection: "column" };
const SECTION_HEADER: React.CSSProperties = {
  height: 16,
  boxSizing: "border-box",
  paddingTop: 4,
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#565F6B",
};
const METHOD_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  width: "100%",
  height: 15,
  boxSizing: "border-box",
  padding: "0 4px",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "#9AA4B2",
  fontFamily: MONO,
  fontSize: 10,
  cursor: "pointer",
  textAlign: "left",
};
const DEP_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, height: 15, boxSizing: "border-box", padding: "0 4px", fontSize: 10, color: "#9AA4B2" };
const METHOD_GLYPH: React.CSSProperties = { fontSize: 9, color: "#5E74C6", flexShrink: 0 };
const DEP_GLYPH: React.CSSProperties = { fontSize: 9, color: DEP_ACCENT, flexShrink: 0 };
const ROW_NAME: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const MORE: React.CSSProperties = { fontSize: 9, color: "#565F6B", padding: "0 4px", height: 12, boxSizing: "border-box" };
