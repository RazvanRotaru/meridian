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
 * minimal overlay), preserving that covered surface's viewport for the outward handoff. */
export function useRecenter(selectedIds: readonly string[], options?: { maxZoom?: number; enabled?: boolean }): void {
  const recenterSeq = useBlueprint((state) => state.recenterSeq);
  const { fitView, getNode } = useReactFlow();
  // Always read the CURRENT selection when the signal fires — not the value captured when the effect
  // was last declared — so the fit targets what's selected at click time, not at last render.
  const latestIds = useRef(selectedIds);
  latestIds.current = selectedIds;
  const maxZoom = options?.maxZoom;
  const enabled = options?.enabled ?? true;
  // Track the signal itself, not merely whether the effect has run. `enabled` changes when an
  // overlay covers/reveals a still-mounted source surface; that visibility change must preserve the
  // source viewport rather than masquerade as a new recenter request.
  const seenSeq = useRef(recenterSeq);

  useEffect(() => {
    const requested = shouldApplyRecenter(seenSeq.current, recenterSeq, enabled);
    seenSeq.current = recenterSeq;
    if (!requested) {
      return; // mount, cover/reveal, and signals consumed while covered do not fit the viewport.
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

/** Pure signal gate: visibility changes never fabricate a request, and a real request seen while
 * covered is consumed rather than replayed when the source surface is revealed. */
export function shouldApplyRecenter(seenSeq: number, currentSeq: number, enabled: boolean): boolean {
  return currentSeq !== seenSeq && enabled;
}
