import { createContext, useContext, type ReactNode } from "react";

const LogicOccurrenceSelectionContext = createContext<ReadonlySet<string> | null>(null);

/** Layer an exact, transient occurrence selection over Logic's persisted single-target selection.
 * Null retains the established target semantics; a Set lets one-hop growth include targetless
 * control-flow nodes without changing the URL contract. */
export function LogicOccurrenceSelectionScope(props: {
  selectedIds: ReadonlySet<string> | null;
  children: ReactNode;
}) {
  return (
    <LogicOccurrenceSelectionContext.Provider value={props.selectedIds}>
      {props.children}
    </LogicOccurrenceSelectionContext.Provider>
  );
}

/** Null means no exact selection layer is active; otherwise the boolean is this occurrence's
 * membership and callers should dim non-members. */
export function useLogicOccurrenceSelection(instanceId: string): boolean | null {
  const selectedIds = useContext(LogicOccurrenceSelectionContext);
  return selectedIds === null ? null : selectedIds.has(instanceId);
}
