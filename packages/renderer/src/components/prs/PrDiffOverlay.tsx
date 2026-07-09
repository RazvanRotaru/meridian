/**
 * The PR diff, full-screen: on a completed analysis the modified-node minimal graph opens over the
 * whole PR view by REUSING the Module-map's `MinimalGraphView` overlay (via its `override` prop), so
 * the diff reads with the same surface, panel, and Escape-to-close the reader already knows. The
 * overlay's floating panel names the current PR; the directly-affected logic flows dock as a
 * scrollable side panel. Closing (✕ / Esc) clears the analysis and returns to the PR list.
 */

import { useBlueprint, useBlueprintActions } from "../../state/StoreContext";
import type { PrSummary } from "../../state/prTypes";
import { MinimalGraphView } from "../MinimalGraphView";
import { AffectedFlowList } from "../prreview/AffectedFlowList";

export function PrDiffOverlay() {
  const nodes = useBlueprint((state) => state.prMinimalRfNodes);
  const edges = useBlueprint((state) => state.prMinimalRfEdges);
  const flows = useBlueprint((state) => state.prAffectedFlows);
  const prNumber = useBlueprint((state) => state.prAnalyzePrNumber);
  const title = useBlueprint((state) => prTitle(prNumber, state.prsList.open, state.prsList.closed));
  const { clearPrAnalysis } = useBlueprintActions();

  return (
    <div style={COVER}>
      <MinimalGraphView override={{ nodes, edges, title, onClose: clearPrAnalysis }} />
      <aside style={FLOWS_PANEL}>
        <AffectedFlowList flows={flows} />
      </aside>
    </div>
  );
}

/** "PR #<n> · <title>" for the overlay panel — falls back gracefully before the list has loaded. */
function prTitle(
  prNumber: number | null,
  open: readonly PrSummary[] | null,
  closed: readonly PrSummary[] | null,
): string {
  if (prNumber === null) {
    return "PR diff";
  }
  const summary = [...(open ?? []), ...(closed ?? [])].find((pr) => pr.number === prNumber);
  return summary ? `PR #${prNumber} · ${summary.title}` : `PR #${prNumber}`;
}

// Covers the whole PR view; the overlay's own surface + panels sit inside. Above the list, below the
// app's floating Toolbar (which keeps the lens tabs reachable, exactly as over the Module map).
const COVER: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 20 };

// Docked top-LEFT (clear of MinimalGraphView's own PR panel, which floats top-right), scrollable so a
// long affected-flow list never runs off-screen. The overlay covers the app Toolbar, so the left edge
// is free; the canvas zoom controls sit bottom-left, below this panel.
const FLOWS_PANEL: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 6,
  width: 340,
  maxHeight: "calc(100% - 96px)",
  overflowY: "auto",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  background: "rgba(14,17,22,0.94)",
};
