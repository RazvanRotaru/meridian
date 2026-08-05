/**
 * A global VS Code-style quick-open dialog: press Cmd+P (mac) / Ctrl+P (win/linux) in ANY view to
 * open a centered search box and type to substring-match nodes. What Enter does depends on the view:
 *
 *   - The MAP lenses (Map = "modules", Service = "call", UI = "ui") REVEAL the pick — Map/UI go to
 *     its definition, the Service lens pins + selects it — via `revealInView`, and every row carries
 *     a magnifier that FOCUSES an already-drawn exact node, and a "+" that instead ADDS the node
 *     into the visible graph (`addToView`) without navigating,
 *     grafting an out-of-scope symbol onto the canvas (including an open Minimal Graph).
 *     ⌘/Ctrl+↵ adds from the keyboard; the palette
 *     stays open so several nodes can be added in a row.
 *   - The Logic view opens the pick's intra-procedural logic flow (`openLogicFlow`); no "+" there.
 *
 * A picked symbol is resolved to the card the lens draws (its owning unit or module) by the store, so
 * searching a bare function still reveals/adds the class or file it lives in. Mounted once by
 * BlueprintCanvas so the shortcut works everywhere; a pure overlay that only calls store actions.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { CompactGraphSymbolEntry, GraphArtifact, GraphNode, NodeId } from "@meridian/core";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import type { ViewMode } from "../derive/edgeSelection";
import {
  countGraphSymbolSearchScopes,
  mergeGraphSymbolSearchEntries,
  queryRankedGraphSymbols,
  type GraphSymbolSearchEntry,
  type GraphSymbolSearchQueryResult,
  type GraphSymbolSearchScope,
  type GraphSymbolSearchScopeCounts,
} from "../state/graphSymbolSearch";
import { usePaletteCanvasNodeIds } from "./canvas/PaletteCanvasNodes";

// The map lenses: here a pick is REVEALED (navigate) or ADDED ("+") into the current graph.
const MAP_VIEWS: ReadonlySet<ViewMode> = new Set<ViewMode>(["call", "modules", "ui"]);
// Map mode searches every navigable node — a bare function resolves to its owning unit/module on pick.
const MAP_KINDS = new Set([
  "function",
  "method",
  "module",
  "package",
  "class",
  "interface",
  "typeAlias",
  "object",
]);
// Logic mode: only callables and modules have a meaningful logic flow to open.
const LOGIC_KINDS = new Set(["function", "method", "module"]);
export type SearchScope = GraphSymbolSearchScope;
export type SearchScopeCounts = GraphSymbolSearchScopeCounts;

const SEARCH_SCOPE_OPTIONS: ReadonlyArray<{ id: SearchScope; label: string }> = [
  { id: "public", label: "Public" },
  { id: "all", label: "All symbols" },
  { id: "private", label: "Private only" },
];

/** One searchable node row, pre-computed once so keystrokes only filter (never re-scan the graph). */
export type SymbolEntry = GraphSymbolSearchEntry;

/** Monotonic ownership for async palette actions. Hydration may be shared and therefore continue in
 * the store, but only the latest still-open pick may reveal/add a node or publish an error afterward. */
export interface PaletteActionGate {
  begin(): number;
  isCurrent(intent: number): boolean;
  invalidate(): void;
}

export function createPaletteActionGate(): PaletteActionGate {
  let latestIntent = 0;
  return {
    begin: () => ++latestIntent,
    isCurrent: (intent) => intent === latestIntent,
    invalidate: () => { latestIntent += 1; },
  };
}

/** Window-owned Escape closes the palette only when no focused child already consumed the key. */
export function shouldClosePaletteFromWindow(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented">,
  open: boolean,
): boolean {
  return open && event.key === "Escape" && !event.defaultPrevented;
}

/** Await one pick's hydration and return null when a newer pick/close took ownership meanwhile. */
export async function awaitLatestPaletteReadiness(
  gate: PaletteActionGate,
  ensureReady: () => Promise<boolean>,
): Promise<boolean | null> {
  const intent = gate.begin();
  const ready = await ensureReady();
  return gate.isCurrent(intent) ? ready : null;
}

export type PaletteActionOutcome = "stale" | "failed" | "loaded" | "acted";

export type PaletteKeyboardActivation = "load" | "open" | "add" | null;

/** Resolve Enter without bypassing the same readiness state rendered by the row controls. */
export function paletteKeyboardActivation(
  entry: Pick<SymbolEntry, "isLoaded">,
  options: {
    progressive: boolean;
    busy: boolean;
    failed: boolean;
    canAdd: boolean;
    addModifier: boolean;
  },
): PaletteKeyboardActivation {
  if (options.progressive && options.busy) return null;
  if (options.progressive && (!entry.isLoaded || options.failed)) return "load";
  if (options.canAdd && options.addModifier) return "add";
  return "open";
}

/** A repository row has two deliberate phases. The first successful intent may hydrate it, but it
 * cannot also reveal/add it: only a later intent against the visibly ready row may run the action. */
export async function runPaletteAction(
  gate: PaletteActionGate,
  rowWasReady: boolean,
  ensureReady: () => Promise<boolean>,
  action: () => void,
): Promise<PaletteActionOutcome> {
  const ready = await awaitLatestPaletteReadiness(gate, ensureReady);
  if (ready === null) return "stale";
  if (!ready) return "failed";
  if (!rowWasReady) return "loaded";
  action();
  return "acted";
}

export function CommandPalette() {
  const artifact = useBlueprint((state) => state.artifact);
  const index = useBlueprint((state) => state.index);
  const progressiveSymbols = useBlueprint((state) => state.progressiveSymbols);
  const progressivePendingNodeIds = useBlueprint((state) => state.progressivePendingNodeIds);
  const progressiveReadyFileIds = useBlueprint((state) => state.progressiveGraph?.head.readyFileIds ?? null);
  const reviewBaseNodeIds = useBlueprint((state) => state.reviewBaseNodeIds);
  const viewMode = useBlueprint((state) => state.viewMode);
  const paletteCanvasNodeIds = usePaletteCanvasNodeIds();
  const {
    openLogicFlow,
    revealInView,
    addToView,
    focusNodeInView,
    ensureNodeReady,
    queryProgressiveSymbols,
    startProgressiveSymbolIndex,
    synchronizeProgressiveSymbolSearch,
  } = useBlueprintActions();
  // In a map lens, the palette reveals/adds a graph node; elsewhere it opens a logic flow.
  const isMap = MAP_VIEWS.has(viewMode);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedId, setHighlightedId] = useState<NodeId | null>(null);
  const [scope, setScope] = useState<SearchScope>("public");
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failedNodeIds, setFailedNodeIds] = useState<Set<NodeId>>(() => new Set());
  const [workerCounts, setWorkerCounts] = useState<SearchScopeCounts | null>(null);
  const [workerResults, setWorkerResults] = useState<SymbolEntry[] | null>(null);
  const [workerSyncRevision, setWorkerSyncRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const workerSyncSequence = useRef(0);
  const workerQuerySequence = useRef(0);
  const actionGateRef = useRef<PaletteActionGate | null>(null);
  actionGateRef.current ??= createPaletteActionGate();
  const actionGate = actionGateRef.current;

  // The global shortcut. Cmd/Ctrl+P is the browser's Print dialog, so preventDefault is CRITICAL —
  // without it the print window steals the keystroke and the palette never opens. Pressing it again
  // toggles the palette shut. Escape is window-owned as a fallback because an async Add action can
  // disable its focused button and move focus outside the input; focused children consume Escape
  // first when they have narrower semantics (for example, closing only the scope menu).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        actionGate.invalidate();
        setOpen((wasOpen) => !wasOpen);
      } else if (shouldClosePaletteFromWindow(event, open)) {
        event.preventDefault();
        actionGate.invalidate();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actionGate, open]);

  // An embedding can unmount the canvas while hydration is in flight. Fence that completion just as
  // strictly as Escape/backdrop close so it cannot call a stale store action or set local error state.
  useEffect(() => () => actionGate.invalidate(), [actionGate]);

  // A fresh open starts empty with the top row primed, so the reader never inherits a stale query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlightedId(null);
      setScope("public");
      setScopeMenuOpen(false);
      setActionError(null);
      setFailedNodeIds(new Set());
      void startProgressiveSymbolIndex();
    }
  }, [open, startProgressiveSymbolIndex]);

  // Rank the currently loaded bounded slice on the UI thread. A repository-wide progressive index
  // remains in its persistent Worker; opening the palette never clones or sorts those 500k rows.
  const readyFileIds = useMemo(() => {
    if (!open) return null;
    if (progressiveReadyFileIds === null) return null;
    const ready = new Set(progressiveReadyFileIds);
    // Tombstones are complete, comparison-owned declarations already present in the review
    // composite. Mark their owning base modules locally ready; their IDs are invalid HEAD roots.
    for (const id of reviewBaseNodeIds) {
      const node = index.nodesById.get(id);
      if (node !== undefined) ready.add(owningModuleId(node, index.nodesById));
    }
    return ready;
  }, [index.nodesById, open, progressiveReadyFileIds, reviewBaseNodeIds]);
  const repositoryWorkerBacked = progressiveSymbols.workerBacked === true;
  const symbols = useMemo(() => derivePaletteSymbols(
    open,
    artifact,
    progressiveSymbols.symbols,
    index.nodesById,
    isMap,
    readyFileIds,
    repositoryWorkerBacked,
  ), [artifact, index.nodesById, isMap, open, progressiveSymbols.symbols, readyFileIds, repositoryWorkerBacked]);
  const localScopeCounts = useMemo(() => countSearchScopes(symbols), [symbols]);
  const localResults = useMemo(
    () => selectResults(symbols, query, isMap, scope),
    [symbols, query, isMap, scope],
  );
  const workerSearchPending = repositoryWorkerBacked && workerResults === null;
  const scopeCounts = repositoryWorkerBacked
    ? workerCounts ?? { public: 0, all: 0, private: 0 }
    : localScopeCounts;
  const results = paletteVisibleResults(repositoryWorkerBacked, workerResults, localResults);

  // Synchronize only the loaded projection when its graph/mode/readiness changes. Repository rows
  // never cross this boundary; the worker merges these authoritative overrides into its own index.
  useEffect(() => {
    const sequence = ++workerSyncSequence.current;
    workerQuerySequence.current += 1;
    setWorkerCounts(null);
    setWorkerResults(null);
    setWorkerSyncRevision(0);
    if (!open || !repositoryWorkerBacked) return;
    void synchronizeProgressiveSymbolSearch(symbols, isMap).then((counts) => {
      if (sequence !== workerSyncSequence.current || counts === null) return;
      setWorkerCounts(counts);
      setWorkerSyncRevision(sequence);
    });
  }, [isMap, open, repositoryWorkerBacked, symbols, synchronizeProgressiveSymbolSearch]);

  // Each keystroke sends only its tiny query tuple. Results are capped inside the worker; sequence
  // ownership prevents a slow no-match scan from replacing a newer query's rows.
  useEffect(() => {
    const sequence = ++workerQuerySequence.current;
    setWorkerResults(null);
    if (!open || !repositoryWorkerBacked || workerSyncRevision === 0) return;
    void queryProgressiveSymbols({ query, isMap, scope }).then((result: GraphSymbolSearchQueryResult | null) => {
      if (sequence !== workerQuerySequence.current || result === null) return;
      setWorkerCounts(result.counts);
      setWorkerResults(result.results);
    });
  }, [isMap, open, query, queryProgressiveSymbols, repositoryWorkerBacked, scope, workerSyncRevision]);
  // Identity, not row number, owns keyboard selection. Background index completion can insert and
  // reorder rows while the palette is open; retaining the ID prevents Enter opening a different node.
  const highlighted = Math.max(0, results.findIndex((entry) => entry.id === highlightedId));

  // Typing or changing the search scope shifts the result set, so re-prime the highlight.
  useEffect(() => {
    setHighlightedId(null);
  }, [query, scope]);
  // Keep the highlighted row in view as arrow keys walk past the fold. Block body is REQUIRED: a
  // concise arrow would return scrollIntoView's result, which React treats as a cleanup function and
  // invokes on the next run — in browsers where it returns a non-undefined value that crashes.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted, results]);

  if (!open) {
    return null;
  }

  const close = () => {
    actionGate.invalidate();
    setOpen(false);
  };
  const settlePick = async (entry: SymbolEntry, action: () => void): Promise<PaletteActionOutcome> => {
    setActionError(null);
    const outcome = await runPaletteAction(
      actionGate,
      entry.isLoaded,
      () => ensureNodeReady(entry.id, entry.fileId),
      action,
    );
    if (outcome === "stale") return outcome;
    if (outcome === "failed") {
      setFailedNodeIds((current) => new Set(current).add(entry.id));
      setActionError("That symbol's nearby graph could not be loaded. Try again.");
      return outcome;
    }
    setFailedNodeIds((current) => {
      if (!current.has(entry.id)) return current;
      const next = new Set(current);
      next.delete(entry.id);
      return next;
    });
    return outcome;
  };
  // A nonresident pick only hydrates its depth-1 context. The re-rendered ready row owns the later
  // reveal/add intent, making the readiness mark an actual interaction boundary rather than copy.
  const loadPick = async (entry: SymbolEntry) => {
    await settlePick(entry, () => undefined);
  };
  // Enter/click a ready row: a map lens reveals it (go-to / pin+select), logic opens its flow. Close.
  const openPick = async (entry: SymbolEntry) => {
    const outcome = await settlePick(entry, () => {
      if (isMap) revealInView(entry.id);
      else openLogicFlow(entry.id);
    });
    if (outcome === "acted") close();
  };
  // The "+" (map lenses only): add the node to the visible graph WITHOUT navigating. Stay open so a
  // reader can add several nodes before dismissing to see the result on the canvas.
  const addPick = async (entry: SymbolEntry) => {
    await settlePick(entry, () => addToView(entry.id));
  };
  // The magnifier is deliberately separate from reveal: it preserves the current graph and asks
  // its active React Flow surface to select + fit an exact node which that surface already published.
  const focusPick = (entry: SymbolEntry) => {
    if (!paletteCanvasNodeIds.has(entry.id)) return;
    if (focusNodeInView(entry.id)) close();
  };

  // Arrow keys move the highlight (clamped to the list). Enter loads a nonresident row or opens a
  // ready one; Cmd/Ctrl+Enter adds only a ready map row. Escape closes. Option/Alt+P opens scope.
  // preventDefault on the arrows stops the caret jumping to the input's ends.
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey && event.code === "KeyP") {
      event.preventDefault();
      setScopeMenuOpen(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.min(highlighted + 1, results.length - 1);
      setHighlightedId(results[next]?.id ?? null);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.max(highlighted - 1, 0);
      setHighlightedId(results[next]?.id ?? null);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const pick = results[highlighted];
      if (!pick) {
        return;
      }
      const activation = paletteKeyboardActivation(pick, {
        progressive: progressiveReadyFileIds !== null,
        busy: progressivePendingNodeIds.has(pick.id),
        failed: failedNodeIds.has(pick.id),
        canAdd: isMap,
        addModifier: event.metaKey || event.ctrlKey,
      });
      if (activation === "load") {
        void loadPick(pick);
      } else if (activation === "add") {
        void addPick(pick);
      } else if (activation === "open") {
        void openPick(pick);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  // Backdrop click closes; clicks inside the dialog are swallowed so they don't reach it.
  return (
    <div style={BACKDROP_STYLE} onClick={close}>
      <div style={DIALOG_STYLE} role="dialog" aria-modal aria-label={isMap ? "Reveal or add a node in the current view" : "Open a symbol's logic flow"} onClick={(e) => e.stopPropagation()}>
        <div style={SEARCH_HEADER_STYLE}>
          <input
            ref={inputRef}
            style={INPUT_STYLE}
            autoFocus
            placeholder={isMap
              ? progressiveReadyFileIds === null
                ? "Reveal a node — Enter to go there, + to add it here…"
                : "Search a node — load its context, then reveal or add it…"
              : "Search a symbol to open its logic flow…"}
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
        <div style={LIST_STYLE}>
          {results.length > 0 ? (
            results.map((entry, row) => (
              <ResultRow
                key={entry.id}
                entry={entry}
                active={row === highlighted}
                canAdd={isMap}
                canFocus={isMap && paletteCanvasNodeIds.has(entry.id)}
                progressive={progressiveReadyFileIds !== null}
                resident={index.nodesById.has(entry.id)}
                failed={failedNodeIds.has(entry.id)}
                activeRef={row === highlighted ? activeRowRef : undefined}
                onHover={() => setHighlightedId(entry.id)}
                busy={progressivePendingNodeIds.has(entry.id)}
                onOpen={() => { void openPick(entry); }}
                onLoad={() => { void loadPick(entry); }}
                onFocusNode={() => focusPick(entry)}
                onAdd={() => { void addPick(entry); }}
              />
            ))
          ) : (
            <div style={EMPTY_STYLE}>
              {progressiveSymbols.status === "indexing"
                ? "Indexing repository symbols…"
                : workerSearchPending
                  ? "Searching repository symbols…"
                : progressiveSymbols.status === "error"
                  ? "Repository symbol index unavailable; showing the loaded graph only."
                : `No node matches “${query.trim()}”.`}
            </div>
          )}
        </div>
        {actionError !== null ? <div role="alert" style={ERROR_STYLE}>{actionError}</div> : null}
        <div style={FOOTER_STYLE}>
          <span>{isMap
            ? progressiveReadyFileIds === null
              ? "↑↓ navigate · ↵ reveal · ⌘↵ add · esc close"
              : "↑↓ navigate · ↵ load/reveal · ⌘↵ add when ready · esc close"
            : progressiveReadyFileIds === null
              ? "↑↓ navigate · ↵ open · esc close"
              : "↑↓ navigate · ↵ load/open · esc close"}</span>
          {progressiveSymbols.status === "indexing" ? (
            <span role="status">Indexing {progressiveSymbols.indexed}/{progressiveSymbols.total || "…"}</span>
          ) : progressiveSymbols.status === "ready" ? (
            <span>{progressiveSymbols.total.toLocaleString()} symbols</span>
          ) : progressiveSymbols.status === "error" ? (
            <span role="alert" title={progressiveSymbols.error ?? undefined}>Repository index unavailable</span>
          ) : null}
        </div>
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

/** One result: name over a faint (mono) qualified name/path, a step-count chip when it has a flow,
 * a kind tag, a conditional focus action for an exact node already drawn by the active canvas, and
 * — in a map lens — a "+" that adds the node to the current view without navigating. */
export type SymbolRowReadiness = "canonical" | "loadable" | "hydrating" | "ready" | "retry";

export function symbolRowReadiness(
  entry: Pick<SymbolEntry, "isLoaded">,
  progressive: boolean,
  busy: boolean,
  failed: boolean,
): SymbolRowReadiness {
  if (!progressive) return "canonical";
  if (busy) return "hydrating";
  if (failed) return "retry";
  return entry.isLoaded ? "ready" : "loadable";
}

export function ResultRow(props: {
  entry: SymbolEntry;
  active: boolean;
  canAdd: boolean;
  canFocus: boolean;
  progressive: boolean;
  resident: boolean;
  failed: boolean;
  busy: boolean;
  activeRef?: React.Ref<HTMLDivElement>;
  onHover: () => void;
  onOpen: () => void;
  onLoad: () => void;
  onFocusNode: () => void;
  onAdd: () => void;
}) {
  const { entry } = props;
  const readiness = symbolRowReadiness(entry, props.progressive, props.busy, props.failed);
  const actionable = readiness === "canonical" || readiness === "ready";
  const mainLabel = readiness === "retry"
    ? `Retry loading nearby graph for ${entry.displayName}`
    : readiness === "loadable"
      ? `Load nearby graph for ${entry.displayName}`
      : `Open ${entry.displayName}`;
  return (
    <div
      ref={props.activeRef}
      style={props.active ? ROW_ACTIVE_STYLE : ROW_STYLE}
      data-symbol-id={entry.id}
      data-symbol-readiness={readiness}
      data-symbol-resident={props.resident ? "true" : "false"}
      onMouseEnter={props.onHover}
    >
      <button
        type="button"
        style={ROW_MAIN_BUTTON_STYLE}
        title={entry.id}
        aria-label={mainLabel}
        disabled={readiness === "hydrating"}
        onClick={actionable ? props.onOpen : props.onLoad}
      >
        <span style={ROW_MAIN_STYLE}>
          <span style={ROW_NAME_STYLE}>{entry.displayName}</span>
          <span style={ROW_SECONDARY_STYLE}>{entry.qualifiedName || entry.file}</span>
        </span>
      </button>
      {entry.stepCount !== null ? <span style={STEP_CHIP_STYLE}>{entry.stepCount} steps</span> : null}
      {readiness === "ready" ? <span style={READY_CHIP_STYLE}><CheckIcon aria-hidden width={10} height={10} /> ready</span> : null}
      {readiness === "loadable" ? <span style={NEARBY_CHIP_STYLE}>Load nearby graph</span> : null}
      {readiness === "retry" ? <span style={RETRY_CHIP_STYLE}>Retry load</span> : null}
      {readiness === "hydrating" ? <span style={LOADING_CHIP_STYLE}>loading nearby graph…</span> : null}
      <span style={kindTagStyle(entry.kind)}>{entry.kind}</span>
      {props.canFocus ? (
        <button
          type="button"
          style={FOCUS_BUTTON_STYLE}
          title="Focus this node in the current graph"
          aria-label={`Focus ${entry.displayName} in the current graph`}
          onClick={(event) => {
            event.stopPropagation();
            props.onFocusNode();
          }}
        >
          <MagnifyingGlassIcon width={14} height={14} aria-hidden="true" />
        </button>
      ) : null}
      {props.canAdd ? (
        <button
          type="button"
          style={actionable ? ADD_BUTTON_STYLE : ADD_BUTTON_DISABLED_STYLE}
          title={actionable ? "Add this node to the current view" : "Load nearby graph before adding this node"}
          aria-label={`Add ${entry.displayName} to the current view`}
          disabled={!actionable}
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

/**
 * The searchable rows for the current mode. Map lenses: every navigable node (function/method/module/
 * package/class/interface/typeAlias/object), sorted by name — a pick resolves to its drawable card on
 * reveal/add. Logic/UI: every function/method/module, flow-bearing first (then alphabetically) so
 * flow-openable symbols rank above those without. Both preserve their order through the substring
 * filter. Dunder methods are classified here, then filtered at query time so the user can opt back
 * into them without rescanning the graph. `logicFlow` is a loose extension record.
 */
export function collectSymbols(artifact: GraphArtifact, nodesById: ReadonlyMap<string, GraphNode>, isMap: boolean): SymbolEntry[] {
  const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as Record<string, unknown[]>;
  const kinds = isMap ? MAP_KINDS : LOGIC_KINDS;
  const entries: SymbolEntry[] = [];
  for (const node of nodesById.values()) {
    if (!kinds.has(node.kind)) {
      continue;
    }
    const steps = flows[node.id];
    entries.push({
      id: node.id,
      fileId: owningModuleId(node, nodesById),
      displayName: node.displayName,
      qualifiedName: node.qualifiedName,
      file: node.location?.file ?? "",
      kind: node.kind,
      isPrivateMethod: node.kind === "method" && node.displayName.startsWith("__"),
      // Exit steps are charted control flow, not WORK — the size hint counts only executable steps.
      stepCount: Array.isArray(steps) ? steps.filter((step) => (step as { kind?: string }).kind !== "exit").length : null,
      isLoaded: true,
    });
  }
  return mergeGraphSymbolSearchEntries([], entries, isMap);
}

/** Combine the compact repository-wide index with already-loaded symbols. Loaded rows win so
 * artifact-local flow details remain authoritative; both paths preserve the old ranking rules. */
export function mergeSearchSymbols(
  loaded: readonly SymbolEntry[],
  indexed: readonly CompactGraphSymbolEntry[],
  _nodesById: ReadonlyMap<string, GraphNode>,
  isMap: boolean,
  readyFileIds: ReadonlySet<string> | null = null,
): SymbolEntry[] {
  const authoritative = loaded.map((entry) => ({
      ...entry,
      isLoaded: entry.isLoaded && (
        entry.kind === "package" || (readyFileIds?.has(entry.fileId) ?? true)
      ),
    }));
  return mergeGraphSymbolSearchEntries(indexed, authoritative, isMap);
}

/** Keep repository-wide indexing independent from repository-wide main-thread ranking. The compact
 * index may finish with hundreds of thousands of rows while this globally mounted component is
 * closed; do not clone, merge, or sort any of them until the reader actually opens Cmd/Ctrl+P. */
export function derivePaletteSymbols(
  open: boolean,
  artifact: GraphArtifact,
  indexed: readonly CompactGraphSymbolEntry[],
  nodesById: ReadonlyMap<string, GraphNode>,
  isMap: boolean,
  readyFileIds: ReadonlySet<string> | null = null,
  repositoryWorkerBacked = false,
): SymbolEntry[] {
  if (!open) return [];
  return mergeSearchSymbols(
    collectSymbols(artifact, nodesById, isMap),
    repositoryWorkerBacked ? [] : indexed,
    nodesById,
    isMap,
    readyFileIds,
  );
}

function owningModuleId(node: GraphNode, nodesById: ReadonlyMap<string, GraphNode>): NodeId {
  let current: GraphNode | undefined = node;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    // Python package initializers are canonical file roots in the graph (there is deliberately no
    // duplicate module node for `__init__.py`). Namespace/synthetic packages keep walking because
    // they do not identify one source file that a partial projection can hydrate.
    if (
      current.kind === "module"
      || (current.kind === "package" && current.location.file.endsWith(".py"))
    ) return current.id;
    seen.add(current.id);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  // Full-artifact search never needs to hydrate this fallback. Keeping a canonical ID makes the
  // shared row shape total for lenient artifacts with missing containment.
  return node.id;
}

/**
 * The rows to show: dunder methods are filtered by the selected public/all/private scope before the
 * row cap. With no query, a map lens shows the top nodes and logic shows the top flow-bearing symbols;
 * with a query, nodes whose display OR qualified name contains the (lowercased) needle. Capped.
 */
export function selectResults(
  symbols: SymbolEntry[],
  query: string,
  isMap: boolean,
  scope: SearchScope = "public",
): SymbolEntry[] {
  return queryRankedGraphSymbols(symbols, { query, isMap, scope }).results;
}

export function countSearchScopes(symbols: readonly SymbolEntry[]): SearchScopeCounts {
  return countGraphSymbolSearchScopes(symbols);
}

/** Until the authoritative worker result lands, local rows are deliberately non-actionable: their
 * rank may move outside the global top 40, so a fast Enter must not open the wrong symbol. */
export function paletteVisibleResults(
  repositoryWorkerBacked: boolean,
  workerResults: readonly SymbolEntry[] | null,
  localResults: readonly SymbolEntry[],
): SymbolEntry[] {
  return repositoryWorkerBacked ? [...(workerResults ?? [])] : [...localResults];
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
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  borderTop: "1px solid #2A2F37",
  padding: "6px 12px",
  fontSize: 10,
  color: "#6C7683",
  background: "#10151C",
};
const ERROR_STYLE: React.CSSProperties = {
  borderTop: "1px solid #4A2B2B",
  padding: "6px 12px",
  fontSize: 11,
  color: "#F0A5A5",
  background: "#211416",
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
const LOADING_CHIP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  color: "#D9B866",
  border: "1px solid #4A4027",
  borderRadius: 4,
  padding: "1px 6px",
};
const NEARBY_CHIP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9,
  color: "#8FA9C4",
  border: "1px solid #304157",
  borderRadius: 4,
  padding: "1px 6px",
};
const READY_CHIP_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 9,
  fontWeight: 600,
  color: "#56C271",
  border: "1px solid #2C4133",
  borderRadius: 4,
  padding: "1px 6px",
};
const RETRY_CHIP_STYLE: React.CSSProperties = {
  ...NEARBY_CHIP_STYLE,
  color: "#E28B78",
  borderColor: "#5A332D",
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
// Focus is navigation within the current scene, so it uses the palette's cool blue navigation
// accent rather than the green mutation accent reserved for adding a card.
const FOCUS_BUTTON_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 22,
  height: 22,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 5,
  border: "1px solid #304157",
  background: "#15202B",
  color: "#9CBBD8",
  cursor: "pointer",
  padding: 0,
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
const ADD_BUTTON_DISABLED_STYLE: React.CSSProperties = {
  ...ADD_BUTTON_STYLE,
  cursor: "not-allowed",
  opacity: 0.35,
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
