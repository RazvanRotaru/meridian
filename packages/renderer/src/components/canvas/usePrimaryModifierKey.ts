import { useCallback, useEffect, useMemo, useState } from "react";

export type PrimaryModifierEvent = Pick<KeyboardEvent | MouseEvent, "ctrlKey" | "metaKey">;

/** Browser-neutral primary modifier: Control on Windows/Linux and Command on macOS. */
export function primaryModifierPressed(event: PrimaryModifierEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export interface PrimaryModifierKeyState {
  pressed: boolean;
  /** Reconcile state from a pointer event and return the event's effective modifier value. */
  sync(event: PrimaryModifierEvent): boolean;
}

/**
 * Track the primary modifier while an interaction surface is active. Pointer movement is included
 * because a browser can regain focus after the key was already pressed and therefore miss keydown.
 */
export function usePrimaryModifierKey(enabled: boolean): PrimaryModifierKeyState {
  const [pressed, setPressed] = useState(false);
  const sync = useCallback((event: PrimaryModifierEvent) => {
    const next = enabled && primaryModifierPressed(event);
    setPressed((current) => current === next ? current : next);
    return next;
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setPressed(false);
      return;
    }
    const update = (event: KeyboardEvent | MouseEvent) => { sync(event); };
    const clear = () => { setPressed(false); };
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("mousemove", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("mousemove", update);
      window.removeEventListener("blur", clear);
    };
  }, [enabled, sync]);

  return useMemo(() => ({ pressed, sync }), [pressed, sync]);
}
