/**
 * Wire the Toolbar's "Recenter" action to a graph surface's viewport. The Toolbar lives in the
 * OUTER React Flow provider while each view mounts its own INNER one, so the button can't fitView
 * directly — it bumps `recenterSeq` in the store, and each surface calls this hook to react to the
 * bump from inside its own provider.
 *
 * On a normal bump it fits the viewport to `selectedIds` (whatever the surface's selection is at
 * that moment), falling back to the whole graph — the "root container" — when nothing is selected or
 * the selection isn't on screen. A palette focus bump instead fits only its explicit target and
 * becomes a no-op if that node disappeared before the active surface consumed the request. A ref
 * guards the initial signal value so mounting a surface (a tab switch) never yanks the viewport.
 */

import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBlueprint } from "../../state/StoreContext";

const FIT_OPTIONS = { padding: 0.2, duration: 400, minZoom: 0.01 } as const;
const PALETTE_FOCUS_MAX_ZOOM = 1.25;

/** `maxZoom` caps how far a fit may zoom IN — pass it where the selection can be a single small
 * node (a method card), so "center on it" never becomes a full-viewport close-up. `enabled: false`
 * mutes a surface's reaction while it is NOT the active canvas (e.g. the Map underneath the
 * minimal overlay), preserving that covered surface's viewport for the outward handoff. */
export function useRecenter(selectedIds: readonly string[], options?: { maxZoom?: number; enabled?: boolean }): void {
  const recenterSeq = useBlueprint((state) => state.recenterSeq);
  const recenterTargetId = useBlueprint((state) => state.recenterTargetId);
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
    const nodes = resolveRecenterNodes(
      recenterTargetId,
      latestIds.current,
      (id) => getNode(id) !== undefined,
    );
    if (nodes === null) {
      return; // An explicit target lost a paint/layout race; never turn that request into "fit all".
    }
    // A single small card can otherwise hit React Flow's 4× ceiling. Keep enough surrounding graph
    // visible for navigation; mounts with a stricter cap (review/request surfaces) still win.
    const targetMaxZoom = recenterTargetId === null
      ? maxZoom
      : Math.min(maxZoom ?? PALETTE_FOCUS_MAX_ZOOM, PALETTE_FOCUS_MAX_ZOOM);
    void fitView({
      ...FIT_OPTIONS,
      ...(targetMaxZoom !== undefined ? { maxZoom: targetMaxZoom } : {}),
      nodes,
    });
  }, [recenterSeq, recenterTargetId, fitView, getNode, maxZoom, enabled]);
}

/** Resolve one signal against the nodes owned by the active React Flow instance. `null` means an
 * explicit target vanished and the request must stop; `undefined` retains normal whole-graph fit. */
export function resolveRecenterNodes(
  targetId: string | null,
  selectedIds: readonly string[],
  hasNode: (id: string) => boolean,
): Array<{ id: string }> | undefined | null {
  if (targetId !== null) {
    return hasNode(targetId) ? [{ id: targetId }] : null;
  }
  const present = selectedIds.filter(hasNode);
  return present.length > 0 ? present.map((id) => ({ id })) : undefined;
}

/** Pure signal gate: visibility changes never fabricate a request, and a real request seen while
 * covered is consumed rather than replayed when the source surface is revealed. */
export function shouldApplyRecenter(seenSeq: number, currentSeq: number, enabled: boolean): boolean {
  return currentSeq !== seenSeq && enabled;
}
