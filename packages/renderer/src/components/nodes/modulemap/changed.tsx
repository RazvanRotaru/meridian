/**
 * The Map's diff overlay: an amber ring + a "Δ" / "Δ n" chip a card wears when the artifact was
 * generated with `--changed-since` and this node — or something inside it — is in the PR's diff.
 * Reads the store's changed sets by node id (the view-agnostic signal every lens shares, built once
 * in graphIndex), so the marker needs no per-node data threading and stays in sync with the composition
 * lens's amber treatment. Selection (green ring) always wins over the diff ring.
 */

import { useBlueprint } from "../../../state/StoreContext";
import { CHANGED_ACCENT } from "../../ChangedBadge";

export interface NodeDiff {
  /** This exact node is in the diff (its span overlapped a changed line range). */
  changed: boolean;
  /** Changed nodes strictly inside this node — a collapsed/aggregating card's hidden edits. */
  inside: number;
  hasDiff: boolean;
}

/** The diff state for one Map node, keyed by its (real) graph node id. */
export function useNodeDiff(id: string): NodeDiff {
  const changed = useBlueprint((state) => state.index.changedIds.has(id));
  const inside = useBlueprint((state) => state.index.changedDescendants.get(id) ?? 0);
  return { changed, inside, hasDiff: changed || inside > 0 };
}

/** Repaint a card/frame border amber to echo the composition lens's changed treatment. */
export function changedBorder(base: React.CSSProperties): React.CSSProperties {
  return { ...base, borderColor: CHANGED_ACCENT, boxShadow: `0 0 0 1px ${CHANGED_ACCENT}66` };
}

/** Pick the border a card wears: selection first, then the diff ring, then the resting style. */
export function borderFor(base: React.CSSProperties, selectedStyle: React.CSSProperties, selected: boolean, diff: NodeDiff): React.CSSProperties {
  if (selected) {
    return selectedStyle;
  }
  return diff.hasDiff ? changedBorder(base) : base;
}

/** The amber diff chip: "Δ n" for edits hidden inside a card, a bare "Δ" for a directly-changed leaf. */
export function DeltaChip({ diff }: { diff: NodeDiff }) {
  if (!diff.hasDiff) {
    return null;
  }
  const label = diff.inside > 0 ? `Δ ${diff.inside}` : "Δ";
  const title = diff.inside > 0 ? `${diff.inside} changed in this PR inside` : "changed in this PR";
  return (
    <span style={CHIP} title={title}>
      {label}
    </span>
  );
}

const CHIP: React.CSSProperties = {
  flexShrink: 0,
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.06em",
  color: CHANGED_ACCENT,
  border: `1px solid ${CHANGED_ACCENT}66`,
  background: `${CHANGED_ACCENT}1A`,
  borderRadius: 3,
  padding: "1px 4px",
};
