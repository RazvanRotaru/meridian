/**
 * Two-way bridge between the query string and the store: restore on boot (and on back/forward),
 * and push the URL forward as the reader navigates. The pure encode/decode lives in `urlState`;
 * this file owns the `window.history`/`location` side effects and the store subscription.
 *
 * A single `suppress` latch breaks the obvious feedback loop: a popstate triggers a restore, the
 * restore mutates the store, and the store subscription would otherwise write the URL straight
 * back — clobbering the very history entry the reader just navigated to. While restoring, we mute
 * the writer.
 */

import { selectedPrSummary, type BlueprintStore } from "./store";
import { decodeNavState, isNavigationChange, mergeNavIntoSearch, navFrom, type NavState } from "./urlState";

// The last URL we reflected — the push-vs-replace decision compares against it, and it seeds the
// echo guard so the first write after load never adds a spurious history entry.
let prevNav: NavState | null = null;
// True while a popstate-driven restore is writing to the store, so the writer stays muted.
let suppress = false;

/** Apply the URL's navigation state to the store and lay out the restored view. Inert off-DOM. */
export async function restoreFromUrl(store: BlueprintStore, search?: string): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  const nav = decodeNavState(new URLSearchParams(search ?? window.location.search));
  // Apply the COMPLETE structural state (not just the keys the URL carried) so a back/forward to a
  // sparser URL resets fields the previous state had set — otherwise a dive/selection never undoes.
  // `environment` is deliberately excluded: nulling telemetry on every restore is undesirable, so it
  // is apply-only via applyEnvironment below.
  store.setState(structuralState(nav));
  // The restored viewMode decides which layout pass runs; every module surface routes through
  // relayout() (→ moduleRelayout), "logic" needs its own ELK pass. This is the boot's first layout.
  if (store.getState().viewMode === "logic") {
    await store.getState().logicRelayout();
  } else {
    await store.getState().relayout();
  }
  // The minimal-graph overlay is restored state too: rebuild its nodes when the URL carried seeds so
  // a reload / back-forward into an open overlay reproduces it (structuralState already cleared it
  // when the URL carried none).
  if (store.getState().minimalSeedIds.length > 0) {
    await store.getState().minimalRelayout();
  }
  if (nav.flowSelection) {
    store.getState().selectFlowEntry(nav.flowSelection);
  }
  if (nav.reviewActive && nav.reviewPr !== null) {
    await restorePrReview(store, nav.reviewPr);
  } else if (nav.prSelected !== null) {
    // The checks lane keys off the summary's head SHA after files land. A bookmarked PR can restore
    // before either list page exists, so resolve its one-off summary first; the file/detail fetch
    // itself stays fire-and-forget like the existing plain-browser restore.
    await store.getState().ensurePrSummary(nav.prSelected);
    if (selectedPrSummary(store.getState(), nav.prSelected) !== null) {
      void store.getState().selectPr(nav.prSelected);
    }
  }
  applyEnvironment(store, nav.environment);
  prevNav = navFrom(store.getState());
}

/** Start reflecting the store into the URL and honouring back/forward. Returns an unsubscribe. */
export function startUrlSync(store: BlueprintStore): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const unsubscribe = store.subscribe(() => {
    if (suppress) {
      return;
    }
    writeUrl(store);
  });
  let restoreQueue = Promise.resolve();
  let pendingRestores = 0;
  const onPopState = () => {
    const search = window.location.search;
    pendingRestores += 1;
    suppress = true;
    const restore = restoreQueue.then(() => restoreFromUrl(store, search));
    // Keep the queue usable after a failed restore; completion is still observed below.
    restoreQueue = restore.catch(() => {});
    const finish = () => {
      pendingRestores -= 1;
      if (pendingRestores === 0) {
        suppress = false;
      }
    };
    void restore.then(finish, finish);
  };
  window.addEventListener("popstate", onPopState);
  return () => {
    unsubscribe();
    window.removeEventListener("popstate", onPopState);
  };
}

async function restorePrReview(store: BlueprintStore, number: number): Promise<void> {
  await store.getState().ensurePrSummary(number);
  if (selectedPrSummary(store.getState(), number) === null) {
    return;
  }
  await store.getState().selectPr(number);
  if (store.getState().prSelected !== number || store.getState().prFiles === null) {
    return;
  }
  // reviewPrInGraph is intentionally sync-only; awaiting its declared Promise keeps this chain
  // (and the URL-write suppression around it) complete before Forward restoration is released.
  await store.getState().reviewPrInGraph();
}

// Reflect the current store into the URL. A no-op when the URL wouldn't change (this also absorbs
// the store's non-navigation writes — layout, telemetry — since those don't move any NavState field).
function writeUrl(store: BlueprintStore): void {
  const nav = navFrom(store.getState());
  const search = mergeNavIntoSearch(window.location.search, nav);
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === current) {
    return;
  }
  const navigational = prevNav ? isNavigationChange(prevNav, nav) : false;
  if (navigational) {
    window.history.pushState(null, "", url);
  } else {
    window.history.replaceState(null, "", url);
  }
  prevNav = nav;
}

// Only apply an env the URL author explicitly chose AND the provider actually lists. This honours
// the "environment is never auto-defaulted by the app" invariant: the app still picks nothing —
// it just reproduces an explicit choice carried in a shared/bookmarked link.
function applyEnvironment(store: BlueprintStore, environment: string | null | undefined): void {
  if (!environment) {
    return;
  }
  const provider = store.getState().provider;
  if (!provider || !provider.listEnvironments().includes(environment)) {
    return;
  }
  store.getState().setEnvironment(environment);
  void store.getState().refreshTelemetry().catch(() => {});
}

// The structural fields of a full NavState as a store partial, the Set-valued ones (`moduleExpanded`,
// `hiddenCategories`) rebuilt as Sets. Always the complete set (not a sparse patch) so absent URL
// keys reset to their default. Excludes `environment`, which is apply-only (see restoreFromUrl).
// Exported for the serviceScope tests, which assert a restore always resets the scope.
export function structuralState(nav: NavState): Record<string, unknown> {
  const rebuildingReview = nav.reviewActive && nav.reviewPr !== null;
  return {
    viewMode: nav.viewMode,
    // The scoped Service sub-view is session-only (never URL-encoded), so NO history entry carries
    // it: restoring any entry — popstate back/forward included — must render the lens unscoped.
    serviceScope: null,
    compRoot: nav.compRoot,
    compSelectedId: nav.compSelectedId,
    logicSelected: nav.logicSelected,
    flowExplorerOpen: nav.flowExplorerOpen,
    flowSelection: null,
    flowPaneRfNodes: [],
    flowPaneRfEdges: [],
    flowPaneLayoutStatus: "idle",
    logicRoot: nav.logicRoot,
    logicView: nav.logicView,
    logicStack: nav.logicStack,
    moduleFocus: nav.moduleFocus,
    // Reset the overlay to the URL's state. A review rebuild starts empty because its current
    // artifact/files re-derive both seeds and expansion; replaying mgraph/mexp first would run a
    // redundant ELK pass with ids that may belong to the prior artifact.
    minimalSeedIds: rebuildingReview ? [] : nav.minimalSeedIds,
    minimalMemberIds: rebuildingReview ? [] : [...nav.minimalSeedIds],
    minimalArrange: false,
    minimalRfNodes: [],
    minimalRfEdges: [],
    minimalLayoutStatus: "idle",
    moduleExpanded: new Set(rebuildingReview ? [] : nav.moduleExpanded),
    moduleRadius: nav.moduleRadius,
    highlightMode: nav.highlightMode,
    hiddenCategories: new Set(nav.hiddenCategories),
    prsTab: nav.prsTab,
    prSelected: null,
    prFiles: null,
    prDiscussion: null,
    prChecks: null,
    prFilesTruncated: false,
    prFilesTotal: 0,
    prFilesOutside: 0,
    prFilesSuggestedSubdir: "",
    prsLoading: false,
    prsError: null,
  };
}
