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

/** `maxZoom` caps how far a fit may zoom IN — pass it where the selection can be a single small
 * node (a method card), so "center on it" never becomes a full-viewport close-up. `enabled: false`
 * mutes a surface's reaction while it is NOT the active canvas (e.g. the Map underneath the
 * minimal overlay) — with two subscribers in one provider, the muted one would otherwise fit last
 * and win. */
export function useRecenter(selectedIds: readonly string[], options?: { maxZoom?: number; enabled?: boolean }): void {
  const recenterSeq = useBlueprint((state) => state.recenterSeq);
  const { fitView, getNode } = useReactFlow();
  // Always read the CURRENT selection when the signal fires — not the value captured when the effect
  // was last declared — so the fit targets what's selected at click time, not at last render.
  const latestIds = useRef(selectedIds);
  latestIds.current = selectedIds;
  const maxZoom = options?.maxZoom;
  const enabled = options?.enabled ?? true;
  const seenInitial = useRef(false);

  useEffect(() => {
    if (!seenInitial.current) {
      seenInitial.current = true; // the mount value is the baseline, not a recenter request.
      return;
    }
    if (!enabled) {
      return; // still consumes the seq baseline above, so re-enabling never replays an old bump.
    }
    // Drop selected ids with no node on screen so a stale/hidden selection falls back to the whole
    // graph rather than fitting to nothing (React Flow ignores unknown ids and would no-op).
    const present = latestIds.current.filter((id) => getNode(id) !== undefined);
    void fitView({
      ...FIT_OPTIONS,
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      nodes: present.length > 0 ? present.map((id) => ({ id })) : undefined,
    });
  }, [recenterSeq, fitView, getNode, maxZoom, enabled]);
}
