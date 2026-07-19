/**
 * A global VS Code-style quick-open dialog: press Cmd+P (mac) / Ctrl+P (win/linux) in ANY view to
 * open a centered search box and type to substring-match nodes. What Enter does depends on the view:
 *
 *   - The MAP lenses (Map = "modules", Service = "call", UI = "ui") REVEAL the pick — Map/UI go to
 *     its definition, the Service lens pins + selects it — via `revealInView`, and every row carries
 *     a "+" that instead ADDS the node into the visible graph (`addToView`) without navigating,
 *     grafting an out-of-scope symbol onto the canvas (including an open Minimal Graph).
 *     ⌘/Ctrl+↵ adds from the keyboard; the palette
 *     stays open so several nodes can be added in a row.
 *   - The Logic view opens the pick's intra-procedural logic flow (`openLogicFlow`); no "+" there.
 *
 * A picked symbol is resolved to the card the lens draws (its owning unit or module) by the store, so
 * searching a bare function still reveals/adds the class or file it lives in. Mounted once by
 * BlueprintCanvas so the shortcut works everywhere; a pure overlay that only calls store actions.
 */

import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "@radix-ui/react-icons";
import type { NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { moduleGraphSurfaceOwner } from "../state/store";
import type { ViewMode } from "../derive/edgeSelection";
import {
  GRAPH_SYMBOL_SEARCH_VERSION,
  type GraphSymbolEntry as SymbolEntry,
  type GraphSymbolScopeCounts as SearchScopeCounts,
  type GraphSymbolSearchScope as SearchScope,
} from "../graph/graphSymbolSearch";

export {
  collectSymbols,
  countSymbolScopes as countSearchScopes,
  selectSymbolResults as selectResults,
} from "../graph/graphSymbolSearch";
export type { GraphSymbolEntry as SymbolEntry, GraphSymbolSearchScope as SearchScope } from "../graph/graphSymbolSearch";

// The map lenses: here a pick is REVEALED (navigate) or ADDED ("+") into the current graph.
const MAP_VIEWS: ReadonlySet<ViewMode> = new Set<ViewMode>(["call", "modules", "ui"]);
const SEARCH_DEBOUNCE_MS = 120;
const EMPTY_SCOPE_COUNTS: SearchScopeCounts = { public: 0, all: 0, private: 0 };

const SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ id: SearchScope; label: string }> = [
  { id: "public", label: "Public" },
  { id: "all", label: "All symbols" },
  { id: "private", label: "Private only" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  // The global shortcut. Cmd/Ctrl+P is the browser's Print dialog, so preventDefault is CRITICAL —
  // without it the print window steals the keystroke and the palette never opens. Pressing it again
  // toggles the palette shut. Registered once (functional setState needs no `open` in deps).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the closed shell independent of artifact/index. Mounting the body only while visible means
  // its repo-wide searchable collection is released as soon as the palette closes.
  return open ? <OpenCommandPaletteGate onClose={() => setOpen(false)} /> : null;
}

function OpenCommandPaletteGate({ onClose }: { onClose: () => void }) {
  const enabled = useBlueprint((state) => (
    moduleGraphSurfaceOwner(state) !== "prepared-review-empty"
    && !(state.prPreparedArtifactCurrent && state.prPreparedReviewCursor === null)
  ));
  useEffect(() => {
    if (!enabled) onClose();
  }, [enabled, onClose]);
  return enabled ? <OpenCommandPalette onClose={onClose} /> : null;
}

function OpenCommandPalette(props: { onClose: () => void }) {
  const viewMode = useBlueprint((state) => state.viewMode);
  const activeProjectionGraphId = useBlueprint((state) => state.activeProjectionGraphId);
  const { openPaletteLogicFlow, revealInView, addToView, searchSymbols } = useBlueprintActions();
  // In a map lens, the palette reveals/adds a graph node; elsewhere it opens a logic flow.
  const isMap = MAP_VIEWS.has(viewMode);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [scope, setScope] = useState<SearchScope>("public");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [results, setResults] = useState<SymbolEntry[]>([]);
  const [scopeCounts, setScopeCounts] = useState<SearchScopeCounts>(EMPTY_SCOPE_COUNTS);
  const [searchStatus, setSearchStatus] = useState<"loading" | "ready" | "error">("loading");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resultGraphId, setResultGraphId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  // Server sessions search the immutable repository catalog; local embedders deliberately search
  // only their already-bounded active projection. Every request is abortable and results live only
  // for this mounted palette body, so closing the shell releases them immediately.
  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    setScopeCounts(EMPTY_SCOPE_COUNTS);
    setResultGraphId(null);
    setSearchStatus("loading");
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void searchSymbols({
        version: GRAPH_SYMBOL_SEARCH_VERSION,
        query,
        mode: isMap ? "map" : "logic",
        scope,
      }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setResults(result.results);
        setScopeCounts(result.scopeCounts);
        setResultGraphId(result.graphId);
        setSearchStatus("ready");
      }, (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setSearchStatus("error");
        setSearchError(error instanceof Error ? error.message : "Symbol search is unavailable.");
      });
    }, query.trim().length === 0 ? 0 : SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeProjectionGraphId, isMap, query, scope, searchSymbols]);

  // Typing or changing the search scope shifts the result set, so re-prime the highlight.
  useEffect(() => {
    setHighlighted(0);
  }, [query, scope]);
  // Keep the highlighted row in view as arrow keys walk past the fold. Block body is REQUIRED: a
  // concise arrow would return scrollIntoView's result, which React treats as a cleanup function and
  // invokes on the next run — in browsers where it returns a non-undefined value that crashes.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted, results]);

  // Enter/click a row: a map lens reveals it (go-to / pin+select), logic/ui opens its logic flow. Close.
  const openPick = async (id: NodeId) => {
    try {
      if (isMap) {
        await revealInView(id, resultGraphId);
      } else {
        await openPaletteLogicFlow(id, resultGraphId);
      }
      props.onClose();
    } catch (error) {
      setSearchStatus("error");
      setSearchError(error instanceof Error ? error.message : "Could not open this symbol.");
    }
  };
  // The "+" (map lenses only): add the node to the visible graph WITHOUT navigating. Stay open so a
  // reader can add several nodes before dismissing to see the result on the canvas.
  const addPick = async (id: NodeId) => {
    try {
      await addToView(id, resultGraphId);
    } catch (error) {
      setSearchStatus("error");
      setSearchError(error instanceof Error ? error.message : "Could not add this symbol.");
    }
  };

  // Arrow keys move the highlight (clamped to the list); Enter reveals it, ⌘/Ctrl+Enter adds it (map
  // lenses); Escape closes. Option/Alt+P opens the extensible scope menu without changing the query.
  // preventDefault on the arrows stops the caret jumping to the input's ends.
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey && event.code === "KeyP") {
      event.preventDefault();
      setScopeMenuOpen(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((row) => Math.min(row + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((row) => Math.max(row - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = results[highlighted];
      if (!pick) {
        return;
      }
      if (isMap && (event.metaKey || event.ctrlKey)) {
        addPick(pick.id);
      } else {
        void openPick(pick.id);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  // Backdrop click closes; clicks inside the dialog are swallowed so they don't reach it.
  return (
    <div style={BACKDROP_STYLE} onClick={props.onClose}>
      <div style={DIALOG_STYLE} role="dialog" aria-modal aria-label={isMap ? "Reveal or add a node in the current view" : "Open a symbol's logic flow"} onClick={(e) => e.stopPropagation()}>
        <div style={SEARCH_HEADER_STYLE}>
          <input
            ref={inputRef}
            style={INPUT_STYLE}
            autoFocus
            placeholder={isMap ? "Reveal a node — Enter to go there, + to add it here…" : "Search a symbol to open its logic flow…"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <SearchScopeControl
            scope={scope}
            counts={scopeCounts}
            open={scopeMenuOpen}
            onOpenChange={setScopeMenuOpen}
            onScopeChange={setScope}
            onReturnToInput={() => inputRef.current?.focus()}
          />
        </div>
        <div style={LIST_STYLE} aria-busy={searchStatus === "loading"}>
          {searchStatus === "loading" ? (
            <div style={EMPTY_STYLE} role="status" aria-live="polite">Searching symbols…</div>
          ) : searchStatus === "error" ? (
            <div style={EMPTY_STYLE} role="alert">{searchError ?? "Symbol search is unavailable."}</div>
          ) : results.length > 0 ? (
            results.map((entry, row) => (
              <ResultRow
                key={entry.id}
                entry={entry}
                active={row === highlighted}
                canAdd={isMap}
                activeRef={row === highlighted ? activeRowRef : undefined}
                onHover={() => setHighlighted(row)}
                onOpen={() => { void openPick(entry.id); }}
                onAdd={() => { void addPick(entry.id); }}
              />
            ))
          ) : (
            <div style={EMPTY_STYLE}>No node matches “{query.trim()}”.</div>
          )}
        </div>
        <div style={FOOTER_STYLE}>{isMap ? "↑↓ navigate · ↵ reveal · ⌘↵ add · esc close" : "↑↓ navigate · ↵ open · esc close"}</div>
      </div>
    </div>
  );
}

/** The compact, extensible scope selector. It shares the input row so results stay visually primary. */
export function SearchScopeControl(props: {
  scope: SearchScope;
  counts: SearchScopeCounts;
  open: boolean;
  onOpenChange(open: boolean): void;
  onScopeChange(scope: SearchScope): void;
  onReturnToInput(): void;
}) {
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = SEARCH_SCOPE_OPTIONS.findIndex((option) => option.id === props.scope);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setActiveIndex(selectedIndex);
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
  }, [props.open, selectedIndex]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const closeFromOutside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        props.onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [props.open, props.onOpenChange]);

  if (props.counts.private === 0) {
    return null;
  }

  const focusOption = (index: number) => {
    const next = (index + SEARCH_SCOPE_OPTIONS.length) % SEARCH_SCOPE_OPTIONS.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };
  const closeToInput = () => {
    props.onOpenChange(false);
    requestAnimationFrame(props.onReturnToInput);
  };
  const selectScope = (scope: SearchScope) => {
    props.onScopeChange(scope);
    closeToInput();
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, option: SearchScope) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(SEARCH_SCOPE_OPTIONS.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeToInput();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectScope(option);
    }
  };
  const activeLabel = SEARCH_SCOPE_OPTIONS[selectedIndex]?.label ?? "Public";

  return (
    <div ref={wrapRef} style={SCOPE_CONTROL_STYLE}>
      <button
        type="button"
        style={SCOPE_BUTTON_STYLE}
        aria-label={`Search scope: ${activeLabel}`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-controls={menuId}
        aria-keyshortcuts="Alt+P"
        title="Choose search scope (⌥P)"
        onClick={() => props.open ? closeToInput() : props.onOpenChange(true)}
      >
        <span>{activeLabel}</span>
        <ChevronDownIcon width={15} height={15} aria-hidden="true" />
      </button>
      <kbd style={SCOPE_SHORTCUT_STYLE} aria-hidden="true">⌥P</kbd>
      {props.open ? (
        <div id={menuId} role="menu" aria-label="Search scope" style={SCOPE_MENU_STYLE}>
          {SEARCH_SCOPE_OPTIONS.map((option, index) => {
            const selected = option.id === props.scope;
            return (
              <button
                key={option.id}
                ref={(node) => { optionRefs.current[index] = node; }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={activeIndex === index ? 0 : -1}
                style={scopeMenuItemStyle(activeIndex === index, selected)}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => onMenuKeyDown(event, option.id)}
                onClick={() => selectScope(option.id)}
              >
                <span style={SCOPE_CHECK_STYLE}>{selected ? <CheckIcon width={14} height={14} aria-hidden="true" /> : null}</span>
                <span style={SCOPE_OPTION_LABEL_STYLE}>{option.label}</span>
                <span style={SCOPE_COUNT_STYLE}>{props.counts[option.id]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** One result: name over a faint (mono) qualified name/path, a step-count chip when it has a flow, a
 * kind tag, and — in a map lens — a "+" that adds the node to the current view without navigating. */
function ResultRow(props: {
  entry: SymbolEntry;
  active: boolean;
  canAdd: boolean;
  activeRef?: React.Ref<HTMLDivElement>;
  onHover: () => void;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const { entry } = props;
  return (
    <div ref={props.activeRef} style={props.active ? ROW_ACTIVE_STYLE : ROW_STYLE} onMouseEnter={props.onHover}>
      <button type="button" style={ROW_MAIN_BUTTON_STYLE} title={entry.id} onClick={props.onOpen}>
        <span style={ROW_MAIN_STYLE}>
          <span style={ROW_NAME_STYLE}>{entry.displayName}</span>
          <span style={ROW_SECONDARY_STYLE}>{entry.qualifiedName || entry.file}</span>
        </span>
      </button>
      {entry.stepCount !== null ? <span style={STEP_CHIP_STYLE}>{entry.stepCount} steps</span> : null}
      <span style={kindTagStyle(entry.kind)}>{entry.kind}</span>
      {props.canAdd ? (
        <button
          type="button"
          style={ADD_BUTTON_STYLE}
          title="Add this node to the current view"
          aria-label={`Add ${entry.displayName} to the current view`}
          onClick={(event) => {
            event.stopPropagation();
            props.onAdd();
          }}
        >
          +
        </button>
      ) : null}
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

// The palette floats above every view (and the code modal at zIndex 30), pinned near the top-center
// like VS Code's quick-open. Mounted in BlueprintCanvas's relative wrapper, so it's absolute-anchored.
const BACKDROP_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(8,10,14,0.6)",
  zIndex: 50,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
};
const DIALOG_STYLE: React.CSSProperties = {
  width: "90%",
  maxWidth: 640,
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "#12171E",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  overflow: "visible",
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
};
const SEARCH_HEADER_STYLE: React.CSSProperties = {
  position: "relative",
  zIndex: 3,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  minHeight: 42,
  background: "#10151C",
  borderBottom: "1px solid #2A2F37",
  borderRadius: "11px 11px 0 0",
};
const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 42,
  boxSizing: "border-box",
  font: "inherit",
  fontSize: 15,
  padding: "0 14px",
  background: "transparent",
  border: "none",
  color: "#E6EDF3",
  outline: "none",
};
const SCOPE_CONTROL_STYLE: React.CSSProperties = {
  position: "relative",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginRight: 10,
};
const SCOPE_BUTTON_STYLE: React.CSSProperties = {
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "0 9px 0 11px",
  border: "1px solid #3A424D",
  borderRadius: 7,
  background: "#151B23",
  color: "#E6EDF3",
  font: "inherit",
  fontSize: 12.5,
  fontWeight: 500,
  whiteSpace: "nowrap",
  cursor: "pointer",
};
const SCOPE_SHORTCUT_STYLE: React.CSSProperties = {
  height: 24,
  minWidth: 31,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 6px",
  border: "1px solid #303743",
  borderRadius: 6,
  background: "#10151C",
  color: "#7B8695",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  lineHeight: 1,
};
const SCOPE_MENU_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: "max(-116px, calc(40px - 10vw))",
  zIndex: 10,
  width: 190,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 5,
  border: "1px solid #343D49",
  borderRadius: 10,
  background: "rgba(17,22,29,0.98)",
  boxShadow: "0 12px 32px rgba(0,0,0,0.48)",
};
const SCOPE_CHECK_STYLE: React.CSSProperties = {
  width: 14,
  height: 14,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
const SCOPE_OPTION_LABEL_STYLE: React.CSSProperties = { flex: 1, minWidth: 0, textAlign: "left" };
const SCOPE_COUNT_STYLE: React.CSSProperties = {
  flexShrink: 0,
  color: "#9AA4B2",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
};
const LIST_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minHeight: 0,
  padding: 6,
  overflowY: "auto",
};
const EMPTY_STYLE: React.CSSProperties = { fontSize: 12, color: "#6C7683", padding: "10px 8px" };
const FOOTER_STYLE: React.CSSProperties = {
  flexShrink: 0,
  borderTop: "1px solid #2A2F37",
  padding: "6px 12px",
  fontSize: 10,
  color: "#6C7683",
  background: "#10151C",
};

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  padding: "6px 10px",
};
const ROW_ACTIVE_STYLE: React.CSSProperties = { ...ROW_STYLE, background: "#1D2733", border: "1px solid #2A2F37" };
// The row's main click target (reveal/open) — a borderless button filling the row minus the trailing
// chips/tag/add, so the name area is one big hit box.
const ROW_MAIN_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flex: 1,
  minWidth: 0,
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: "#9AA4B2",
  padding: 0,
  cursor: "pointer",
  font: "inherit",
};
const ROW_MAIN_STYLE: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 };
const ROW_NAME_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: "#E6EDF3",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const ROW_SECONDARY_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#6C7683",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const STEP_CHIP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  fontWeight: 600,
  color: "#56C271",
  border: "1px solid #2C4133",
  borderRadius: 4,
  padding: "1px 6px",
};
const KIND_TAG_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  border: "1px solid #2A2F37",
  borderRadius: 4,
  padding: "1px 6px",
  color: "#7B8695",
};
// The "+" affordance: a compact square button that adds the row's node to the current view. Accented
// so it reads as the secondary action next to the primary (row) click.
const ADD_BUTTON_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 22,
  height: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 15,
  lineHeight: 1,
  fontWeight: 600,
  borderRadius: 5,
  border: "1px solid #2C4133",
  background: "#14261B",
  color: "#56C271",
  cursor: "pointer",
  font: "inherit",
};

// Accent the module tag green — a module's top-level flow is the app/boot init, the place to start.
function kindTagStyle(kind: string): React.CSSProperties {
  if (kind !== "module") {
    return KIND_TAG_STYLE;
  }
  return { ...KIND_TAG_STYLE, color: "#56C271", borderColor: "#2C4133" };
}

function scopeMenuItemStyle(active: boolean, selected: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 34,
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "0 9px",
    border: "none",
    borderRadius: 6,
    background: active || selected ? "#222B38" : "transparent",
    color: selected || active ? "#E6EDF3" : "#B0BAC6",
    font: "inherit",
    fontSize: 12.5,
    cursor: "pointer",
  };
}
