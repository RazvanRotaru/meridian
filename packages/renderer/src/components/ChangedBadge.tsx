/**
 * The amber "Δ changed" chip a node header shows when the artifact was generated with
 * `--changed-since` and this node's span overlapped the diff. A pure tag read — no store
 * state: changed-ness is in the data, so the chip is on wherever changed code is visible.
 */

import { isChangedNode } from "@meridian/core";
import type { GraphNode } from "@meridian/core";

export const CHANGED_ACCENT = "#E2A33C";

export function ChangedBadge(props: { node: GraphNode }) {
  if (!isChangedNode(props.node)) {
    return null;
  }
  return <span style={BADGE_STYLE}>Δ changed</span>;
}

/** The collapsed-container hint: "Δ n" changed nodes are hidden inside this frame. */
export function ChangedCountChip(props: { count: number }) {
  if (props.count === 0) {
    return null;
  }
  return (
    <span style={BADGE_STYLE} title={`${props.count} changed inside`}>
      Δ {props.count}
    </span>
  );
}

const BADGE_STYLE: React.CSSProperties = {
  display: "inline-block",
  marginTop: 3,
  padding: "1px 6px",
  borderRadius: 4,
  border: `1px solid ${CHANGED_ACCENT}66`,
  background: `${CHANGED_ACCENT}1A`,
  color: CHANGED_ACCENT,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.3,
};
