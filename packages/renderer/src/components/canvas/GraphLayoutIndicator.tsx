/** A shared, non-destructive busy overlay for graph derivation + ELK layout. */

import { TOKENS } from "../controlpanel/panelKit";

export interface GraphLayoutIndicatorProps {
  label: string;
  detail?: string;
}

export function GraphLayoutIndicator(props: GraphLayoutIndicatorProps) {
  return (
    <div style={LAYER_STYLE}>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={CARD_STYLE}
      >
        <span aria-hidden="true" style={ACTIVE_DOT_STYLE} />
        <span style={COPY_STYLE}>
          <strong style={LABEL_STYLE}>{props.label}</strong>
          {props.detail ? <span style={DETAIL_STYLE}>{props.detail}</span> : null}
        </span>
      </div>
    </div>
  );
}

const LAYER_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 25,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(14, 17, 22, 0.58)",
  cursor: "wait",
};

const CARD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 13,
  minWidth: 220,
  maxWidth: "calc(100% - 48px)",
  padding: "13px 16px",
  boxSizing: "border-box",
  borderRadius: 10,
  border: `1px solid ${TOKENS.surfaceBorder}`,
  background: "rgba(11, 15, 20, 0.96)",
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.38)",
};

const ACTIVE_DOT_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  flexShrink: 0,
  background: "#388BFD",
  boxShadow: "0 0 0 4px rgba(56, 139, 253, 0.2)",
};

const COPY_STYLE: React.CSSProperties = { display: "flex", minWidth: 0, flexDirection: "column", gap: 3 };
const LABEL_STYLE: React.CSSProperties = { color: TOKENS.text, fontSize: 13, fontWeight: 650 };
const DETAIL_STYLE: React.CSSProperties = { color: TOKENS.textMuted, fontSize: 11.5 };
