/**
 * The member list a Service-composition scorecard shows: the unit's methods/functions, each a
 * click-through into that member's own logic flow — the composition→logic link, the reverse of a
 * logic block's owning-unit chip. Capped at MEMBERS_SHOWN with a quiet "+N more" line so a large
 * unit's card stays bounded; the card height reserves exactly this band (compositionGraph's sizeFor).
 *
 * Gesture (mirrors the app's select-vs-navigate norm): a SINGLE click PREVIEWS the method's logic
 * flow in the composition-tab side drawer (`selectCompMethod`) — a peek WITHOUT leaving the tab; a
 * DOUBLE click NAVIGATES to the full Logic tab (`openLogicFlow`), the deliberate travel gesture.
 * The highlighted row echoes which method the open drawer is charting.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { MEMBERS_SHOWN } from "../../derive/compositionGraph";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function CompositionMembers({ members }: { members: { id: string; name: string }[] }) {
  const { selectCompMethod, openLogicFlow } = useBlueprintActions();
  const previewedId = useBlueprint((state) => state.compMethodId);
  const shown = members.slice(0, MEMBERS_SHOWN);
  const remaining = members.length - shown.length;
  return (
    <div style={WRAP}>
      <div style={HEADER}>members</div>
      {shown.map((member) => (
        <button
          key={member.id}
          type="button"
          style={member.id === previewedId ? ROW_ACTIVE : ROW}
          title={`Click to preview ${member.name} — double-click to open its logic flow`}
          // SINGLE click previews in the docked drawer; DOUBLE click navigates to the full Logic tab.
          // stopPropagation on BOTH is REQUIRED — otherwise the click/dblclick also fires the card's
          // onNodeClick/onNodeDoubleClick, which select/re-root the composition view.
          onClick={(event) => {
            event.stopPropagation();
            selectCompMethod(member.id);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            openLogicFlow(member.id);
          }}
        >
          <span style={GLYPH}>ƒ</span>
          <span style={NAME} title={member.name}>{member.name}</span>
        </button>
      ))}
      {remaining > 0 ? <div style={MORE}>+{remaining} more</div> : null}
    </div>
  );
}

const WRAP: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1, marginTop: 2 };
const HEADER: React.CSSProperties = { fontSize: 8.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#565F6B", marginBottom: 1 };
const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  width: "100%",
  padding: "1px 4px",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "#9AA4B2",
  fontFamily: MONO,
  fontSize: 10,
  cursor: "pointer",
  textAlign: "left",
};
// The previewed row wears the composition select-green so the card echoes which method the open
// drawer is charting (mirrors the unit selection ring / logic node highlight).
const ROW_ACTIVE: React.CSSProperties = { ...ROW, background: "rgba(107,227,138,0.14)", color: "#CFE9D6" };
const GLYPH: React.CSSProperties = { fontSize: 9, color: "#5E74C6", flexShrink: 0 };
const NAME: React.CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const MORE: React.CSSProperties = { fontSize: 9, color: "#565F6B", padding: "0 4px" };
