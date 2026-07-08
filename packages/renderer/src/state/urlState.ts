/**
 * The URL <-> navigation-state contract. The renderer reflects the "current code path" — which
 * view, which dived-into container, which flow/logic trail, which selection — in the query string
 * so a reload, browser back/forward, or a shared link reproduces exactly what's on screen.
 *
 * Only NAVIGATION state lives here; derived layout (rfNodes, ELK output), telemetry, and ephemeral
 * UI (command palette, viewport) never touch the URL. Node ids carry ':' '#' '/' '~'; we never
 * hand-encode them — they ride through URLSearchParams, which percent-encodes on toString and
 * decodes on parse, so a round-trip is lossless. `mergeNavIntoSearch` owns only our own keys and
 * leaves foreign params (e.g. web-mode `?id=`) untouched.
 */

import type { ViewMode } from "../derive/edgeSelection";
import type { FlowSelectionRef, FlowBlockSegment } from "../derive/flowBlocks";
import { isLogicViewMode, type LogicViewMode } from "../derive/flowViewModel";
import type { HighlightMode } from "../components/moduleMapPaint";
import type { PrsTab } from "./prTypes";

/** The URL-worthy slice of the store — mirrors the navigation fields of BlueprintState. */
export interface NavState {
  viewMode: ViewMode;
  focusId: string | null;
  compRoot: string | null;
  selectedId: string | null;
  compSelectedId: string | null;
  logicSelected: string | null;
  flowRootId: string | null;
  flowDepth: number | null;
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  logicRoot: string | null;
  /** The Logic-flow projection on screen (exec graph by default) — see store.logicView. */
  logicView: LogicViewMode;
  logicStack: string[];
  expanded: string[];
  /** The Module-map focus: the package/dir node zoomed into; null == the whole-repo overview. */
  moduleFocus: string | null;
  /** Group cards expanded in place in the Module map — a comma-joined list of node ids in the URL. */
  moduleExpanded: string[];
  /** The Module-map selection highlight radius (GHOST_DEPTH_ALL == the whole neighbourhood). */
  moduleRadius: number;
  /** The Module-map selection emphasis mode; "node" is omitted because it is the default. */
  highlightMode: HighlightMode;
  /** Module categories painted out of the map — a comma-joined list in the URL. */
  hiddenCategories: string[];
  /** The active PR list tab and selected PR number, when the PR browser is open. */
  prsTab: PrsTab;
  prSelected: number | null;
  environment: string | null;
}

/** Every param key we own — listed once so `mergeNavIntoSearch` can clear them before rewriting. */
const KEYS = ["view", "focus", "root", "sel", "csel", "lsel", "flow", "depth", "fexp", "fsel", "lroot", "lview", "lstack", "expand", "mfocus", "mexp", "mdepth", "hmode", "mhide", "prstate", "prn", "env"] as const;

/** The navigation state the app boots into — the baseline a restore resets absent keys back to. */
export const DEFAULT_NAV: NavState = {
  viewMode: "modules",
  focusId: null,
  compRoot: null,
  selectedId: null,
  compSelectedId: null,
  logicSelected: null,
  flowRootId: null,
  flowDepth: null,
  flowExplorerOpen: false,
  flowSelection: null,
  logicRoot: null,
  logicView: "graph",
  logicStack: [],
  expanded: [],
  moduleFocus: null,
  moduleExpanded: [],
  moduleRadius: 1,
  /** Node-only incident-wire highlighting is the default; radius reach is opt-in. */
  highlightMode: "node",
  hiddenCategories: [],
  prsTab: "open",
  prSelected: null,
  environment: null,
};

/** The BlueprintState shape we read from — a structural subset so tests need no full store. */
interface NavSource {
  viewMode: ViewMode;
  focusId: string | null;
  compRoot: string | null;
  selectedId: string | null;
  compSelectedId: string | null;
  logicSelected: string | null;
  flowRootId: string | null;
  flowDepth: number | null;
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  logicRoot: string | null;
  logicView: LogicViewMode;
  logicStack: readonly string[];
  expanded: ReadonlySet<string>;
  moduleFocus: string | null;
  moduleExpanded: ReadonlySet<string>;
  moduleRadius: number;
  /** Module-map selection emphasis mode, mirrored into `hmode` only when non-default. */
  highlightMode: HighlightMode;
  hiddenCategories: ReadonlySet<string>;
  prsTab: PrsTab;
  prSelected: number | null;
  environment: string | null;
}

/** Snapshot the navigation fields off the store. Lists are copied + sorted so the URL is stable. */
export function navFrom(state: NavSource): NavState {
  return {
    viewMode: state.viewMode,
    focusId: state.focusId,
    compRoot: state.compRoot,
    selectedId: state.selectedId,
    compSelectedId: state.compSelectedId,
    logicSelected: state.logicSelected,
    flowRootId: state.flowRootId,
    flowDepth: state.flowDepth,
    flowExplorerOpen: state.flowExplorerOpen,
    flowSelection: cloneFlowSelection(state.flowSelection),
    logicRoot: state.logicRoot,
    logicView: state.logicView,
    logicStack: [...state.logicStack],
    expanded: [...state.expanded].sort(),
    moduleFocus: state.moduleFocus,
    moduleExpanded: [...state.moduleExpanded].sort(),
    moduleRadius: state.moduleRadius,
    highlightMode: state.highlightMode,
    hiddenCategories: [...state.hiddenCategories].sort(),
    prsTab: state.prsTab,
    prSelected: state.prSelected,
    environment: state.environment,
  };
}

/** Encode to key->value pairs, omitting every field left at its default (keeps URLs minimal). */
export function encodeNav(nav: NavState): Map<string, string> {
  const out = new Map<string, string>();
  if (nav.viewMode !== "modules") out.set("view", nav.viewMode);
  setId(out, "focus", nav.focusId);
  setId(out, "root", nav.compRoot);
  setId(out, "sel", nav.selectedId);
  setId(out, "csel", nav.compSelectedId);
  setId(out, "lsel", nav.logicSelected);
  setId(out, "flow", nav.flowRootId);
  if (nav.flowDepth !== null) out.set("depth", String(nav.flowDepth));
  if (nav.flowExplorerOpen) out.set("fexp", "1");
  if (nav.flowSelection !== null) out.set("fsel", encodeFlowSelection(nav.flowSelection));
  setId(out, "lroot", nav.logicRoot);
  if (nav.logicView !== "graph") out.set("lview", nav.logicView);
  setList(out, "lstack", nav.logicStack);
  setList(out, "expand", nav.expanded);
  setId(out, "mfocus", nav.moduleFocus);
  setList(out, "mexp", nav.moduleExpanded);
  if (nav.moduleRadius !== 1) out.set("mdepth", String(nav.moduleRadius));
  /** `hmode=node` is the baseline; only persist reach mode so default URLs stay short. */
  if (nav.highlightMode !== "node") out.set("hmode", nav.highlightMode);
  setList(out, "mhide", nav.hiddenCategories);
  if (nav.prsTab !== "open") out.set("prstate", nav.prsTab);
  if (nav.prSelected !== null) out.set("prn", String(nav.prSelected));
  setId(out, "env", nav.environment);
  return out;
}

/** Decode present keys back into a partial NavState — absent keys stay unset (store keeps default). */
export function decodeNav(params: URLSearchParams): Partial<NavState> {
  const out: Partial<NavState> = {};
  const view = params.get("view");
  if (view === "call" || view === "ui" || view === "logic" || view === "modules" || view === "prs") {
    out.viewMode = view;
  }
  assignId(params, "focus", out, "focusId");
  assignId(params, "root", out, "compRoot");
  assignId(params, "sel", out, "selectedId");
  assignId(params, "csel", out, "compSelectedId");
  assignId(params, "lsel", out, "logicSelected");
  assignId(params, "flow", out, "flowRootId");
  const depth = params.get("depth");
  if (depth !== null && !Number.isNaN(Number(depth))) out.flowDepth = Number(depth);
  if (params.get("fexp") === "1") out.flowExplorerOpen = true;
  const flowSelection = decodeFlowSelection(params.get("fsel"));
  if (flowSelection) out.flowSelection = flowSelection;
  assignId(params, "lroot", out, "logicRoot");
  const logicView = params.get("lview");
  if (logicView !== null && isLogicViewMode(logicView)) out.logicView = logicView;
  assignList(params, "lstack", out, "logicStack");
  assignList(params, "expand", out, "expanded");
  assignId(params, "mfocus", out, "moduleFocus");
  assignList(params, "mexp", out, "moduleExpanded");
  const moduleRadius = params.get("mdepth");
  if (moduleRadius !== null && !Number.isNaN(Number(moduleRadius))) out.moduleRadius = Number(moduleRadius);
  /** Accept only the two known highlight modes; junk leaves the store default intact. */
  const highlightMode = params.get("hmode");
  if (highlightMode === "reach" || highlightMode === "node") out.highlightMode = highlightMode;
  assignList(params, "mhide", out, "hiddenCategories");
  const prsTab = params.get("prstate");
  if (prsTab === "open" || prsTab === "closed") out.prsTab = prsTab;
  const prSelected = params.get("prn");
  if (prSelected !== null && Number.isInteger(Number(prSelected)) && Number(prSelected) > 0) {
    out.prSelected = Number(prSelected);
  }
  assignId(params, "env", out, "environment");
  return out;
}

/** Decode a COMPLETE nav state: present keys override defaults, absent keys reset to default. This
 * is what a restore needs so browser back/forward fully undoes a dive/selection, not just the keys
 * the target URL happens to carry. */
export function decodeNavState(params: URLSearchParams): NavState {
  return { ...DEFAULT_NAV, ...decodeNav(params) };
}

/** Rewrite a query string with our keys set from `nav`, preserving any foreign params (e.g. `id`). */
export function mergeNavIntoSearch(search: string, nav: NavState): string {
  const params = new URLSearchParams(search);
  KEYS.forEach((key) => params.delete(key));
  for (const [key, value] of encodeNav(nav)) {
    params.set(key, value);
  }
  return params.toString();
}

/** A change worth a new history entry (a place you can go "back" from) vs. a mere repaint. */
export function isNavigationChange(prev: NavState, next: NavState): boolean {
  return (
    prev.viewMode !== next.viewMode ||
    prev.focusId !== next.focusId ||
    prev.compRoot !== next.compRoot ||
    prev.moduleFocus !== next.moduleFocus ||
    prev.flowRootId !== next.flowRootId ||
    prev.logicRoot !== next.logicRoot ||
    // logicView is deliberately absent: a sub-view flip is a presentation change (replaceState,
    // like a selection), so Back never replays tab switches — or their full-graph relayouts.
    prev.logicStack.join(",") !== next.logicStack.join(",")
  );
}

function encodeFlowSelection(ref: FlowSelectionRef): string {
  return `${encodeURIComponent(ref.rootId)}@${ref.blockPath.map(encodeSegment).join(".")}`;
}

function decodeFlowSelection(value: string | null): FlowSelectionRef | null {
  if (value === null) {
    return null;
  }
  const at = value.indexOf("@");
  if (at <= 0) {
    return null;
  }
  const rootId = decodeRootId(value.slice(0, at));
  const blockPath = decodeBlockPath(value.slice(at + 1));
  return rootId && blockPath ? { rootId, blockPath } : null;
}

function cloneFlowSelection(ref: FlowSelectionRef | null): FlowSelectionRef | null {
  return ref ? { rootId: ref.rootId, blockPath: ref.blockPath.map((segment) => ({ ...segment })) } : null;
}

function encodeSegment(segment: FlowBlockSegment): string {
  return segment.path === undefined ? String(segment.step) : `${segment.step}-${segment.path}`;
}

function decodeRootId(value: string): string | null {
  try {
    const rootId = decodeURIComponent(value);
    return rootId.length > 0 ? rootId : null;
  } catch {
    return null;
  }
}

function decodeBlockPath(value: string): FlowBlockSegment[] | null {
  if (value === "") {
    return [];
  }
  const path: FlowBlockSegment[] = [];
  for (const segmentValue of value.split(".")) {
    const segment = decodeSegment(segmentValue);
    if (segment === null) {
      return null;
    }
    path.push(segment);
  }
  return path;
}

function decodeSegment(value: string): FlowBlockSegment | null {
  const parts = value.split("-");
  if (parts.length > 2) {
    return null;
  }
  const step = decodeIndex(parts[0]);
  if (step === null) {
    return null;
  }
  if (parts[1] === undefined) {
    return { step };
  }
  const path = decodeIndex(parts[1]);
  return path === null ? null : { step, path };
}

function decodeIndex(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function setId(out: Map<string, string>, key: string, value: string | null): void {
  if (value !== null) out.set(key, value);
}

function setList(out: Map<string, string>, key: string, values: string[]): void {
  if (values.length > 0) out.set(key, values.join(","));
}

function assignId<K extends keyof NavState>(params: URLSearchParams, key: string, out: Partial<NavState>, field: K): void {
  const value = params.get(key);
  if (value !== null) out[field] = value as NavState[K];
}

function assignList<K extends keyof NavState>(params: URLSearchParams, key: string, out: Partial<NavState>, field: K): void {
  const value = params.get(key);
  if (value !== null) out[field] = value.split(",").filter(Boolean) as NavState[K];
}
