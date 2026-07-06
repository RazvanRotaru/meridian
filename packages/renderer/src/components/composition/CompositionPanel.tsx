/**
 * The Service-composition sidebar — the whole-system overview + worklist that drives the rooted
 * canvas. Replaces the call-flow FlowSelector in composition mode: an A/I main-sequence scatter (the
 * map) over a worst-first refactor-candidate list (the worklist). Both are global (computed from the
 * whole graph, not the rooted subset); a click on either roots the canvas at that unit.
 *
 * Metrics are computed ONCE here (keyed on the index) and shared with both children so the ranking
 * and the scatter never recompute the same pass twice.
 */

import { useMemo } from "react";
import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import { computeCompositionMetrics, rankRefactorCandidates } from "../../derive/composition";
import { MainSequenceScatter } from "./MainSequenceScatter";
import { RefactorCandidatesPanel } from "./RefactorCandidatesPanel";
import { CompositionLegend } from "./CompositionLegend";

export function CompositionPanel() {
  const index = useBlueprint((state) => state.index);
  const compRoot = useBlueprint((state) => state.compRoot);
  const compSelectedId = useBlueprint((state) => state.compSelectedId);
  const showMetrics = useBlueprint((state) => state.showSolidMetrics);
  const { setCompRoot, selectCompUnit, toggleSolidMetrics } = useBlueprintActions();

  const metrics = useMemo(() => computeCompositionMetrics([...index.nodesById.values()], index.edges), [index]);
  const units = useMemo(() => [...metrics.values()], [metrics]);
  const ranked = useMemo(() => rankRefactorCandidates(metrics), [metrics]);

  // The scatter clears selection when it re-roots, so `compSelectedId ?? compRoot` is the unit the
  // reader is currently focused on — the one both panels emphasize.
  const activeId = compSelectedId ?? compRoot;

  // A row navigates the canvas (re-root) AND fixes the selection highlight so the row + the card ring
  // agree; the scatter dot just re-roots (selection follows via the guard above).
  const pickRow = (id: string) => {
    setCompRoot(id);
    selectCompUnit(id);
  };

  return (
    <>
      <button
        type="button"
        style={metricsToggleStyle(!showMetrics)}
        aria-pressed={!showMetrics}
        onClick={toggleSolidMetrics}
        title="Show or hide the SOLID metrics — the card metric rows, smell chips, and the main-sequence map (the D rating stays)"
      >
        {showMetrics ? "Hide metrics" : "Show metrics"}
      </button>
      {showMetrics ? (
        <section style={SECTION_STYLE} aria-label="Main sequence">
          <div style={HEADER_STYLE}>Main sequence</div>
          <MainSequenceScatter metrics={units} activeId={activeId} onPick={setCompRoot} />
        </section>
      ) : null}
      <RefactorCandidatesPanel candidates={ranked} nodesById={index.nodesById} activeId={activeId} onPick={pickRow} />
      <CompositionLegend />
    </>
  );
}

// Mirrors LogicFlowView's hide-toggle: pressed (blue) when metrics are currently hidden.
function metricsToggleStyle(active: boolean): React.CSSProperties {
  return {
    alignSelf: "flex-start",
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 6,
    cursor: "pointer",
    font: "inherit",
    border: `1px solid ${active ? "#3B7AC0" : "#2A2F37"}`,
    background: active ? "#111A24" : "#12171E",
    color: active ? "#8FB6E3" : "#9AA4B2",
  };
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
