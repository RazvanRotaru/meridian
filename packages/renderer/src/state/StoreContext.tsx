/**
 * Expose the vanilla zustand store to React. One store instance is created per boot (it holds
 * the loaded artifact), so it travels through context rather than living as a module global.
 */

import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import type { BlueprintState, BlueprintStore } from "./store";

const StoreContext = createContext<BlueprintStore | null>(null);

export function StoreProvider(props: { store: BlueprintStore; children: ReactNode }) {
  return <StoreContext.Provider value={props.store}>{props.children}</StoreContext.Provider>;
}

function useStoreApi(): BlueprintStore {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error("useBlueprint must be used within a StoreProvider");
  }
  return store;
}

export function useBlueprint<Selected>(selector: (state: BlueprintState) => Selected): Selected {
  return useStore(useStoreApi(), selector);
}

/** Read store actions without subscribing to a slice — actions are stable for the store's life. */
export function useBlueprintActions(): BlueprintState {
  return useStoreApi().getState();
}
