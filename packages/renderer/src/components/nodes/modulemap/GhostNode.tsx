/**
 * A GHOST card on the Map: a definition (or caller) a drawn code node is coupled to that is NOT on
 * this level — the relationship would otherwise silently vanish when its lift walks off the canvas.
 * Wears the Logic tab's ghost dialect (dashed border, muted fill, name + faint home file) so it
 * reads as detached context, never a peer card. Its node id IS the real artifact id, so selecting
 * it lights the directed reach like any code node; double-clicking REVEALS the definition (the Map
 * refocuses where it lives, with its file open and the symbol selected).
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind, glyphForKind } from "../../../theme/kindColors";
import type { GhostData } from "../../../derive/ghostDeps";
import { MONO, PIN, SELECT_ACCENT } from "./frameChrome";

type GhostRfNode = Node<GhostData, "ghost">;

function GhostNodeImpl({ id, data }: NodeProps<GhostRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  return (
    <div style={selected ? GHOST_SELECTED : GHOST} title={`${data.label} — off-screen; double-click to reveal it`}>
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <div style={HEAD}>
        <span style={{ ...GLYPH, color: accentForKind(data.ghostKind) }}>{ghostGlyph(data.ghostKind)}</span>
        <span style={LABEL}>{data.label}</span>
      </div>
      {data.context ? <div style={CONTEXT}>{data.context}</div> : null}
    </div>
  );
}

export const GhostNode = memo(GhostNodeImpl);

/** Callable ghosts wear the block glyphs (ƒ/τ); units keep the shared kind glyphs (◆/◇/❑). */
function ghostGlyph(kind: string): string {
  if (kind === "method" || kind === "function") {
    return "ƒ";
  }
  if (kind === "typeAlias" || kind === "enum") {
    return "τ";
  }
  return glyphForKind(kind);
}

const GHOST: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  border: "1px dashed #4B535F",
  borderRadius: 8,
  background: "rgba(16,21,28,0.6)",
  padding: "4px 9px",
  fontFamily: MONO,
  display: "flex",
  flexDirection: "column",
  gap: 1,
  overflow: "hidden",
  cursor: "pointer",
};
const GHOST_SELECTED: React.CSSProperties = { ...GHOST, borderColor: SELECT_ACCENT, boxShadow: `0 0 0 2px ${SELECT_ACCENT}` };
const HEAD: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, minWidth: 0 };
const GLYPH: React.CSSProperties = { fontSize: 9.5, flexShrink: 0, opacity: 0.8 };
const LABEL: React.CSSProperties = {
  minWidth: 0,
  fontSize: 11,
  color: "#9AA4B2",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CONTEXT: React.CSSProperties = {
  fontSize: 9,
  color: "#565E68",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
