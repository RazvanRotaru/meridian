/**
 * Wire the Toolbar's "Recenter" action to a graph surface's viewport. The Toolbar lives in the
 * OUTER React Flow provider while each view mounts its own INNER one, so the button can't fitView
 * directly — it bumps `recenterSeq` in the store, and each surface calls this hook to react to the
 * bump from inside its own provider.
 *
 * On a bump it fits the viewport to `selectedIds` (whatever the surface's selection is at that
 * moment), falling back to the whole graph — the "root container" — when nothing is selected or the
 * selection isn't on screen (e.g. a card hidden by a filter). A ref guards the initial signal value
 * so mounting a surface (a tab switch) never yanks the viewport on its own.
 */

import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBlueprint } from "../../state/StoreContext";

const FIT_OPTIONS = { padding: 0.2, duration: 400, minZoom: 0.01 } as const;

export function useRecenter(selectedIds: readonly string[]): void {
  const recenterSeq = useBlueprint((state) => state.recenterSeq);
  const { fitView, getNode } = useReactFlow();
  // Always read the CURRENT selection when the signal fires — not the value captured when the effect
  // was last declared — so the fit targets what's selected at click time, not at last render.
  const latestIds = useRef(selectedIds);
  latestIds.current = selectedIds;
  const seenInitial = useRef(false);

  useEffect(() => {
    if (!seenInitial.current) {
      seenInitial.current = true; // the mount value is the baseline, not a recenter request.
      return;
    }
    // Drop selected ids with no node on screen so a stale/hidden selection falls back to the whole
    // graph rather than fitting to nothing (React Flow ignores unknown ids and would no-op).
    const present = latestIds.current.filter((id) => getNode(id) !== undefined);
    void fitView({ ...FIT_OPTIONS, nodes: present.length > 0 ? present.map((id) => ({ id })) : undefined });
  }, [recenterSeq, fitView, getNode]);
}
