/**
 * The IPC wire inspector — opens (top-right) when a gold IPC wire is clicked, listing the channel(s)
 * it carries. On a drilled-in unit view a wire is one channel; on the aggregated overview it can be
 * many (a whole area's cross-boundary traffic), which is exactly where the list earns its place.
 * Presentation only; the view owns the open/close state (a pure repaint, like node selection).
 */

import type { IpcChannelDetail } from "../../derive/compositionGraph";

const IPC_GOLD = "#c9a24b";
const DANGER = "#f0555c";

export function IpcInspector(props: {
  channels: IpcChannelDetail[];
  fromLabel: string;
  toLabel: string;
  onClose: () => void;
}) {
  const protocols = [...new Set(props.channels.map((c) => c.protocol))].sort();
  const dangling = props.channels.filter((c) => c.dangling !== null).length;
  return (
    <aside style={PANEL} aria-label="IPC channel inspector">
      <div style={HEAD_ROW}>
        <span style={KICKER}>IPC · over the wire</span>
        <button type="button" style={CLOSE} onClick={props.onClose} aria-label="Close inspector">×</button>
      </div>
      <div style={ROUTE}>
        <span style={ENDPOINT} title={props.fromLabel}>{props.fromLabel}</span>
        <span style={{ color: IPC_GOLD, flexShrink: 0 }}>→</span>
        <span style={ENDPOINT} title={props.toLabel}>{props.toLabel}</span>
      </div>
      <div style={SUMMARY}>
        <b style={{ color: "#e6edf3" }}>{props.channels.length}</b> channel{props.channels.length === 1 ? "" : "s"}
        {protocols.length ? <> · {protocols.map((p) => p.toUpperCase()).join(" + ")}</> : null}
        {dangling > 0 ? <span style={{ color: DANGER }}> · {dangling} unanswered</span> : null}
      </div>
      <ul style={LIST}>
        {props.channels.map((c) => (
          <li key={`${c.protocol}:${c.channel}`} style={ROW}>
            <span style={{ color: IPC_GOLD, flexShrink: 0 }}>⇄</span>
            <span style={CHAN} title={c.channel}>{c.channel}</span>
            <span style={PROTO_TAG}>{c.protocol.toUpperCase()}</span>
            {c.dangling ? (
              <span style={WARN} title={c.dangling === "out-only" ? "sent, no handler in the graph" : "handled, no sender in the graph"}>
                {c.dangling === "out-only" ? "no handler" : "no sender"}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </aside>
  );
}

const PANEL: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  zIndex: 6,
  width: 320,
  maxHeight: "70vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px 14px",
  borderRadius: 11,
  border: `1px solid ${IPC_GOLD}66`,
  background: "rgba(18,23,30,0.96)",
  backdropFilter: "blur(6px)",
  fontFamily: "system-ui, -apple-system, sans-serif",
};
const HEAD_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const KICKER: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: IPC_GOLD };
const CLOSE: React.CSSProperties = { border: "none", background: "transparent", color: "#9aa4b2", fontSize: 18, lineHeight: 1, cursor: "pointer", padding: 0 };
const ROUTE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#e6edf3", fontWeight: 600 };
const ENDPOINT: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 };
const SUMMARY: React.CSSProperties = { fontSize: 11.5, color: "#9aa4b2" };
const LIST: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 };
const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 12, padding: "3px 0", borderTop: "1px solid #232935" };
const CHAN: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace", color: "#ead9ae", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 };
const PROTO_TAG: React.CSSProperties = { flexShrink: 0, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.05em", color: IPC_GOLD, border: `1px solid ${IPC_GOLD}66`, borderRadius: 3, padding: "1px 4px" };
const WARN: React.CSSProperties = { flexShrink: 0, fontSize: 9, fontWeight: 700, color: DANGER, border: `1px solid ${DANGER}80`, borderRadius: 3, padding: "1px 4px", background: "rgba(240,85,92,0.12)" };
