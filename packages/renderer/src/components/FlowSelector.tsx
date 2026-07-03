/**
 * The "code flows" control: pick one entry point and the canvas isolates its forward call-flow
 * (see flowReach). Quick-pick buttons cover the ranked entries; a selected node can be rooted
 * directly; and while a flow is on screen a depth dial trims how many hops deep it runs.
 */

import { useMemo, useState } from "react";
import type { GraphNode } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { rankedEntryPoints } from "../derive/flowReach";

const DEPTHS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: null, label: "All" },
];
const MATCH_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

export function FlowSelector() {
  const index = useBlueprint((state) => state.index);
  const viewMode = useBlueprint((state) => state.viewMode);
  const flowRootId = useBlueprint((state) => state.flowRootId);
  const flowDepth = useBlueprint((state) => state.flowDepth);
  const selectedId = useBlueprint((state) => state.selectedId);
  const visibleCount = useBlueprint((state) => state.rfNodes.length);
  const { isolateFlow, clearFlow, setFlowDepth } = useBlueprintActions();
  const [query, setQuery] = useState("");

  const entries = useMemo(() => rankedEntryPoints(index, viewMode, 6), [index, viewMode]);
  const matches = useMemo(() => searchNodes(index.nodesById, query), [index, query]);
  const activeLabel = flowRootId ? index.nodesById.get(flowRootId)?.displayName ?? flowRootId : null;
  const selectedLabel = selectedId ? index.nodesById.get(selectedId)?.displayName : undefined;
  const selectedKind = selectedId ? index.nodesById.get(selectedId)?.kind : undefined;
  const canRootSelection =
    selectedId !== null && selectedId !== flowRootId && (selectedKind === "function" || selectedKind === "method");

  return (
    <section style={SECTION_STYLE} aria-label="Code flows">
      <div style={HEADER_STYLE}>Code flows</div>

      {activeLabel ? (
        <div style={ACTIVE_STYLE}>
          <div style={ACTIVE_ROW_STYLE}>
            <span style={ACTIVE_LABEL_STYLE} title={flowRootId ?? undefined}>{activeLabel}</span>
            <button type="button" style={CLEAR_STYLE} onClick={clearFlow}>
              Show all
            </button>
          </div>
          <div style={DEPTH_ROW_STYLE}>
            <span style={META_STYLE}>{visibleCount} nodes · depth</span>
            <div style={GROUP_STYLE} role="group" aria-label="Flow depth">
              {DEPTHS.map((depth) => (
                <button
                  key={depth.label}
                  type="button"
                  style={pillStyle(depth.value === flowDepth)}
                  aria-pressed={depth.value === flowDepth}
                  onClick={() => setFlowDepth(depth.value)}
                >
                  {depth.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={META_STYLE}>Pick an entry point to isolate its call-flow.</div>
      )}

      {canRootSelection ? (
        <button type="button" style={SELECTION_STYLE} onClick={() => isolateFlow(selectedId as string)}>
          Isolate flow from “{selectedLabel ?? selectedId}”
        </button>
      ) : null}

      <div style={PICKS_WRAP_STYLE}>
        <input
          style={SEARCH_STYLE}
          placeholder="Search a node to isolate…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.trim() ? (
          <div style={RESULTS_STYLE}>
            {matches.map((node) => (
              <button
                key={node.id}
                type="button"
                style={pickStyle(node.id === flowRootId)}
                aria-pressed={node.id === flowRootId}
                title={node.id}
                onClick={() => {
                  isolateFlow(node.id);
                  setQuery("");
                }}
              >
                <span style={PICK_LABEL_STYLE}>{node.displayName}</span>
                <span style={PICK_DETAIL_STYLE}>{node.qualifiedName || node.location.file}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={PICKS_STYLE}>
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                style={pickStyle(entry.id === flowRootId)}
                aria-pressed={entry.id === flowRootId}
                title={entry.id}
                onClick={() => isolateFlow(entry.id)}
              >
                <span style={PICK_LABEL_STYLE}>{entry.label}</span>
                {entry.detail ? <span style={PICK_DETAIL_STYLE}>{entry.detail}</span> : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** First 15 code nodes whose display or qualified name contains the query (case-insensitive). */
function searchNodes(nodesById: ReadonlyMap<string, GraphNode>, query: string): GraphNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const found: GraphNode[] = [];
  for (const node of nodesById.values()) {
    if (!MATCH_KINDS.has(node.kind)) {
      continue;
    }
    if (
      node.displayName.toLowerCase().includes(needle) ||
      node.qualifiedName.toLowerCase().includes(needle)
    ) {
      found.push(node);
      if (found.length >= 15) {
        break;
      }
    }
  }
  return found;
}

const SECTION_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  paddingTop: 8,
  borderTop: "1px solid #2A2F37",
};
const HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "#7B8695",
};
const META_STYLE: React.CSSProperties = { fontSize: 11, color: "#7B8695" };
const ACTIVE_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 8,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#12171E",
};
const ACTIVE_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const ACTIVE_LABEL_STYLE: React.CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 600,
  color: "#56C271",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const DEPTH_ROW_STYLE: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const GROUP_STYLE: React.CSSProperties = {
  display: "flex",
  padding: 2,
  gap: 2,
  borderRadius: 8,
  border: "1px solid #2A2F37",
  background: "#0E1116",
};
const CLEAR_STYLE: React.CSSProperties = {
  background: "#1A1F27",
  color: "#9AA4B2",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "3px 9px",
  fontSize: 11,
  cursor: "pointer",
};
const SELECTION_STYLE: React.CSSProperties = {
  textAlign: "left",
  background: "#161B22",
  color: "#E6EDF3",
  border: "1px dashed #3A4250",
  borderRadius: 6,
  padding: "5px 9px",
  fontSize: 12,
  cursor: "pointer",
};
const PICKS_WRAP_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const SEARCH_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: 12,
  padding: "4px 8px",
  background: "#0E1116",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  color: "#E6EDF3",
};
const PICKS_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  maxHeight: 150,
  overflowY: "auto",
};
const RESULTS_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  maxHeight: 180,
  overflowY: "auto",
};
const PICK_LABEL_STYLE: React.CSSProperties = { fontSize: 12, color: "inherit" };
const PICK_DETAIL_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function pickStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    textAlign: "left",
    borderRadius: 6,
    border: active ? "1px solid #56C271" : "1px solid #2A2F37",
    background: active ? "#17251C" : "#12171E",
    color: active ? "#E6EDF3" : "#9AA4B2",
    padding: "5px 9px",
    cursor: "pointer",
    font: "inherit",
  };
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 11,
    cursor: "pointer",
    font: "inherit",
    fontWeight: active ? 600 : 400,
    background: active ? "#1F2530" : "transparent",
    color: active ? "#E6EDF3" : "#9AA4B2",
  };
}
