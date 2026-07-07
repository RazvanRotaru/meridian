/**
 * The shared node header: a kind-accent rail, a title-cased display name, an optional
 * expand/collapse chevron, and a slot for telemetry badges. The header IS the toggle for
 * containers, so clicking it stops propagation (a body click selects; a header click drills).
 */

import type { ReactNode } from "react";
import type { GraphNode } from "@meridian/core";
import { titleCase } from "../../theme/displayName";

export function NodeHeader(props: {
  node: GraphNode;
  accent: string;
  entry?: boolean;
  chevron?: "collapsed" | "expanded";
  onToggle?: () => void;
  /** Reserve room at the content's right edge for card controls (the leaf's source/comments
   * buttons) so the right-aligned kind label never slides under them. `true` fits one button;
   * a number is explicit pixels for wider control rows. */
  reserveRight?: boolean | number;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      style={headerStyle(props.accent)}
      onClick={handleToggle(props.onToggle)}
      onDoubleClick={swallowDoubleClick}
    >
      <span style={{ ...RAIL_STYLE, background: props.accent }} />
      <span style={contentStyle(props.reserveRight)}>
        <span style={TITLE_ROW_STYLE}>
          {props.chevron ? <span style={CHEVRON_STYLE}>{glyph(props.chevron)}</span> : null}
          {props.entry ? <span style={ENTRY_PILL_STYLE}>ENTRY</span> : null}
          <span style={TITLE_STYLE}>{titleCase(props.node.displayName)}</span>
          <span style={{ ...KIND_STYLE, color: props.accent }}>{props.node.kind}</span>
        </span>
        {props.children}
      </span>
    </button>
  );
}

function handleToggle(onToggle?: () => void) {
  return (event: React.MouseEvent) => {
    if (!onToggle) {
      return;
    }
    event.stopPropagation();
    onToggle();
  };
}

// The header is the inline expand/collapse control, so a double-click on it must never bubble
// up to the canvas dive handler — the chevron toggles, it never dives.
function swallowDoubleClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

function glyph(chevron: "collapsed" | "expanded"): string {
  return chevron === "expanded" ? "▾" : "▸";
}

function headerStyle(accent: string): React.CSSProperties {
  return {
    display: "flex",
    width: "100%",
    gap: 10,
    padding: "8px 10px",
    border: "none",
    borderBottom: `1px solid ${accent}33`,
    background: "transparent",
    color: "#E6EDF3",
    textAlign: "left",
    cursor: "pointer",
    font: "inherit",
  };
}

const RAIL_STYLE: React.CSSProperties = { width: 3, borderRadius: 2, flex: "0 0 auto" };
const CONTENT_STYLE: React.CSSProperties = { flex: "1 1 auto", minWidth: 0 };
// Clears the ~30px source button pinned to the leaf card's top-right corner.
const CONTENT_RESERVED_STYLE: React.CSSProperties = { ...CONTENT_STYLE, paddingRight: 34 };

function contentStyle(reserveRight: boolean | number | undefined): React.CSSProperties {
  if (typeof reserveRight === "number") {
    return { ...CONTENT_STYLE, paddingRight: reserveRight };
  }
  return reserveRight ? CONTENT_RESERVED_STYLE : CONTENT_STYLE;
}
const TITLE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 6 };
const CHEVRON_STYLE: React.CSSProperties = { fontSize: 10, opacity: 0.8 };
const ENTRY_PILL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  background: "#56C271",
  color: "#062012",
  borderRadius: 4,
  padding: "1px 5px",
  flex: "0 0 auto",
};
const TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const KIND_STYLE: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginLeft: "auto",
};
