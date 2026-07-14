/** Surface-local interaction overrides for alternate GraphSurface presentations. */

import { createContext, useContext, useMemo } from "react";
import { useBlueprint } from "../../state/StoreContext";

interface SurfaceInteractionState {
  readOnly: boolean;
  selectionOverride: ReadonlySet<string> | null;
  /** Only PR-review graph surfaces expose node-native viewed progress controls. */
  reviewProgressEnabled: boolean;
}

const SurfaceInteractionContext = createContext<SurfaceInteractionState>({
  readOnly: false,
  selectionOverride: null,
  reviewProgressEnabled: false,
});

export function SurfaceInteractionScope({
  readOnly,
  selectionOverride,
  reviewProgressEnabled,
  children,
}: SurfaceInteractionState & { children: React.ReactNode }) {
  const value = useMemo(
    () => ({ readOnly, selectionOverride, reviewProgressEnabled }),
    [readOnly, reviewProgressEnabled, selectionOverride],
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
