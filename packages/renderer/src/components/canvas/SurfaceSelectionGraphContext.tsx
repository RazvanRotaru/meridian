import { createContext, useContext, type ReactNode } from "react";
import type { Edge, Node } from "@xyflow/react";

/** The exact active-depth graph a module-family surface currently paints. Keeping this behind the
 * shared canvas lets floating actions follow relation filters, grouped ghosts, semantic depth, and
 * mount-local layouts without attempting to reconstruct presentation state from the global store. */
export interface SurfaceSelectionGraph {
  nodes: readonly Node[];
  edges: readonly Edge[];
  ready: boolean;
}

const SurfaceSelectionGraphContext = createContext<SurfaceSelectionGraph | null>(null);

export function SurfaceSelectionGraphProvider(props: {
  value: SurfaceSelectionGraph;
  children: ReactNode;
}) {
  return (
    <SurfaceSelectionGraphContext.Provider value={props.value}>
      {props.children}
    </SurfaceSelectionGraphContext.Provider>
  );
}

export function useSurfaceSelectionGraph(): SurfaceSelectionGraph | null {
  return useContext(SurfaceSelectionGraphContext);
}
