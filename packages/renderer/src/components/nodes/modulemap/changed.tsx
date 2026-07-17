/**
 * The Map's diff overlay: a status-coloured ring + body wash a CODE BLOCK wears when it is in the
 * diff. Reads the store's changed sets by node id (the view-agnostic signal every lens shares, built
 * once in graphIndex): `changedStatus` gives the kind (added green / modified gold / deleted red).
 * Only directly-touched blocks are coloured — a file/module that merely CONTAINS changes is left
 * uncoloured (it shows a "+N -M" marker before its name instead). Change status owns the inner
 * border; selection remains independently visible as the neutral outer ring.
 */

import type { ChangeStatus } from "@meridian/core";
import { useBlueprint } from "../../../state/StoreContext";
import { changedColor, changedFill } from "../../ChangedBadge";

export interface NodeDiff {
  /** This exact node is in the diff (its span overlapped a changed line range, or it's a touched file). */
  changed: boolean;
  /** Changed nodes strictly inside this node — a collapsed/aggregating card's hidden edits. */
  inside: number;
  /** The change kind for THIS node, when known; absent for a container that only contains changes. */
  status?: ChangeStatus;
  hasDiff: boolean;
}

/** The diff state for one Map node, keyed by its (real) graph node id. */
export function useNodeDiff(id: string): NodeDiff {
  const direct = useBlueprint((state) => state.index.changedIds.has(id));
  const status = useBlueprint((state) => state.index.changedStatus.get(id));
  const inside = useBlueprint((state) => state.index.changedDescendants.get(id) ?? 0);
  const changed = direct || status !== undefined;
  return { changed, inside, status, hasDiff: changed || inside > 0 };
}

/** Repaint a card/frame in its change-status colour (green added / gold modified / red deleted): a
 * solid border, a soft outer ring, and a warm body wash layered OVER the card's own dark background. */
export function changedBorder(base: React.CSSProperties, color: string): React.CSSProperties {
  return {
    ...base,
    borderColor: color,
    boxShadow: `0 0 0 1px ${color}66`,
    backgroundImage: `linear-gradient(0deg, ${changedFill(color)}, ${changedFill(color)})`,
  };
}

/** Pick the two independent node signals: a directly-changed node keeps its semantic status on the
 * inner border/body, while selection contributes only its neutral outer halo. This matters most for
 * base-only tombstones: selecting a removed file must never repaint deleted red as a kind accent. */
export function borderFor(base: React.CSSProperties, selectedStyle: React.CSSProperties, selected: boolean, diff: NodeDiff): React.CSSProperties {
  if (diff.status !== undefined) {
    const changed = changedBorder(base, changedColor(diff.status));
    const selectionHalo = selected ? selectedStyle.boxShadow : undefined;
    return selectionHalo === undefined
      ? changed
      : { ...changed, boxShadow: `${String(changed.boxShadow)}, ${String(selectionHalo)}` };
  }
  return selected ? selectedStyle : base;
}

/** The Δ chip was removed — the status ring + body wash carry the "touched" signal on their own.
 * Kept as a no-op stub so the card nodes that render it need no edit (and it's easy to reinstate). */
export function DeltaChip(_props: { diff: NodeDiff }): null {
  return null;
}
