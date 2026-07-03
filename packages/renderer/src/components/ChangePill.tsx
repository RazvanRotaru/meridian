/**
 * The header pill a node wears when the change lens is on and the range touched it:
 * `+a −d` in git colours, plus `NΔ` on containers rolling up several changed files. Added
 * nodes read green, removed red, modified amber — the status colours the ± text only, so
 * the pill stays quiet next to the kind-coloured header rail.
 */

import type { ChangeEntry } from "../state/store";

export function ChangePill(props: { entry: ChangeEntry }) {
  const { entry } = props;
  return (
    <span style={PILL_STYLE} title={`${entry.status} · +${entry.additions} −${entry.deletions}`}>
      {entry.changedCount > 1 ? <span style={COUNT_STYLE}>{entry.changedCount}Δ</span> : null}
      <span style={ADD_STYLE}>+{entry.additions}</span>
      <span style={DEL_STYLE}>−{entry.deletions}</span>
    </span>
  );
}

const PILL_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: "14px",
  padding: "0 6px",
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "rgba(17,20,26,0.85)",
  flex: "0 0 auto",
  fontVariantNumeric: "tabular-nums",
};
const COUNT_STYLE: React.CSSProperties = { color: "#E8B341" };
const ADD_STYLE: React.CSSProperties = { color: "#56C271" };
const DEL_STYLE: React.CSSProperties = { color: "#E5534B" };
