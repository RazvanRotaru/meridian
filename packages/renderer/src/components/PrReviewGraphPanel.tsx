/**
 * The PR-review graph pane's floating control: a Hide-boundary mode toggle (aria-pressed, so it reads
 * as a persistent mode, not a one-shot action) that drops the faded 1-hop neighbours via a relayout,
 * plus a two-swatch legend distinguishing a CHANGED file from a faded BOUNDARY (context) neighbour.
 */

import {
  LEGEND_ROW_STYLE,
  LEGEND_STYLE,
  PANEL_STYLE,
  SWATCH_BOUNDARY_STYLE,
  SWATCH_CHANGED_STYLE,
  toggleStyle,
} from "./prReviewGraphStyles";

export function ReviewGraphPanel(props: { hideBoundary: boolean; onToggleBoundary: () => void }) {
  return (
    <div style={PANEL_STYLE}>
      <button
        type="button"
        aria-pressed={props.hideBoundary}
        style={toggleStyle(props.hideBoundary)}
        onClick={props.onToggleBoundary}
      >
        {props.hideBoundary ? "Boundary hidden" : "Hide boundary"}
      </button>
      <div style={LEGEND_STYLE}>
        <span style={LEGEND_ROW_STYLE}>
          <span style={SWATCH_CHANGED_STYLE} aria-hidden />
          changed
        </span>
        <span style={LEGEND_ROW_STYLE}>
          <span style={SWATCH_BOUNDARY_STYLE} aria-hidden />
          boundary
        </span>
      </div>
    </div>
  );
}
