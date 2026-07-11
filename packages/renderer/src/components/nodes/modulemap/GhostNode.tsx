/**
 * A GHOST card on the Map: a definition (or caller) a drawn code node is coupled to that is NOT on
 * this level — the relationship would otherwise silently vanish when its lift walks off the canvas.
 * Wears the Logic tab's ghost dialect (dashed border, muted fill, name + faint home file) so it
 * reads as detached context, never a peer card. An exact ghost's single click gives it a transient
 * blue inspection ring without disturbing the selected core node or moving the surrounding ghosts;
 * double-click REVEALS its definition. A crowded sibling set reuses its real parent ghost as a
 * persistent anchor: hover/focus previews the exact children and click expands/collapses their
 * neutral neighbour spokes without navigating or changing the primary selection.
 */

import { memo, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useBlueprint } from "../../../state/StoreContext";
import { accentForKind } from "../../../theme/kindColors";
import type { GhostData } from "../../../derive/ghostDeps";
import { cardSelectedStyle, MONO, PIN, SELECT_ACCENT } from "./frameChrome";

type GhostViewData = GhostData & {
  inspected?: boolean;
  ghostRole?: "parent-anchor";
  ghostExpanded?: boolean;
};
type GhostRfNode = Node<GhostViewData, "ghost">;

function GhostNodeImpl({ id, data }: NodeProps<GhostRfNode>) {
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  const [previewed, setPreviewed] = useState(false);
  const groupMembers = data.semanticMembers ?? [];
  const isGroup = data.ghostRole === "parent-anchor" && typeof data.ghostGroupId === "string" && groupMembers.length > 0;
  const groupExpanded = isGroup && data.ghostExpanded === true;
  const accent = accentForKind(data.ghostKind);
  // Plain selection wears the ghost's OWN accent (heavier); a BEACON — a selected call step's
  // definition — keeps the green marker so it stands out as the thing pointed at.
  const style = data.inspected ? GHOST_INSPECTED : selected ? cardSelectedStyle(GHOST, accent) : data.beacon ? GHOST_BEACON : GHOST;
  const actionLabel = isGroup
    ? `${data.label}, parent of ${groupMembers.length} related ghost nodes; click to ${groupExpanded ? "collapse" : "expand"}`
    : `${data.label}, ${data.ghostKind}, off-screen definition; double-click to reveal`;
  return (
    <div
      className="lod-tint"
      role="button"
      tabIndex={0}
      {...(isGroup ? { "aria-expanded": groupExpanded } : { "aria-pressed": data.inspected === true })}
      aria-label={actionLabel}
      onMouseEnter={() => isGroup && setPreviewed(true)}
      onMouseLeave={() => setPreviewed(false)}
      onFocus={() => isGroup && setPreviewed(true)}
      onBlur={() => setPreviewed(false)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          // React Flow owns the node click handler on the wrapper. A native click from the focused
          // card bubbles through that same path, so keyboard and pointer inspection stay identical.
          event.currentTarget.click();
        }
      }}
      style={{ ...style, ...(isGroup ? GROUP_FRAME : null), "--lod-accent": accent } as React.CSSProperties}
      title={isGroup
        ? `${data.label} — ${groupMembers.length} related ghosts; click to ${groupExpanded ? "collapse" : "expand"}`
        : `${data.label} — off-screen; double-click to reveal it`}
    >
      <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
      <span className="lod-place">{middleTruncate(data.label)}</span>
      <div className="lod-card-body" style={HEAD}>
        {ghostGlyph(data.ghostKind) !== null && <span style={{ ...GLYPH, color: accent }}>{ghostGlyph(data.ghostKind)}</span>}
        <span style={LABEL}>{middleTruncate(data.label)}</span>
      </div>
      {data.context ? <div className="lod-card-body" style={CONTEXT}>{data.context}</div> : null}
      {isGroup && previewed ? (
        <div role="tooltip" style={GROUP_PREVIEW}>
          <div style={GROUP_PREVIEW_TITLE}>
            {groupMembers.length} related definitions · {groupExpanded ? "expanded" : "collapsed"}
          </div>
          {groupMembers.map((member) => (
            <div key={member.id} style={GROUP_PREVIEW_ROW}>
              <span style={GROUP_PREVIEW_NAME}>{member.data.label}</span>
              <span style={GROUP_PREVIEW_KIND}>{member.data.ghostKind}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A folder-path label keeps BOTH ends when it must shrink — `src/packages/…/vscode/host` beats
 * `src/packages/autopilot-vsc…` (tail-ellipsis kills the segment that actually identifies it).
 * The hover title always carries the full path. */
const LABEL_MAX = 46;
function middleTruncate(label: string): string {
  if (label.length <= LABEL_MAX) {
    return label;
  }
  const head = Math.ceil((LABEL_MAX - 1) * 0.55);
  const tail = LABEL_MAX - 1 - head;
  return `${label.slice(0, head)}…${label.slice(label.length - tail)}`;
}

export const GhostNode = memo(GhostNodeImpl);

/** Callable ghosts wear the letter glyphs (ƒ/τ); unit kinds show the bare name — the ◆/◇/❑ kind
 * glyph vocabulary is retired everywhere in favour of textual labels. */
function ghostGlyph(kind: string): string | null {
  if (kind === "method" || kind === "function") {
    return "ƒ";
  }
  if (kind === "typeAlias" || kind === "enum") {
    return "τ";
  }
  return null;
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
const GHOST_BEACON: React.CSSProperties = { ...GHOST, borderColor: SELECT_ACCENT };
// Blue and still dashed: this is transient inspection, visibly different from the neutral solid
// selection ring and the green definition beacon.
const INSPECT_ACCENT = "#78A9FF";
const GHOST_INSPECTED: React.CSSProperties = {
  ...GHOST,
  borderColor: INSPECT_ACCENT,
  background: "rgba(31,43,67,0.78)",
  boxShadow: `0 0 0 2px ${INSPECT_ACCENT}66`,
};
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
const GROUP_FRAME: React.CSSProperties = { position: "relative", overflow: "visible" };
const GROUP_PREVIEW: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 7px)",
  left: 0,
  zIndex: 20,
  width: 310,
  maxHeight: 230,
  overflowY: "auto",
  boxSizing: "border-box",
  border: "1px solid #3A4452",
  borderRadius: 7,
  background: "rgba(14,18,24,0.98)",
  boxShadow: "0 10px 28px rgba(0,0,0,0.42)",
  padding: 7,
  color: "#AEB8C6",
};
const GROUP_PREVIEW_TITLE: React.CSSProperties = { padding: "2px 4px 6px", fontSize: 9.5, color: "#7E8998" };
const GROUP_PREVIEW_ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "4px" };
const GROUP_PREVIEW_NAME: React.CSSProperties = { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10 };
const GROUP_PREVIEW_KIND: React.CSSProperties = { flexShrink: 0, color: "#667383", fontSize: 9, textTransform: "lowercase" };
