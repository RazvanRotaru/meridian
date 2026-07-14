/**
 * A GHOST card on the Map: a definition (or caller) a drawn code node is coupled to that is NOT on
 * this level — the relationship would otherwise silently vanish when its lift walks off the canvas.
 * Wears the Logic tab's ghost dialect (dashed border, muted fill, name + faint home file) so it
 * reads as detached context, never a peer card. A single click uses the graph's ordinary selection
 * contract and a double-click REVEALS its definition. A crowded sibling set reuses its real parent
 * ghost as a persistent anchor: hover/focus previews the exact children, while its dedicated
 * chevron expands/collapses their neutral neighbour spokes. The card itself still selects/navigates
 * like every other node.
 */

import { memo, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { useSurfaceNodeSelected, useSurfaceReadOnly } from "../../canvas/SurfaceInteractionContext";
import { accentForKind } from "../../../theme/kindColors";
import type { GhostData } from "../../../derive/ghostDeps";
import { cardSelectedStyle, MONO, PIN, SELECT_ACCENT } from "./frameChrome";
import { BaseNode, type BaseNodeModel } from "../BaseNode";

type GhostViewData = GhostData & {
  ghostRole?: "parent-anchor";
  ghostExpanded?: boolean;
};
type GhostRfNode = Node<GhostViewData, "ghost">;

function GhostNodeImpl({ id, data }: NodeProps<GhostRfNode>) {
  const selected = useSurfaceNodeSelected(id);
  const readOnly = useSurfaceReadOnly();
  const [previewed, setPreviewed] = useState(false);
  const groupMembers = data.semanticMembers ?? [];
  const isGroup = data.ghostRole === "parent-anchor" && typeof data.ghostGroupId === "string" && groupMembers.length > 0;
  const groupExpanded = isGroup && data.ghostExpanded === true;
  const accent = accentForKind(data.ghostKind);
  const glyph = ghostGlyph(data.ghostKind);
  // Plain selection wears the ghost's OWN accent (heavier); a BEACON — a selected call step's
  // definition — keeps the green marker so it stands out as the thing pointed at.
  const style = selected ? cardSelectedStyle(GHOST, accent) : data.beacon ? GHOST_BEACON : GHOST;
  const actionLabel = readOnly
    ? `${data.label}, ${data.ghostKind}, related code outside this context`
    : isGroup
      ? `${data.label}, parent of ${groupMembers.length} related ghost nodes; click to select, double-click to reveal`
      : `${data.label}, ${data.ghostKind}, off-screen definition; double-click to reveal`;
  const model: BaseNodeModel = {
    instanceId: id,
    targetId: id,
    nodeType: "ghost",
    kind: data.ghostKind,
    label: data.label,
    childCount: groupMembers.length,
    canExpand: isGroup && !readOnly,
    expanded: groupExpanded,
    canNavigate: !readOnly,
    data,
  };
  const domAttributes: React.HTMLAttributes<HTMLDivElement> = {
    // The card remains one focusable selection surface, but it is a group rather than a button:
    // grouped ghosts contain BaseNode's native disclosure button and nested interactive roles are
    // otherwise ambiguous to assistive technology.
    role: readOnly ? undefined : "group",
    tabIndex: readOnly ? undefined : 0,
    "aria-label": readOnly ? actionLabel : `${selected ? "Selected, " : ""}${actionLabel}`,
    onMouseEnter: () => isGroup && setPreviewed(true),
    onMouseLeave: () => setPreviewed(false),
    onFocus: () => isGroup && setPreviewed(true),
    onBlur: () => setPreviewed(false),
    onKeyDown: readOnly ? undefined : (event) => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        // React Flow owns the node click handler on the wrapper. A native click from the focused
        // card bubbles through that same path, so keyboard and pointer inspection stay identical.
        event.currentTarget.click();
      }
    },
  };
  return (
    <BaseNode
      model={model}
      className="lod-tint"
      style={{ ...style, ...(isGroup ? GROUP_FRAME : null), "--lod-accent": accent } as React.CSSProperties}
      title={readOnly
        ? `${data.label} — related code outside this context`
        : isGroup
        ? `${data.label} — ${groupMembers.length} related ghosts; double-click to reveal the parent definition`
        : `${data.label} — off-screen; double-click to reveal it`}
      headerStyle={HEAD}
      labelStyle={LABEL}
      labelContent={middleTruncate(data.label)}
      leading={glyph === null ? undefined : <span style={{ ...GLYPH, color: accent }}>{glyph}</span>}
      ports={(
        <>
          <Handle type="target" position={Position.Left} style={PIN} isConnectable={false} />
          <Handle type="source" position={Position.Right} style={PIN} isConnectable={false} />
          <span className="lod-place">{middleTruncate(data.label)}</span>
        </>
      )}
      domAttributes={domAttributes}
    >
      {data.context ? <div className="lod-card-body" style={CONTEXT}>{data.context}</div> : null}
      {isGroup && previewed && !readOnly ? (
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
    </BaseNode>
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
