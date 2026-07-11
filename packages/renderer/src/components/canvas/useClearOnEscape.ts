/**
 * Clear/close on Escape as a LAYERED stack: many surfaces mount this hook at once (the minimal-graph
 * overlay, the code modal opened on top of it, the wire inspector, the PR detail panel), but a single
 * Escape must close only the TOPMOST one. Each active consumer pushes a token onto a shared module
 * stack on mount and removes it on unmount/inactive; a keypress fires `clear()` only for the token
 * currently on top, so the modal-over-overlay case closes the modal first and the overlay next.
 * Never preventDefault (a surface's own Escape must still fire); ignore Escape typed into an editable
 * field. The token is pushed once per active period (not per render), so an inline `clear` callback
 * that changes identity every render never reorders the stack.
 */

import { useEffect, useRef } from "react";

const layers: symbol[] = [];

export function useClearOnEscape(clear: () => void, active: boolean): void {
  // Keep the latest callback in a ref so the effect depends only on `active`: re-pushing the token on
  // every `clear`-identity change would let a re-rendering lower layer jump above a higher one.
  const clearRef = useRef(clear);
  clearRef.current = clear;
  useEffect(() => {
    if (!active) {
      return;
    }
    const token = Symbol("escape-layer");
    layers.push(token);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isEditableTarget(event.target)) {
        return;
      }
      if (layers[layers.length - 1] === token) {
        clearRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const at = layers.indexOf(token);
      if (at !== -1) {
        layers.splice(at, 1);
      }
    };
  }, [active]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable;
}
