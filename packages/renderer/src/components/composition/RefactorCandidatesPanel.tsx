/**
 * The refactor worklist: a scrollable, worst-first list of the units that actually carry a design
 * smell — the navigation partner to the scatter. Each row shows the unit, its package, a
 * distance-coloured D score, and its smell chips; clicking a row roots the canvas at that unit so the
 * list drives the rooted view. A clean codebase surfaces the empty note rather than a padded list.
 */

import { useMemo } from "react";
import type { GraphNode } from "@meridian/core";
import type { UnitMetrics } from "@meridian/design-metrics";
import { colorForDistance } from "../../derive/compositionGraph";
import { clusterIdOf, clusterLabel } from "../../derive/compositionClusters";
import { SmellChip } from "./SmellChip";

// How many candidate rows to show before collapsing the tail into a "+N more" line — enough to be a
// worklist, capped so the panel never outgrows the Toolbar.
const MAX_ROWS = 12;

interface RefactorCandidatesPanelProps {
  /** Units ranked worst-first (from `rankRefactorCandidates`); the panel keeps only the smelly ones. */
  candidates: UnitMetrics[];
  nodesById: Map<string, GraphNode>;
  /** The rooted / selected unit — its row gets the active background; null when none. */
  activeId: string | null;
  onPick: (id: string) => void;
}

export function RefactorCandidatesPanel(props: RefactorCandidatesPanelProps) {
  const smelly = useMemo(() => props.candidates.filter((unit) => unit.smells.length > 0), [props.candidates]);
  const shown = smelly.slice(0, MAX_ROWS);
  const overflow = smelly.length - shown.length;

  return (
    <section style={SECTION_STYLE} aria-label="Refactor candidates">
      <div style={HEADER_STYLE}>Refactor candidates</div>
      {smelly.length === 0 ? (
        <div style={META_STYLE}>No design smells flagged.</div>
      ) : (
        <div style={LIST_STYLE}>
          {shown.map((unit) => (
            <CandidateRow
              key={unit.id}
              unit={unit}
              packageLabel={clusterLabel(clusterIdOf(unit.id, props.nodesById), props.nodesById)}
              active={unit.id === props.activeId}
              onPick={props.onPick}
            />
          ))}
          {overflow > 0 ? <div style={MORE_STYLE}>+{overflow} more</div> : null}
        </div>
      )}
    </section>
  );
}

function CandidateRow(props: { unit: UnitMetrics; packageLabel: string; active: boolean; onPick: (id: string) => void }) {
  const { unit } = props;
  return (
    <button type="button" style={rowStyle(props.active)} aria-pressed={props.active} title={unit.id} onClick={() => props.onPick(unit.id)}>
      <div style={ROW_HEAD_STYLE}>
        <span style={ROW_NAME_STYLE}>{unit.displayName}</span>
        <span style={{ ...ROW_D_STYLE, color: colorForDistance(unit.distance) }}>D{unit.distance}</span>
      </div>
      <span style={ROW_PKG_STYLE}>{props.packageLabel}</span>
      <div style={ROW_CHIPS_STYLE}>
        {unit.smells.map((smell) => (
          <SmellChip key={smell} smell={smell} />
        ))}
      </div>
    </button>
  );
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
const LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  maxHeight: 260,
  overflowY: "auto",
};
const MORE_STYLE: React.CSSProperties = { fontSize: 10, color: "#6C7683", padding: "2px 2px" };
const ROW_HEAD_STYLE: React.CSSProperties = { display: "flex", alignItems: "baseline", gap: 8 };
const ROW_NAME_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  fontWeight: 700,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_D_STYLE: React.CSSProperties = { flexShrink: 0, fontSize: 12, fontWeight: 700, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const ROW_PKG_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "#6C7683",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_CHIPS_STYLE: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 1 };

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    textAlign: "left",
    borderRadius: 6,
    border: active ? "1px solid #56C271" : "1px solid #2A2F37",
    background: active ? "#17251C" : "#12171E",
    padding: "6px 9px",
    cursor: "pointer",
    font: "inherit",
  };
}
