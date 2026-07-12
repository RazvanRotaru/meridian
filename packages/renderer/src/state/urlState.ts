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
 *
 * The URL is a snapshot of the CURRENT lens, not the union of every lens visited: `encodeNav` scopes
 * output to the active `viewMode` (see `scopeToView`), so switching lenses never strands another
 * lens's dive/selection in the query string. Back/forward therefore steps between clean per-lens
 * URLs instead of a single ever-growing blob.
 */

import type { ViewMode } from "../derive/edgeSelection";
import type { FlowSelectionRef, FlowBlockSegment } from "../derive/flowBlocks";
import { isLogicViewMode, type LogicViewMode } from "../derive/flowViewModel";
import type { HighlightMode } from "../components/moduleMapPaint";
import type { PrsTab } from "./prTypes";
import {
  DEFAULT_SERVICE_GROUPING_LABEL_MODE,
  SERVICE_GROUPING_OPTIONS,
  type ServiceGroupingLabelMode,
  type ServiceGroupingMode,
} from "../derive/serviceClusteringModes";
import {
  DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  isServiceGroupingTargetSize,
  type ServiceGroupingTargetSize,
} from "./serviceGroupingTargetSize";

/** The URL-worthy slice of the store — mirrors the navigation fields of BlueprintState. */
export interface NavState {
  viewMode: ViewMode;
  compRoot: string | null;
  compSelectedId: string | null;
  logicSelected: string | null;
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  logicRoot: string | null;
  /** The Logic-flow projection on screen (exec graph by default) — see store.logicView. */
  logicView: LogicViewMode;
  logicStack: string[];
  /** The Module-map focus: the package/dir node zoomed into; null == the whole-repo overview. */
  moduleFocus: string | null;
  /** Artificial-parent strategy for the dense Service overview. */
  serviceGroupingMode: ServiceGroupingMode;
  /** Preferred member count for balanced Service partitions. */
  serviceGroupingTargetSize: ServiceGroupingTargetSize;
  /** One or two ranked semantic concepts in inferred Service parent labels. */
  serviceGroupingLabelMode: ServiceGroupingLabelMode;
  /** The OPEN minimal-graph overlay's seed file ids; empty == closed. Opening it is a navigation
   * (a place you can go Back from), so it lives here and in `isNavigationChange`. The overlay's grown
   * state (committed ghosts + expansions) is ephemeral exploration, deliberately not in the URL. */
  minimalSeedIds: string[];
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
  /** The reviewed PR carried by a modules-lens URL; distinct from the PR-browser selection. */
  reviewPr: number | null;
  reviewActive: boolean;
  telemetrySourceId: string | null;
  environment: string | null;
}

/** Every param key we own — listed once so `mergeNavIntoSearch` can clear them before rewriting. */
const KEYS = ["view", "focus", "root", "sel", "csel", "lsel", "flow", "depth", "fexp", "fsel", "lroot", "lview", "lstack", "expand", "mfocus", "mgraph", "mexp", "mdepth", "hmode", "mhide", "sgroup", "sgsize", "sglabels", "prstate", "prn", "rev", "tsrc", "env"] as const; // focus/sel/expand/flow/depth are LEGACY (pre-unification ui + flow isolation): still cleared on rewrite so stale links tidy up, never written.

/** Keys that ride along in EVERY lens: the lens itself, the telemetry env, and the cross-cutting
 * flow explorer (its panel is mounted regardless of the active lens, and reveals across the module
 * surfaces). These never get scoped out. */
const SHARED_KEYS = new Set<string>(["view", "tsrc", "env", "fexp", "fsel"]);

/** The keys each lens OWNS. `encodeNav` emits a lens's own keys plus the shared ones and drops the
 * rest, so a Map URL never carries a stale Logic trail (and vice-versa). Typed over ViewMode so a
 * new lens must declare its keys here. */
const LENS_KEYS: Record<ViewMode, readonly string[]> = {
  // The UI lens shares the module keys since the phase-C unification: its dive is the shared
  // `moduleFocus`, its in-place expansion the shared `moduleExpanded` — and the minimal-graph
  // overlay + selection dials (mgraph/mdepth/hmode/mhide) ride the same shared slots, so their
  // keys must survive here or Back/reload/share silently drops an overlay this lens built.
  ui: ["mfocus", "mexp", "mgraph", "mdepth", "hmode", "mhide"],
  // The Service lens shares the module navigation state: `mfocus` holds a service/domain dive and
  // `mexp` holds inline service/domain containers, so both survive reload/back/share like Map.
  call: ["root", "csel", "mfocus", "mexp", "mgraph", "mdepth", "hmode", "mhide", "sgroup", "sgsize", "sglabels"],
  // An in-graph PR review is a Map-only surface: prn+rev live on the modules lens alone.
  modules: ["mfocus", "mgraph", "mexp", "mdepth", "hmode", "mhide", "prn", "rev"],
  logic: ["lroot", "lview", "lstack", "lsel"],
  prs: ["prstate", "prn"],
};

/** The navigation state the app boots into — the baseline a restore resets absent keys back to. */
export const DEFAULT_NAV: NavState = {
  viewMode: "modules",
  compRoot: null,
  compSelectedId: null,
  logicSelected: null,
  flowExplorerOpen: false,
  flowSelection: null,
  logicRoot: null,
  logicView: "graph",
  logicStack: [],
  moduleFocus: null,
  serviceGroupingMode: "folder",
  serviceGroupingTargetSize: DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  serviceGroupingLabelMode: DEFAULT_SERVICE_GROUPING_LABEL_MODE,
  minimalSeedIds: [],
  moduleExpanded: [],
  moduleRadius: 1,
  /** Node-only incident-wire highlighting is the default; radius reach is opt-in. */
  highlightMode: "node",
  hiddenCategories: [],
  prsTab: "open",
  prSelected: null,
  reviewPr: null,
  reviewActive: false,
  telemetrySourceId: null,
  environment: null,
};

/** The BlueprintState shape we read from — a structural subset so tests need no full store. */
interface NavSource {
  viewMode: ViewMode;
  compRoot: string | null;
  compSelectedId: string | null;
  logicSelected: string | null;
  flowExplorerOpen: boolean;
  flowSelection: FlowSelectionRef | null;
  flowPaneOrigin?: "explorer" | "request" | null;
  logicRoot: string | null;
  logicView: LogicViewMode;
  logicStack: readonly string[];
  moduleFocus: string | null;
  serviceGroupingMode: ServiceGroupingMode;
  serviceGroupingTargetSize: ServiceGroupingTargetSize;
  serviceGroupingLabelMode: ServiceGroupingLabelMode;
  minimalSeedIds: readonly string[];
  moduleExpanded: ReadonlySet<string>;
  moduleRadius: number;
  /** Module-map selection emphasis mode, mirrored into `hmode` only when non-default. */
  highlightMode: HighlightMode;
  hiddenCategories: ReadonlySet<string>;
  prsTab: PrsTab;
  prSelected: number | null;
  prReviewed: number | null;
  telemetrySourceId: string | null;
  environment: string | null;
}

/** Snapshot the navigation fields off the store. Lists are copied + sorted so the URL is stable. */
export function navFrom(state: NavSource): NavState {
  return {
    viewMode: state.viewMode,
    compRoot: state.compRoot,
    compSelectedId: state.compSelectedId,
    logicSelected: state.logicSelected,
    flowExplorerOpen: state.flowExplorerOpen,
    flowSelection: state.flowPaneOrigin === "request" ? null : cloneFlowSelection(state.flowSelection),
    logicRoot: state.logicRoot,
    logicView: state.logicView,
    logicStack: [...state.logicStack],
    moduleFocus: state.moduleFocus,
    serviceGroupingMode: state.serviceGroupingMode,
    serviceGroupingTargetSize: state.serviceGroupingTargetSize,
    serviceGroupingLabelMode: state.serviceGroupingLabelMode,
    // Sorted for a stable URL; seed order never affects the built graph.
    minimalSeedIds: [...state.minimalSeedIds].sort(),
    moduleExpanded: [...state.moduleExpanded].sort(),
    moduleRadius: state.moduleRadius,
    highlightMode: state.highlightMode,
    hiddenCategories: [...state.hiddenCategories].sort(),
    prsTab: state.prsTab,
    prSelected: state.prSelected,
    reviewPr: state.prReviewed,
    reviewActive: state.prReviewed !== null,
    telemetrySourceId: state.telemetrySourceId,
    environment: state.environment,
  };
}

/** Encode to key->value pairs, omitting every field left at its default (keeps URLs minimal). */
export function encodeNav(nav: NavState): Map<string, string> {
  const out = new Map<string, string>();
  const activeReview = nav.viewMode === "modules" && nav.reviewPr !== null;
  if (nav.viewMode !== "modules" || activeReview) out.set("view", nav.viewMode);
  setId(out, "root", nav.compRoot);
  setId(out, "csel", nav.compSelectedId);
  setId(out, "lsel", nav.logicSelected);
  if (nav.flowExplorerOpen) out.set("fexp", "1");
  // A soft-closed PR review can host the ordinary base-Map flow explorer. Its URL still carries
  // `rev=1` (reload resumes the review overlay), so persisting that base-Map ref would replay it as
  // a review flow after reload. Only carry a review flow while its review overlay is actually open.
  if (nav.flowSelection !== null && (!activeReview || nav.minimalSeedIds.length > 0)) {
    out.set("fsel", encodeFlowSelection(nav.flowSelection));
  }
  setId(out, "lroot", nav.logicRoot);
  if (nav.logicView !== "graph") out.set("lview", nav.logicView);
  setList(out, "lstack", nav.logicStack);
  setId(out, "mfocus", nav.moduleFocus);
  if (nav.serviceGroupingMode !== "folder") out.set("sgroup", nav.serviceGroupingMode);
  if (nav.serviceGroupingTargetSize !== DEFAULT_SERVICE_GROUPING_TARGET_SIZE) {
    out.set("sgsize", String(nav.serviceGroupingTargetSize));
  }
  if (nav.serviceGroupingLabelMode !== DEFAULT_SERVICE_GROUPING_LABEL_MODE) {
    out.set("sglabels", nav.serviceGroupingLabelMode);
  }
  setList(out, "mgraph", nav.minimalSeedIds);
  setList(out, "mexp", nav.moduleExpanded);
  if (nav.moduleRadius !== 1) out.set("mdepth", String(nav.moduleRadius));
  /** `hmode=node` is the baseline; only persist reach mode so default URLs stay short. */
  if (nav.highlightMode !== "node") out.set("hmode", nav.highlightMode);
  setList(out, "mhide", nav.hiddenCategories);
  if (nav.prsTab !== "open") out.set("prstate", nav.prsTab);
  if (nav.viewMode === "prs" && nav.prSelected !== null) {
    out.set("prn", String(nav.prSelected));
  } else if (activeReview) {
    out.set("prn", String(nav.reviewPr));
    out.set("rev", "1");
  }
  setId(out, "tsrc", nav.telemetrySourceId);
  setId(out, "env", nav.environment);
  return scopeToView(out, nav.viewMode, activeReview);
}

/** Drop keys owned by a lens other than the active one, so the URL mirrors only what's on screen.
 * Shared keys and the active lens's own keys survive; everything else (a stale dive/trail/selection
 * left in the store from a prior lens) is stripped. */
function scopeToView(out: Map<string, string>, viewMode: ViewMode, activeReview: boolean): Map<string, string> {
  const owned = new Set<string>(LENS_KEYS[viewMode]);
  const hasFlowSelection = out.has("fsel");
  for (const key of [...out.keys()]) {
    // `logicSelected` normally belongs only to the Logic lens. Paired with `fsel` during an active
    // Map review, however, it is the selected call target in the bottom flow pane.
    if (!SHARED_KEYS.has(key) && !owned.has(key) && !(key === "lsel" && hasFlowSelection && activeReview)) {
      out.delete(key);
    }
  }
  return out;
}

/** Decode present keys back into a partial NavState — absent keys stay unset (store keeps default). */
export function decodeNav(params: URLSearchParams): Partial<NavState> {
  const out: Partial<NavState> = {};
  const view = params.get("view");
  if (view === "call" || view === "ui" || view === "logic" || view === "modules" || view === "prs") {
    out.viewMode = view;
  }
  assignId(params, "root", out, "compRoot");
  assignId(params, "csel", out, "compSelectedId");
  assignId(params, "lsel", out, "logicSelected");
  if (params.get("fexp") === "1") out.flowExplorerOpen = true;
  const flowSelection = decodeFlowSelection(params.get("fsel"));
  if (flowSelection) out.flowSelection = flowSelection;
  assignId(params, "lroot", out, "logicRoot");
  const logicView = params.get("lview");
  if (logicView !== null && isLogicViewMode(logicView)) out.logicView = logicView;
  assignList(params, "lstack", out, "logicStack");
  assignId(params, "mfocus", out, "moduleFocus");
  const groupingMode = params.get("sgroup");
  if (groupingMode !== null && SERVICE_GROUPING_OPTIONS.some((option) => option.id === groupingMode)) {
    out.serviceGroupingMode = groupingMode as ServiceGroupingMode;
  }
  const groupingTargetSize = Number(params.get("sgsize"));
  if (params.has("sgsize") && isServiceGroupingTargetSize(groupingTargetSize)) {
    out.serviceGroupingTargetSize = groupingTargetSize;
  }
  const groupingLabelMode = params.get("sglabels");
  if (groupingLabelMode === "single" || groupingLabelMode === "pair") {
    out.serviceGroupingLabelMode = groupingLabelMode;
  }
  // Legacy pre-unification ui deep links carried the dive in `focus`; land it on the shared module
  // focus (best-effort compat — `sel`/`expand` ids meant the retired private spaces and are dropped).
  if (view === "ui" && out.moduleFocus === undefined) assignId(params, "focus", out, "moduleFocus");
  assignList(params, "mgraph", out, "minimalSeedIds");
  assignList(params, "mexp", out, "moduleExpanded");
  const moduleRadius = params.get("mdepth");
  if (moduleRadius !== null && !Number.isNaN(Number(moduleRadius))) out.moduleRadius = Number(moduleRadius);
  /** Accept only the two known highlight modes; junk leaves the store default intact. */
  const highlightMode = params.get("hmode");
  if (highlightMode === "reach" || highlightMode === "node") out.highlightMode = highlightMode;
  assignList(params, "mhide", out, "hiddenCategories");
  const prsTab = params.get("prstate");
  if (prsTab === "open" || prsTab === "closed") out.prsTab = prsTab;
  const reviewActive = params.get("rev") === "1";
  if (reviewActive) out.reviewActive = true;
  const prNumber = params.get("prn");
  if (prNumber !== null && Number.isInteger(Number(prNumber)) && Number(prNumber) > 0) {
    if (reviewActive) {
      out.reviewPr = Number(prNumber);
    } else {
      out.prSelected = Number(prNumber);
    }
  }
  assignId(params, "tsrc", out, "telemetrySourceId");
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
    prev.compRoot !== next.compRoot ||
    prev.moduleFocus !== next.moduleFocus ||
    // Building/closing the minimal-graph overlay is a real navigation, so Back returns to the level
    // you built it from (the overlay's grown state is ephemeral and never in the URL).
    prev.minimalSeedIds.join(",") !== next.minimalSeedIds.join(",") ||
    prev.reviewPr !== next.reviewPr ||
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
