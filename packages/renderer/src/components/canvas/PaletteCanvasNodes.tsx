/**
 * The command palette lives outside each graph's nested React Flow provider, so it cannot inspect
 * that provider directly. The active GraphSurface publishes its exact painted node ids here; the
 * palette reads the set only to decide whether its focus affordance is honest.
 *
 * Ownership matters because an ordinary Minimal Graph keeps its source canvas mounted underneath.
 * Only the active surface publishes, and a stale surface cleanup cannot clear a newer owner's ids.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface ActivePaletteCanvasNodes {
  owner: string | null;
  ids: ReadonlySet<string>;
}

interface PaletteCanvasNodeRegistry {
  publish(owner: string, ids: readonly string[]): void;
  clear(owner: string): void;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const NOOP_REGISTRY: PaletteCanvasNodeRegistry = {
  publish: () => undefined,
  clear: () => undefined,
};
const PaletteCanvasNodeIdsContext = createContext<ReadonlySet<string>>(EMPTY_IDS);
const PaletteCanvasNodeRegistryContext = createContext<PaletteCanvasNodeRegistry>(NOOP_REGISTRY);

export function PaletteCanvasNodeProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActivePaletteCanvasNodes>({ owner: null, ids: EMPTY_IDS });
  const publish = useCallback((owner: string, ids: readonly string[]) => {
    setActive((current) => {
      const next = new Set(ids);
      if (
        current.owner === owner
        && current.ids.size === next.size
        && [...next].every((id) => current.ids.has(id))
      ) {
        return current;
      }
      return { owner, ids: next };
    });
  }, []);
  const clear = useCallback((owner: string) => {
    setActive((current) => current.owner === owner ? { owner: null, ids: EMPTY_IDS } : current);
  }, []);
  const registry = useMemo(() => ({ publish, clear }), [clear, publish]);

  return (
    <PaletteCanvasNodeRegistryContext.Provider value={registry}>
      <PaletteCanvasNodeIdsContext.Provider value={active.ids}>
        {children}
      </PaletteCanvasNodeIdsContext.Provider>
    </PaletteCanvasNodeRegistryContext.Provider>
  );
}

export function usePaletteCanvasNodeIds(): ReadonlySet<string> {
  return useContext(PaletteCanvasNodeIdsContext);
}

export function usePaletteCanvasNodeRegistry(): PaletteCanvasNodeRegistry {
  return useContext(PaletteCanvasNodeRegistryContext);
}
