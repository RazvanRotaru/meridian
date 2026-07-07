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

import type { BlueprintStore } from "./store";
import { decodeNavState, isNavigationChange, mergeNavIntoSearch, navFrom, type NavState } from "./urlState";

// The last URL we reflected — the push-vs-replace decision compares against it, and it seeds the
// echo guard so the first write after load never adds a spurious history entry.
let prevNav: NavState | null = null;
// True while a popstate-driven restore is writing to the store, so the writer stays muted.
let suppress = false;

/** Apply the URL's navigation state to the store and lay out the restored view. Inert off-DOM. */
export async function restoreFromUrl(store: BlueprintStore): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }
  const nav = decodeNavState(new URLSearchParams(window.location.search));
  // Apply the COMPLETE structural state (not just the keys the URL carried) so a back/forward to a
  // sparser URL resets fields the previous state had set — otherwise a dive/selection never undoes.
  // `environment` is deliberately excluded: nulling telemetry on every restore is undesirable, so it
  // is apply-only via applyEnvironment below.
  store.setState(structuralState(nav));
  // The restored viewMode decides which layout pass runs; "call"/"ui" route through relayout()
  // (compRelayout / deriveLayout), "logic" needs its own ELK pass. This is the boot's first layout.
  if (store.getState().viewMode === "logic") {
    await store.getState().logicRelayout();
  } else {
    await store.getState().relayout();
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
  const onPopState = () => {
    suppress = true;
    void restoreFromUrl(store).finally(() => {
      suppress = false;
    });
  };
  window.addEventListener("popstate", onPopState);
  return () => {
    unsubscribe();
    window.removeEventListener("popstate", onPopState);
  };
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

// The structural fields of a full NavState as a store partial, the Set-valued ones (`expanded`,
// `moduleExpanded`, `hiddenCategories`) rebuilt as Sets. Always the complete set (not a sparse patch) so absent URL
// keys reset to their default. Excludes `environment`, which is apply-only (see restoreFromUrl).
function structuralState(nav: NavState): Record<string, unknown> {
  return {
    viewMode: nav.viewMode,
    focusId: nav.focusId,
    compRoot: nav.compRoot,
    selectedId: nav.selectedId,
    compSelectedId: nav.compSelectedId,
    logicSelected: nav.logicSelected,
    flowRootId: nav.flowRootId,
    flowDepth: nav.flowDepth,
    logicRoot: nav.logicRoot,
    logicView: nav.logicView,
    logicStack: nav.logicStack,
    expanded: new Set(nav.expanded),
    moduleFocus: nav.moduleFocus,
    moduleExpanded: new Set(nav.moduleExpanded),
    moduleRadius: nav.moduleRadius,
    hiddenCategories: new Set(nav.hiddenCategories),
  };
}
