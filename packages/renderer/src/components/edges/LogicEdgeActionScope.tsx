import { createContext, useContext, type ReactNode } from "react";

type ToggleEdgeCollapse = (collapseKey: string) => void;

const LogicEdgeActionContext = createContext<ToggleEdgeCollapse | null>(null);

/** Surface-local edge action routing. The full Logic lens and every split pane keep independent
 * collapsed-edge state while sharing the exact same edge and continuation-node components. */
export function LogicEdgeActionScope({
  toggleCollapse,
  children,
}: {
  toggleCollapse: ToggleEdgeCollapse;
  children: ReactNode;
}) {
  return (
    <LogicEdgeActionContext.Provider value={toggleCollapse}>
      {children}
    </LogicEdgeActionContext.Provider>
  );
}

export function useLogicEdgeCollapseAction(): ToggleEdgeCollapse | null {
  return useContext(LogicEdgeActionContext);
}

/** Keep keyboard focus on the same semantic path after ELK replaces an expanded edge with a fold
 * node (or vice versa). Mouse activation deliberately does not use this handoff, so it never paints
 * a surprise focus ring after a pointer click. */
export function handoffLogicEdgeDisclosureFocus(
  collapseKey: string,
  state: "expanded" | "collapsed",
): void {
  if (typeof document === "undefined" || typeof requestAnimationFrame === "undefined") return;
  let attempts = 0;
  const findDisclosure = () => {
    const target = Array.from(document.querySelectorAll<HTMLButtonElement>(
      `button[data-logic-edge-disclosure="true"][data-edge-disclosure-state="${state}"]`,
    )).find((button) => button.dataset.edgeCollapseKey === collapseKey);
    if (target) {
      target.focus();
      return;
    }
    attempts += 1;
    if (attempts < 90) requestAnimationFrame(findDisclosure);
  };
  requestAnimationFrame(findDisclosure);
}
