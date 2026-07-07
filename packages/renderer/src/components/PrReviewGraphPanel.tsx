/**
 * The PR-review graph pane's floating control: a Hide-boundary mode toggle (aria-pressed, so it reads
 * as a persistent mode, not a one-shot action) that drops the faded 1-hop neighbours via a relayout,
 * plus a change-status legend — added / modified / renamed / removed swatches and the faded BOUNDARY
 * (context) neighbour — with a note that REMOVED files carry no node and are listed in the side pane.
 */

import { changeStatusColor } from "../theme/reviewColors";
import type { ChangeStatus } from "../derive/changeStatus";
import {
  LEGEND_NOTE_STYLE,
  LEGEND_ROW_STYLE,
  LEGEND_STYLE,
  PANEL_STYLE,
  SWATCH_BOUNDARY_STYLE,
  swatchStyle,
  toggleStyle,
} from "./prReviewGraphStyles";

// Added/modified/renamed cards render as nodes; "removed" has none, but it earns a swatch so the
// red side-list entries read as part of the same palette (the note below spells out why they're gone).
const LEGEND_STATUSES: ChangeStatus[] = ["added", "modified", "renamed", "removed"];

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
        {LEGEND_STATUSES.map((status) => {
          const style = changeStatusColor(status);
          return (
            <span key={status} style={LEGEND_ROW_STYLE}>
              <span style={swatchStyle(style.stroke)} aria-hidden />
              {style.label}
            </span>
          );
        })}
        <span style={LEGEND_ROW_STYLE}>
          <span style={SWATCH_BOUNDARY_STYLE} aria-hidden />
          boundary
        </span>
      </div>
      <div style={LEGEND_NOTE_STYLE}>Removed files have no node — they’re listed in the side panel.</div>
    </div>
  );
}
