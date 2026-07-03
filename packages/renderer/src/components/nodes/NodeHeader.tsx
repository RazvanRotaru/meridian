/**
 * The shared node header: a kind-accent rail, an optional expand/collapse chevron, a
 * title-cased display name, an optional child-count chip, and a slot for badges.
 *
 * Interaction contract (matches familiar tree UIs): ONLY the chevron toggles expansion —
 * clicks on it never bubble. Everywhere else on the header behaves like the node body, so a
 * single click selects (path trace) and a double click dives into a container. This keeps
 * title-only compact nodes fully divable.
 */

import type { ReactNode } from "react";
import type { GraphNode } from "@meridian/core";
import { titleCase } from "../../theme/displayName";

export function NodeHeader(props: {
  node: GraphNode;
  accent: string;
  chevron?: "collapsed" | "expanded";
  count?: number;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  return (
    <div style={headerStyle(props.accent)}>
      <span style={{ ...RAIL_STYLE, background: props.accent }} />
      <span style={CONTENT_STYLE}>
        <span style={TITLE_ROW_STYLE}>
          {props.chevron && props.onToggle ? (
            <Chevron chevron={props.chevron} onToggle={props.onToggle} />
          ) : null}
          <span style={TITLE_STYLE}>{titleCase(props.node.displayName)}</span>
          {props.count !== undefined ? (
            <span style={{ ...COUNT_CHIP_STYLE, color: props.accent, borderColor: `${props.accent}55` }}>
              {props.count}
            </span>
          ) : null}
          <span style={{ ...KIND_STYLE, color: props.accent }}>{props.node.kind}</span>
        </span>
        {props.children}
      </span>
    </div>
  );
}

function Chevron(props: { chevron: "collapsed" | "expanded"; onToggle: () => void }) {
  const stopAnd = (action?: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    action?.();
  };
  return (
    <button
      type="button"
      aria-label={props.chevron === "expanded" ? "Collapse" : "Expand"}
      style={CHEVRON_BUTTON_STYLE}
      onClick={stopAnd(props.onToggle)}
      onDoubleClick={stopAnd()}
    >
      {props.chevron === "expanded" ? "▾" : "▸"}
    </button>
  );
}

function headerStyle(accent: string): React.CSSProperties {
  return {
    display: "flex",
    width: "100%",
    gap: 8,
    padding: "7px 10px",
    borderBottom: `1px solid ${accent}33`,
    background: "transparent",
    color: "#E6EDF3",
    textAlign: "left",
    cursor: "pointer",
    font: "inherit",
    boxSizing: "border-box",
  };
}

const COUNT_CHIP_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "14px",
  padding: "0 6px",
  borderRadius: 8,
  border: "1px solid",
  flex: "0 0 auto",
};

const RAIL_STYLE: React.CSSProperties = { width: 3, borderRadius: 2, flex: "0 0 auto" };
const CONTENT_STYLE: React.CSSProperties = { flex: "1 1 auto", minWidth: 0 };
const TITLE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const CHEVRON_BUTTON_STYLE: React.CSSProperties = {
  width: 16,
  height: 16,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "#9AA4B2",
  fontSize: 10,
  cursor: "pointer",
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
  flex: "0 0 auto",
};
