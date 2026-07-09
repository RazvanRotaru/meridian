/**
 * The minimal-graph overlay's shared panel styles, split out of `MinimalGraphView` to keep the
 * component small. The overlay reuses the Module map's own cards, paint, and MiniMap tint — only its
 * floating panel (seed count, Reset, Close) is overlay-specific.
 */

export const SURFACE_STYLE: React.CSSProperties = { position: "relative", width: "100%", height: "100%", background: "#0E1116" };

export const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 5,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(18,23,30,0.92)",
  padding: "10px 12px",
};

const BUTTON_STYLE: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  color: "#9AA4B2",
};
const BUTTON_ACTIVE_STYLE: React.CSSProperties = {
  borderColor: "#E3B341",
  background: "rgba(227,179,65,0.14)",
  color: "#E6EDF3",
};
const BUTTON_DISABLED_STYLE: React.CSSProperties = { opacity: 0.4, cursor: "default" };

/** A panel button: base, plus an active (aria-pressed) accent and/or a disabled dim. */
export function buttonStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    ...BUTTON_STYLE,
    ...(active ? BUTTON_ACTIVE_STYLE : {}),
    ...(disabled ? BUTTON_DISABLED_STYLE : {}),
  };
}
