/**
 * Clear/close on Escape, but only while something IS active — otherwise the listener stays off so
 * the key is free for other handlers. Never preventDefault (a modal's own Escape must still fire);
 * ignore Escape typed into an editable field. Shared by the PR-review graph pane (clears the flow
 * selection + file filter) and the minimal-graph overlay (closes it).
 */

import { useEffect } from "react";

export function useClearOnEscape(clear: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        clear();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clear, active]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}
