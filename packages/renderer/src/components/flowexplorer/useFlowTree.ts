import { useMemo } from "react";
import type { LogicFlows } from "@meridian/core";
import { buildFlowTree } from "../../derive/flowTree";
import { useBlueprint } from "../../state/StoreContext";

export function useLogicFlows(): LogicFlows {
  const artifact = useBlueprint((state) => state.artifact);
  return useMemo(() => (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows, [artifact]);
}

export function useFlowTree() {
  const index = useBlueprint((state) => state.index);
  const flows = useLogicFlows();
  return useMemo(() => buildFlowTree(index, flows), [index, flows]);
}
