import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FLOATING_SOURCE_WINDOW_ID,
  FLOATING_SOURCE_WINDOW_LAYER_ID,
} from "./FloatingSourceWindow";
import {
  shouldOpenSourceSearchFromShortcut,
  sourceSearchMatches,
  sourceSearchNavigationIndex,
  type SourceSearchMatch,
  type SourceSearchResult,
} from "./sourceSearch";

export interface SourceSearchController {
  activeIndex: number;
  activeMatch: SourceSearchMatch | undefined;
  close: (restoreFocus?: boolean) => void;
  inputRef: { current: HTMLInputElement | null };
  matches: readonly SourceSearchMatch[];
  move: (direction: 1 | -1) => void;
  open: boolean;
  openSearch: () => void;
  query: string;
  result: SourceSearchResult;
  setQuery: (query: string) => void;
  triggerRef: { current: HTMLButtonElement | null };
}

export function useSourceSearch(args: {
  code: string;
  enabled: boolean;
  hiddenLines: ReadonlySet<number>;
  lineCount: number;
  /** A compact related overlay temporarily owns the floating window's focus and shortcut layer. */
  shortcutBlocked?: boolean;
  /** Sticky source views share the workspace, so their find shortcut is focus-owned. */
  shortcutScope: "source" | "document";
  sourceIdentity: object;
  startLine: number;
}): SourceSearchController {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [storedActiveIndex, setStoredActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const result = useMemo(
    () => sourceSearchMatches(args.code, query, args.startLine, args.lineCount, args.hiddenLines),
    [args.code, args.hiddenLines, args.lineCount, args.startLine, query],
  );
  const matches = result.matches;
  const activeIndex = matches.length === 0
    ? -1
    : storedActiveIndex >= 0 && storedActiveIndex < matches.length ? storedActiveIndex : 0;
  const activeMatch = activeIndex >= 0 ? matches[activeIndex] : undefined;

  const cancelFocusFrame = useCallback(() => {
    if (focusFrameRef.current === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = null;
  }, []);
  const scheduleFocus = useCallback((target: "input" | "trigger") => {
    if (typeof window === "undefined") return;
    cancelFocusFrame();
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (target === "input") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        triggerRef.current?.focus({ preventScroll: true });
      }
    });
  }, [cancelFocusFrame]);
  const openSearch = useCallback(() => {
    setOpen(true);
    scheduleFocus("input");
  }, [scheduleFocus]);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) scheduleFocus("trigger");
    else cancelFocusFrame();
  }, [cancelFocusFrame, scheduleFocus]);

  useEffect(() => {
    setOpen(false);
    setQuery("");
    setStoredActiveIndex(-1);
    cancelFocusFrame();
  }, [args.sourceIdentity, cancelFocusFrame]);
  useEffect(() => {
    setStoredActiveIndex(matches.length > 0 ? 0 : -1);
  }, [matches]);
  useEffect(() => () => cancelFocusFrame(), [cancelFocusFrame]);

  useEffect(() => {
    if (!args.enabled || typeof window === "undefined") return;
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (args.shortcutBlocked) return;
      const sourceLayer = document.getElementById(FLOATING_SOURCE_WINDOW_LAYER_ID);
      const sourceOwnsShortcut = args.shortcutScope === "document"
        || (event.target instanceof Node && sourceLayer?.contains(event.target) === true);
      const blockingModalOpen = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
        .some((modal) => modal.id !== FLOATING_SOURCE_WINDOW_ID);
      if (!shouldOpenSourceSearchFromShortcut(event, blockingModalOpen, sourceOwnsShortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    };
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [args.enabled, args.shortcutBlocked, args.shortcutScope, openSearch]);

  // Search is a child layer of the persistent dock. Capture Escape so it closes before the dock's
  // listener, including when focus is on a search navigation button rather than the input.
  useEffect(() => {
    if (!args.enabled || !open || typeof window === "undefined") return;
    const closeSearchFromEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const sourceLayer = document.getElementById(FLOATING_SOURCE_WINDOW_LAYER_ID);
      if (event.target instanceof Node && sourceLayer !== null && !sourceLayer.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", closeSearchFromEscape, true);
    return () => window.removeEventListener("keydown", closeSearchFromEscape, true);
  }, [args.enabled, close, open]);

  return {
    activeIndex,
    activeMatch,
    close,
    inputRef,
    matches,
    move: (direction) => {
      setStoredActiveIndex((current) => sourceSearchNavigationIndex(current, matches.length, direction));
    },
    open,
    openSearch,
    query,
    result,
    setQuery,
    triggerRef,
  };
}
