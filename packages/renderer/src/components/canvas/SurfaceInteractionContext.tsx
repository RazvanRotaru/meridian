/** Surface-local interaction overrides for alternate GraphSurface presentations. */

import { createContext, useContext, useMemo } from "react";
import { useBlueprint } from "../../state/StoreContext";

interface SurfaceInteractionState {
  readOnly: boolean;
  selectionOverride: ReadonlySet<string> | null;
  /** Only PR-review graph surfaces expose node-native viewed progress controls. */
  reviewProgressEnabled: boolean;
  /** Optional presentation-local disclosure. Read-only surfaces can expose this without enabling
   * selection, navigation, or mutations in the shared module-expansion store. */
  onToggleExpand: ((nodeId: string) => void) | null;
}

const SurfaceInteractionContext = createContext<SurfaceInteractionState>({
  readOnly: false,
  selectionOverride: null,
  reviewProgressEnabled: false,
  onToggleExpand: null,
});

export function SurfaceInteractionScope({
  readOnly,
  selectionOverride,
  reviewProgressEnabled,
  onToggleExpand,
  children,
}: SurfaceInteractionState & { children: React.ReactNode }) {
  const value = useMemo(
    () => ({ readOnly, selectionOverride, reviewProgressEnabled, onToggleExpand }),
    [readOnly, reviewProgressEnabled, selectionOverride, onToggleExpand],
  );
  return (
    <SurfaceInteractionContext.Provider value={value}>
      {children}
    </SurfaceInteractionContext.Provider>
  );
}

/** A context surface can highlight its own targets without mutating the shared Map selection. */
export function useSurfaceNodeSelected(id: string): boolean {
  const override = useContext(SurfaceInteractionContext).selectionOverride;
  const selected = useBlueprint((state) => state.moduleSelected.has(id));
  return override === null ? selected : override.has(id);
}

/** Read-only context surfaces keep pan/zoom/source inspection but suppress shared mutations. */
export function useSurfaceReadOnly(): boolean {
  return useContext(SurfaceInteractionContext).readOnly;
}

/** Viewed progress belongs to the active PR-review graph, not every Map surface sharing node types. */
export function useSurfaceReviewProgressEnabled(): boolean {
  return useContext(SurfaceInteractionContext).reviewProgressEnabled;
}

/** A surface-local expand/collapse action, or null when cards should use their ordinary store
 * action (interactive surfaces) / expose no disclosure (fully frozen read-only surfaces). */
export function useSurfaceToggleExpand(): SurfaceInteractionState["onToggleExpand"] {
  return useContext(SurfaceInteractionContext).onToggleExpand;
}
