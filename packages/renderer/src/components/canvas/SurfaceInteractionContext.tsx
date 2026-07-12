/** Surface-local interaction overrides for alternate GraphSurface presentations. */

import { createContext, useContext, useMemo } from "react";
import { useBlueprint } from "../../state/StoreContext";

interface SurfaceInteractionState {
  readOnly: boolean;
  selectionOverride: ReadonlySet<string> | null;
}

const SurfaceInteractionContext = createContext<SurfaceInteractionState>({
  readOnly: false,
  selectionOverride: null,
});

export function SurfaceInteractionScope({
  readOnly,
  selectionOverride,
  children,
}: SurfaceInteractionState & { children: React.ReactNode }) {
  const value = useMemo(
    () => ({ readOnly, selectionOverride }),
    [readOnly, selectionOverride],
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

/** Frozen context surfaces keep pan/zoom/source inspection but suppress structural mutations. */
export function useSurfaceReadOnly(): boolean {
  return useContext(SurfaceInteractionContext).readOnly;
}
