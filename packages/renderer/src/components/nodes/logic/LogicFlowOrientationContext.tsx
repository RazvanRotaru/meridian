import { createContext, useContext } from "react";
import type { LogicFlowOrientation } from "../../../layout/logicElk";

const LogicFlowOrientationContext = createContext<LogicFlowOrientation>("horizontal");

export const LogicFlowOrientationProvider = LogicFlowOrientationContext.Provider;

export function useLogicFlowOrientation(): LogicFlowOrientation {
  return useContext(LogicFlowOrientationContext);
}
