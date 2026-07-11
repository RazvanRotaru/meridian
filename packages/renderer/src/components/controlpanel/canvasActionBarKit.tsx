import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { TOKENS } from "./panelKit";
import type { CanvasActionLayout } from "./canvasActionBarLayout";

export function CanvasActionBarFrame({ layout, children }: { layout: CanvasActionLayout; children: React.ReactNode }) {
  return (
    <div
      id="meridian-canvas-action-bar"
      role="group"
      aria-label="Canvas actions"
      className="mrd-scroll"
      style={{ ...BAR_STYLE, flexDirection: layout === "row" ? "row" : "column" }}
    >
      {children}
    </div>
  );
}

export function CanvasActionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span role="group" aria-label={label} style={GROUP_STYLE}>
      {children}
    </span>
  );
}

export function CanvasActionSeparator({ orientation }: { orientation: "horizontal" | "vertical" }) {
  return (
    <span
      role="separator"
      aria-orientation={orientation}
      style={orientation === "horizontal" ? HORIZONTAL_SEPARATOR_STYLE : VERTICAL_SEPARATOR_STYLE}
    />
  );
}

export function CanvasActionButton(props: {
  ariaLabel: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  badge?: number;
  disabled?: boolean;
  ariaKeyShortcuts?: string;
}) {
  const baseStyle = props.primary ? PRIMARY_ACTION_STYLE : ACTION_STYLE;
  const descriptionId = useId();
  const [focusTooltip, setFocusTooltip] = useState<{ left: number; top: number } | null>(null);
  return (
    <span style={BUTTON_WRAPPER_STYLE} title={props.title}>
      <button
        type="button"
        style={props.disabled ? { ...baseStyle, ...DISABLED_ACTION_STYLE } : baseStyle}
        aria-label={props.ariaLabel}
        aria-describedby={descriptionId}
        aria-disabled={props.disabled || undefined}
        aria-keyshortcuts={props.ariaKeyShortcuts}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible")) {
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          const halfWidth = Math.min(128, Math.max(0, (window.innerWidth - 24) / 2));
          const left = Math.min(window.innerWidth - 12 - halfWidth, Math.max(12 + halfWidth, box.left + box.width / 2));
          setFocusTooltip({ left, top: box.top - 8 });
        }}
        onBlur={() => setFocusTooltip(null)}
        onClick={(event) => {
          if (props.disabled) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          props.onClick();
        }}
      >
        <span style={ICON_STYLE}>{props.icon}</span>
        {props.badge === undefined ? null : <span aria-hidden style={BADGE_STYLE}>{props.badge > 99 ? "99+" : props.badge}</span>}
      </button>
      <span id={descriptionId} style={SCREEN_READER_ONLY_STYLE}>{props.title}</span>
      {focusTooltip === null ? null : createPortal(
        <span aria-hidden style={{ ...FOCUS_TOOLTIP_STYLE, left: focusTooltip.left, top: focusTooltip.top }}>
          {props.title}
        </span>,
        document.body,
      )}
    </span>
  );
}

const BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  maxWidth: "100%",
  overflowX: "auto",
  boxSizing: "border-box",
  padding: 5,
  borderRadius: 13,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(10,13,18,0.94)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.35)",
};
const GROUP_STYLE: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 };
const BUTTON_WRAPPER_STYLE: React.CSSProperties = { position: "relative", display: "inline-flex", flexShrink: 0 };
const SCREEN_READER_ONLY_STYLE: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
const FOCUS_TOOLTIP_STYLE: React.CSSProperties = {
  position: "fixed",
  transform: "translate(-50%, -100%)",
  zIndex: 1000,
  width: "max-content",
  maxWidth: "min(240px, calc(100vw - 24px))",
  padding: "6px 8px",
  border: `1px solid ${TOKENS.surfaceBorder}`,
  borderRadius: 6,
  background: "#111821",
  boxShadow: "0 5px 16px rgba(0,0,0,0.42)",
  color: TOKENS.text,
  fontSize: 11,
  lineHeight: 1.35,
  textAlign: "center",
  pointerEvents: "none",
};
const ACTION_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flexShrink: 0,
  width: 42,
  height: 42,
  padding: 0,
  borderRadius: 8,
  border: "1px solid transparent",
  background: "transparent",
  color: TOKENS.textMuted,
  cursor: "pointer",
  font: "inherit",
};
const PRIMARY_ACTION_STYLE: React.CSSProperties = {
  ...ACTION_STYLE,
  gap: 4,
  width: 60,
  padding: "0 9px",
  border: "1px solid #2F5C3B",
  background: "rgba(86,194,113,0.16)",
  color: "#6BE38A",
};
const DISABLED_ACTION_STYLE: React.CSSProperties = { opacity: 0.38, cursor: "default" };
const ICON_STYLE: React.CSSProperties = { display: "inline-flex", flexShrink: 0 };
const BADGE_STYLE: React.CSSProperties = {
  width: 18,
  color: "inherit",
  fontSize: 10.5,
  fontWeight: 700,
  lineHeight: 1,
  textAlign: "center",
};
const VERTICAL_SEPARATOR_STYLE: React.CSSProperties = {
  width: 1,
  height: 24,
  margin: "0 3px",
  flexShrink: 0,
  background: TOKENS.divider,
};
const HORIZONTAL_SEPARATOR_STYLE: React.CSSProperties = {
  width: "calc(100% - 12px)",
  height: 1,
  margin: "3px 0",
  flexShrink: 0,
  background: TOKENS.divider,
};
