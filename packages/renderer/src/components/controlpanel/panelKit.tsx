/**
 * Shared building blocks for the redesigned control panel — the design tokens plus the small
 * primitives (section label, divider, filter pill and count badge) every section reuses, so the
 * header, PR review, lens, overlays and filters read as one system.
 */

import type { ReactNode } from "react";

export const TOKENS = {
  surface: "#12161C",
  surfaceBorder: "#2A2F37",
  divider: "#1C2029",
  text: "#E6EDF3",
  textMuted: "#8B949E",
  textDim: "#6B7480",
  label: "#6E7A88",
  reviewAmber: "#D29922",
  pillBg: "#0E1116",
  pillBorder: "#2A2F37",
  badgeBg: "#0B0E13",
} as const;

export const CONTROL_PANEL_WIDTH = 296;

const LABEL_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: TOKENS.label,
};
const ACTION_STYLE: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  fontSize: 11,
  color: TOKENS.textMuted,
  cursor: "pointer",
  font: "inherit",
};

/** The uppercase section heading, with an optional right-aligned reset action (Clear / All). */
export function SectionLabel(props: { children: ReactNode; action?: { label: string; onClick: () => void; title?: string } }) {
  return (
    <div style={LABEL_ROW_STYLE}>
      <span style={LABEL_STYLE}>{props.children}</span>
      {props.action ? (
        <button type="button" style={ACTION_STYLE} title={props.action.title} onClick={props.action.onClick}>
          {props.action.label}
        </button>
      ) : null}
    </div>
  );
}

export function Divider() {
  return <div style={{ height: 1, background: TOKENS.divider, margin: "2px 0" }} />;
}

const BADGE_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 16,
  height: 16,
  padding: "0 5px",
  borderRadius: 5,
  border: `1px solid ${TOKENS.pillBorder}`,
  background: TOKENS.badgeBg,
  color: TOKENS.textMuted,
  fontSize: 10.5,
  fontWeight: 600,
  lineHeight: 1,
};

export function CountBadge(props: { children: ReactNode; style?: React.CSSProperties }) {
  return <span style={{ ...BADGE_STYLE, ...props.style }}>{props.children}</span>;
}

/** The 9px on/off indicator: filled in the accent hue when active, hollow grey when not. */
function Indicator(props: { shape: "circle" | "square"; active: boolean; accent: string }) {
  return (
    <span
      style={{
        width: 9,
        height: 9,
        flexShrink: 0,
        borderRadius: props.shape === "circle" ? 999 : 3,
        border: `1px solid ${props.active ? props.accent : "#4B535F"}`,
        background: props.active ? props.accent : "transparent",
      }}
    />
  );
}

export interface PillProps {
  children: ReactNode;
  active: boolean;
  accent?: string;
  indicator?: "circle" | "square" | "none";
  badge?: ReactNode;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}

/** The one filter pill used across OVERLAYS, CATEGORIES and RELATIONSHIPS. */
export function Pill(props: PillProps) {
  const accent = props.accent ?? "#5B9BE3";
  const indicator = props.indicator ?? "circle";
  return (
    <button
      type="button"
      style={pillStyle(props.active, accent, props.disabled ?? false)}
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
    >
      {indicator === "none" ? null : <Indicator shape={indicator} active={props.active} accent={accent} />}
      <span>{props.children}</span>
      {props.badge !== undefined && props.badge !== null ? <CountBadge>{props.badge}</CountBadge> : null}
    </button>
  );
}

function pillStyle(active: boolean, accent: string, disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    borderRadius: 8,
    padding: "5px 9px",
    fontSize: 12,
    fontWeight: 500,
    font: "inherit",
    whiteSpace: "nowrap",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
    color: active ? TOKENS.text : TOKENS.textMuted,
    border: `1px solid ${active ? hexAlpha(accent, 0.45) : TOKENS.pillBorder}`,
    background: active ? hexAlpha(accent, 0.14) : TOKENS.pillBg,
  };
}

/** Expand a `#rrggbb` to an rgba() string; used for the pill's translucent active tint/border. */
export function hexAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
