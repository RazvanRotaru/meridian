/**
 * The selection inspector (top-right floating panel): identity (name, kind, module path),
 * summary/signature, the trace-depth control (direct neighbours vs full impact), and the
 * node's visible connections grouped by direction. Connection rows are buttons — clicking
 * one walks the selection to that neighbour, so a reader can follow a flow hop by hop
 * without hunting the canvas.
 */

import { useMemo } from "react";
import { accentForKind } from "../theme/kindColors";
import { PATH_DOWNSTREAM, PATH_UPSTREAM } from "../theme/edgeColors";
import { titleCase } from "../theme/displayName";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { BlueprintEdge } from "../layout/rfTypes";

const MAX_ROWS_PER_DIRECTION = 8;

export function DetailPanel() {
  const selectedId = useBlueprint((state) => state.selectedId);
  const node = useBlueprint((state) => (state.selectedId ? state.index.nodesById.get(state.selectedId) : undefined));
  const rfEdges = useBlueprint((state) => state.rfEdges);
  const traceDepth = useBlueprint((state) => state.traceDepth);
  const isContainer = useBlueprint((state) => (state.selectedId ? state.index.isContainer(state.selectedId) : false));
  const changeEntry = useBlueprint((state) => (state.selectedId ? state.changeRollup.get(state.selectedId) : undefined));
  const hasFileDiff = useBlueprint((state) => {
    if (!state.selectedId || !state.change) {
      return false;
    }
    const file = state.index.nodesById.get(state.selectedId)?.location?.file;
    return Boolean(file && Object.prototype.hasOwnProperty.call(state.change.files, file));
  });
  const { select, setTraceDepth, diveInto, openDiff } = useBlueprintActions();

  const connections = useMemo(
    () => (selectedId ? groupConnections(rfEdges, selectedId) : null),
    [rfEdges, selectedId],
  );

  if (!selectedId || !node || !connections) {
    return null;
  }
  const accent = accentForKind(node.kind);
  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <span style={{ ...KIND_CHIP_STYLE, color: accent, borderColor: `${accent}66` }}>{node.kind}</span>
        <strong style={TITLE_STYLE}>{titleCase(node.displayName)}</strong>
        <button type="button" style={CLOSE_STYLE} onClick={() => select(null)} aria-label="Close details">
          ×
        </button>
      </div>
      <div style={PATH_STYLE}>{node.id}</div>
      {node.summary ? <div style={SUMMARY_STYLE}>{node.summary}</div> : null}
      {node.signature ? <code style={SIGNATURE_STYLE}>{node.signature}</code> : null}

      {changeEntry ? (
        <div style={CHANGE_ROW_STYLE}>
          <span style={{ ...LABEL_STYLE, color: "#E8B341" }}>
            {changeEntry.status.toUpperCase()}
            {changeEntry.changedCount > 1 ? ` · ${changeEntry.changedCount} files` : ""}
          </span>
          <span style={CHANGE_STATS_STYLE}>
            <span style={{ color: "#56C271" }}>+{changeEntry.additions}</span>{" "}
            <span style={{ color: "#E5534B" }}>−{changeEntry.deletions}</span>
          </span>
          {hasFileDiff ? (
            <button type="button" style={DIFF_BUTTON_STYLE} onClick={() => openDiff(selectedId)}>
              Open diff ⌄
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={ROW_STYLE}>
        <span style={LABEL_STYLE}>TRACE</span>
        <Segmented
          options={[
            { key: "direct", label: "Direct" },
            { key: "full", label: "Full impact" },
          ]}
          active={traceDepth}
          onPick={(key) => setTraceDepth(key as "direct" | "full")}
        />
        {isContainer ? (
          <button type="button" style={ACTION_STYLE} onClick={() => diveInto(selectedId)}>
            Dive in ↘
          </button>
        ) : null}
      </div>

      <ConnectionList
        heading="OUT"
        color={PATH_DOWNSTREAM}
        rows={connections.outgoing}
        onPick={select}
      />
      <ConnectionList
        heading="IN"
        color={PATH_UPSTREAM}
        rows={connections.incoming}
        onPick={select}
      />
    </div>
  );
}

interface ConnectionRow {
  otherId: string;
  kind: string;
  weight: number;
}

function groupConnections(edges: BlueprintEdge[], nodeId: string): {
  outgoing: ConnectionRow[];
  incoming: ConnectionRow[];
} {
  const outgoing: ConnectionRow[] = [];
  const incoming: ConnectionRow[] = [];
  for (const edge of edges) {
    if (edge.source === nodeId) {
      outgoing.push({ otherId: edge.target, kind: edge.data?.kind ?? "", weight: edge.data?.weight ?? 1 });
    } else if (edge.target === nodeId) {
      incoming.push({ otherId: edge.source, kind: edge.data?.kind ?? "", weight: edge.data?.weight ?? 1 });
    }
  }
  const byWeight = (a: ConnectionRow, b: ConnectionRow) => b.weight - a.weight;
  return { outgoing: outgoing.sort(byWeight), incoming: incoming.sort(byWeight) };
}

function ConnectionList(props: {
  heading: string;
  color: string;
  rows: ConnectionRow[];
  onPick(id: string): void;
}) {
  const shown = props.rows.slice(0, MAX_ROWS_PER_DIRECTION);
  const hidden = props.rows.length - shown.length;
  return (
    <div style={LIST_STYLE}>
      <div style={{ ...LABEL_STYLE, color: props.color }}>
        {props.heading} · {props.rows.length}
      </div>
      {shown.map((row) => (
        <button
          key={`${row.kind}-${row.otherId}`}
          type="button"
          style={CONNECTION_ROW_STYLE}
          onClick={() => props.onPick(row.otherId)}
          title={row.otherId}
        >
          <span style={{ ...ARROW_STYLE, color: props.color }}>{props.heading === "OUT" ? "→" : "←"}</span>
          <span style={CONNECTION_NAME_STYLE}>{shortName(row.otherId)}</span>
          <span style={CONNECTION_META_STYLE}>
            {row.kind}
            {row.weight > 1 ? ` ×${row.weight}` : ""}
          </span>
        </button>
      ))}
      {hidden > 0 ? <div style={MORE_STYLE}>+{hidden} more</div> : null}
    </div>
  );
}

function Segmented(props: {
  options: Array<{ key: string; label: string }>;
  active: string;
  onPick(key: string): void;
}) {
  return (
    <span style={SEGMENTED_STYLE}>
      {props.options.map((option) => (
        <button
          key={option.key}
          type="button"
          style={segmentStyle(option.key === props.active)}
          onClick={() => props.onPick(option.key)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/** The last meaningful piece of a node id: qualname when present, else the module basename. */
function shortName(nodeId: string): string {
  const qualname = nodeId.split("#")[1];
  if (qualname) {
    return qualname;
  }
  const modulePath = nodeId.split(":")[1] ?? nodeId;
  return modulePath.split("/").pop() ?? modulePath;
}

const PANEL_STYLE: React.CSSProperties = {
  width: 304,
  maxHeight: "76vh",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 10,
  border: "1px solid #2A2F37",
  background: "rgba(14,17,22,0.94)",
  backdropFilter: "blur(6px)",
  color: "#E6EDF3",
};
const HEADER_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 13,
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const KIND_CHIP_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "2px 6px",
  borderRadius: 6,
  border: "1px solid",
  flex: "0 0 auto",
};
const CLOSE_STYLE: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#9AA4B2",
  fontSize: 16,
  cursor: "pointer",
  padding: "0 2px",
  flex: "0 0 auto",
};
const PATH_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "#7C8696",
  wordBreak: "break-all",
  lineHeight: "14px",
};
const SUMMARY_STYLE: React.CSSProperties = { fontSize: 11, color: "#9AA4B2", lineHeight: "16px" };
const SIGNATURE_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#C9D3E0",
  background: "#11141A",
  border: "1px solid #222732",
  borderRadius: 6,
  padding: "6px 8px",
  overflowX: "auto",
  whiteSpace: "pre",
};
const ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
const CHANGE_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 7,
  border: "1px solid #2A2F37",
  background: "#11141A",
};
const CHANGE_STATS_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
};
const DIFF_BUTTON_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  background: "#1A1F27",
  color: "#4EE1C4",
  border: "1px solid #2A3A37",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
const LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.8,
  color: "#7C8696",
};
const ACTION_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  background: "#1A1F27",
  color: "#C9D3E0",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
};
const LIST_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const CONNECTION_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "3px 6px",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "#C9D3E0",
  fontSize: 11,
  textAlign: "left",
  cursor: "pointer",
};
const ARROW_STYLE: React.CSSProperties = { flex: "0 0 auto", fontWeight: 700 };
const CONNECTION_NAME_STYLE: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const CONNECTION_META_STYLE: React.CSSProperties = { flex: "0 0 auto", fontSize: 9, color: "#7C8696" };
const MORE_STYLE: React.CSSProperties = { fontSize: 10, color: "#7C8696", padding: "0 6px" };
const SEGMENTED_STYLE: React.CSSProperties = {
  display: "inline-flex",
  border: "1px solid #2A2F37",
  borderRadius: 7,
  overflow: "hidden",
};

function segmentStyle(active: boolean): React.CSSProperties {
  return {
    border: "none",
    background: active ? "#232936" : "transparent",
    color: active ? "#E6EDF3" : "#9AA4B2",
    fontSize: 10,
    fontWeight: 600,
    padding: "3px 8px",
    cursor: "pointer",
  };
}
