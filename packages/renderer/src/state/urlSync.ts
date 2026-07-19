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

import { telemetryEnvironmentSchema, telemetrySourceAllowsEnvironment } from "@meridian/core";
import { PERFORMANCE, startPerformanceSpan } from "../boot/performanceMarks";
import { selectedPrSummary, type BlueprintStore } from "./store";
import { decodeNavState, isNavigationChange, mergeNavIntoSearch, navFrom, type NavState } from "./urlState";

// The last URL we reflected — the push-vs-replace decision compares against it, and it seeds the
// echo guard so the first write after load never adds a spurious history entry.
let prevNav: NavState | null = null;
// True while a popstate-driven restore is writing to the store, so the writer stays muted.
let suppress = false;

type RestoreOutcome = "completed" | "superseded";

interface RestoreRun {
  signal: AbortSignal;
  isCurrent(): boolean;
}

type CurrentResult<T> =
  | { current: true; value: T }
  | { current: false };

/** Apply the URL's navigation state to the store and lay out the restored view. Inert off-DOM. */
export async function restoreFromUrl(store: BlueprintStore, search?: string): Promise<void> {
  await restoreFromUrlRun(store, search, null);
}

async function restoreFromUrlRun(
  store: BlueprintStore,
  search: string | undefined,
  run: RestoreRun | null,
): Promise<RestoreOutcome> {
  if (typeof window === "undefined") {
    return "completed";
  }
  if (!restoreIsCurrent(run)) {
    return "superseded";
  }
  const nav = decodeNavState(new URLSearchParams(search ?? window.location.search));
  const rebuildingReview = nav.reviewActive && nav.reviewPr !== null;
  const restoredViewMode = rebuildingReview ? "prs" : nav.viewMode;
  if (store.getState().reviewLineComposer !== null) {
    // The navigation guard already obtained explicit browser-level confirmation. Clear any queued
    // in-product transition before discarding so accepting Back cannot replay an older button click
    // on the way to the history entry, or leave a session-only composer invisibly blocking it.
    store.getState().keepEditingReviewLineComposer();
    store.getState().discardReviewLineComposer();
  }
  if (store.getState().viewMode === "prs" && restoredViewMode !== "prs") {
    store.getState().cancelPrReviewPreparation();
  }
  // Back/forward to a URL from before the review must end that session BEFORE its Map navigation
  // lands. The explicit endReviewSession option distinguishes history exit from merely browsing
  // the PR queue, which must keep the current review resumable.
  const hasNoReview = !nav.reviewActive && nav.reviewPr === null && nav.prSelected === null;
  if (hasNoReview && store.getState().prReviewed !== null) {
    const result = await currentResult(
      store.getState().selectPr(null, { endReviewSession: true }),
      run,
    );
    if (!result.current) {
      return "superseded";
    }
  }
  // A prepared-review restore has one clean entry invariant: no prior review session may still own
  // the store. This applies to a different PR, the same active PR, and a parked same-PR session.
  // Promote the outgoing review's exact baseline before publishing the target URL coordinate. The
  // old decoded pair remains eligible only for the bounded transport LRU and is either reused by a
  // same-review restore or discarded when the replacement pair commits.
  if (rebuildingReview && store.getState().prReviewed !== null) {
    const retired = await currentResult(
      store.getState().retirePrReviewForReplacement(),
      run,
    );
    if (!retired.current) {
      return "superseded";
    }
    if (!retired.value) {
      throw new Error("could not retire the outgoing pull-request review before URL restoration");
    }
  }
  if (!restoreIsCurrent(run)) {
    return "superseded";
  }
  // Apply the COMPLETE structural state (not just the keys the URL carried) so a back/forward to a
  // sparser URL resets fields the previous state had set — otherwise a dive/selection never undoes.
  // Telemetry coordinates are deliberately excluded: nulling loaded data on every sparse history
  // restore is undesirable, so explicit source/env values are apply-only below.
  store.getState().installNavigationRestore(nav);
  // Start this span at the first layout that contributes to the scene the reader will actually
  // see. A direct PR restore prepares its immutable projections first, then starts here at review
  // ELK; it must never time (or wait on) a hidden boot/base layout.
  let finishLayout = () => {};
  let initialLayoutStarted = false;
  const startInitialLayout = () => {
    if (restoreIsCurrent(run) && !initialLayoutStarted) {
      initialLayoutStarted = true;
      finishLayout = startPerformanceSpan(PERFORMANCE.initialLayout);
    }
  };
  try {
    if (rebuildingReview) {
      const outcome = await restorePrReview(store, nav.reviewPr!, startInitialLayout, run);
      if (outcome === "superseded") {
        return outcome;
      }
    } else {
      // The restored viewMode decides which layout pass runs; every module surface routes through
      // relayout() (→ moduleRelayout), while Logic owns its own ELK pass.
      startInitialLayout();
      if (store.getState().viewMode === "logic") {
        const result = await currentResult(store.getState().logicRelayout(), run);
        if (!result.current) {
          return "superseded";
        }
      } else {
        const result = await currentResult(store.getState().relayout(), run);
        if (!result.current) {
          return "superseded";
        }
      }
      // The minimal-graph overlay is restored state too: rebuild its nodes when the URL carried seeds so
      // a reload / back-forward into an open overlay reproduces it (the store transaction already
      // released the outgoing scene when the URL carried none).
      if (store.getState().minimalSeedIds.length > 0) {
        const result = await currentResult(store.getState().minimalRelayout(), run);
        if (!result.current) {
          return "superseded";
        }
      }
    }
    if (!rebuildingReview && nav.prSelected !== null) {
      // The checks lane keys off the summary's head SHA after files land. A bookmarked PR can restore
      // before either list page exists, so resolve its one-off summary first; the file/detail fetch
      // itself stays fire-and-forget like the existing plain-browser restore.
      const result = await currentResult(store.getState().ensurePrSummary(nav.prSelected), run);
      if (!result.current) {
        return "superseded";
      }
      if (selectedPrSummary(store.getState(), nav.prSelected) !== null) {
        void store.getState().selectPr(nav.prSelected);
      }
    }
    // A review flow must be replayed against the restored PR-head artifact, never the boot/base graph.
    // Both actions resolve after their visible ELK work, so first usable paint cannot race a restored
    // flow pane or its exact Map target.
    if (nav.flowSelection) {
      startInitialLayout();
      const selection = await currentResult(store.getState().selectFlowEntry(nav.flowSelection), run);
      if (!selection.current) {
        return "superseded";
      }
      if (nav.logicSelected !== null) {
        const target = await currentResult(store.getState().selectFlowPaneTarget(nav.logicSelected), run);
        if (!target.current) {
          return "superseded";
        }
      }
    }
  } finally {
    // Error/empty-review surfaces have no ELK pass, but still get one well-formed zero-work span.
    if (restoreIsCurrent(run)) {
      startInitialLayout();
    }
    if (initialLayoutStarted) {
      finishLayout();
    }
  }
  if (!restoreIsCurrent(run)) {
    return "superseded";
  }
  applyTelemetryCoordinates(store, nav.telemetrySourceId, nav.environment);
  if (!restoreIsCurrent(run)) {
    return "superseded";
  }
  prevNav = navFrom(store.getState());
  return "completed";
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
  let restoreGeneration = 0;
  let activeRestoreController: AbortController | null = null;
  let stopped = false;
  const onPopState = () => {
    const search = window.location.search;
    const generation = ++restoreGeneration;
    activeRestoreController?.abort();
    const controller = new AbortController();
    activeRestoreController = controller;
    suppress = true;
    // Cancel at event receipt, not after an awaited restore step: a prior rev=1 restore may be
    // blocked on a long server stream, and the newly requested history entry must abandon it now.
    if (store.getState().prReviewStatus === "preparing") {
      store.getState().cancelPrReviewPreparation();
    }
    const run: RestoreRun = {
      signal: controller.signal,
      isCurrent: () => !stopped
        && restoreGeneration === generation
        && activeRestoreController === controller,
    };
    void restoreFromUrlRun(store, search, run)
      // A failed history entry must not poison the next Back/Forward event.
      .catch(() => {})
      .finally(() => {
        if (!run.isCurrent()) {
          return;
        }
        activeRestoreController = null;
        suppress = false;
      });
  };
  window.addEventListener("popstate", onPopState);
  return () => {
    stopped = true;
    restoreGeneration += 1;
    activeRestoreController?.abort();
    activeRestoreController = null;
    suppress = false;
    unsubscribe();
    window.removeEventListener("popstate", onPopState);
  };
}

async function restorePrReview(
  store: BlueprintStore,
  number: number,
  onVisibleLayoutStart: () => void,
  run: RestoreRun | null,
): Promise<RestoreOutcome> {
  const handoff = await currentResult(
    store.getState().restorePreparedPrReview(number, { onVisibleLayoutStart }),
    run,
  );
  if (!handoff.current) {
    return "superseded";
  }
  if (handoff.value) {
    return "completed";
  }
  const summary = await currentResult(store.getState().ensurePrSummary(number), run);
  if (!summary.current) {
    return "superseded";
  }
  if (selectedPrSummary(store.getState(), number) === null) {
    return "completed";
  }
  const selection = await currentResult(store.getState().selectPr(number), run);
  if (!selection.current) {
    return "superseded";
  }
  if (store.getState().prSelected !== number || store.getState().prFiles === null) {
    return "completed";
  }
  // Prepare-first is blocking: a restored review stays on the PRs waiting surface until the cached
  // or freshly prepared HEAD graph has swapped and reviewPrInGraph enters the Map.
  const review = await currentResult(store.getState().reviewPrInGraph({ onVisibleLayoutStart }), run);
  return review.current ? "completed" : "superseded";
}

function restoreIsCurrent(run: RestoreRun | null): boolean {
  return run === null || (!run.signal.aborted && run.isCurrent());
}

/**
 * Await one restore step only while its popstate generation is current. Aborting resolves this
 * wrapper immediately, while the attached fulfillment/rejection handlers safely drain work that
 * cannot itself accept an AbortSignal. Every caller gates its next mutation on the tagged result.
 */
async function currentResult<T>(operation: Promise<T>, run: RestoreRun | null): Promise<CurrentResult<T>> {
  if (run === null) {
    return { current: true, value: await operation };
  }
  if (!restoreIsCurrent(run)) {
    void operation.catch(() => {});
    return { current: false };
  }
  return await new Promise<CurrentResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (result: CurrentResult<T>) => {
      if (settled) return;
      settled = true;
      run.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ current: false });
    run.signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(restoreIsCurrent(run) ? { current: true, value } : { current: false }),
      (error: unknown) => {
        if (settled || !restoreIsCurrent(run)) {
          finish({ current: false });
          return;
        }
        settled = true;
        run.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (!restoreIsCurrent(run)) {
      onAbort();
    }
  });
}

// Reflect the current store into the URL. A no-op when the URL wouldn't change (this also absorbs
// the store's non-navigation writes — layout, telemetry — since those don't move any NavState field).
function writeUrl(store: BlueprintStore): void {
  const nav = navFrom(store.getState());
  const search = mergeNavIntoSearch(window.location.search, nav);
  const url = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === current) {
    // Some session-only state is deliberately omitted from the URL (notably nested PR extraction).
    // Still advance the comparison baseline so a later encoded repaint is not misclassified against
    // stale in-memory navigation state.
    prevNav = nav;
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

// Reproduce only coordinates the URL author explicitly chose. Source must be restored before env;
// otherwise a bookmarked synthetic environment could be applied to a boot-preselected saved file.
// An arbitrary source accepts a typed URL environment even when it is not one of its suggestions.
function applyTelemetryCoordinates(
  store: BlueprintStore,
  sourceId: string | null | undefined,
  environment: string | null | undefined,
): void {
  if (sourceId) {
    if (!store.getState().telemetrySources.some((source) => source.id === sourceId)) return;
    store.getState().setTelemetrySource(sourceId);
  }
  if (!environment) {
    return;
  }
  const parsedEnvironment = telemetryEnvironmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) return;
  const normalizedEnvironment = parsedEnvironment.data;
  const state = store.getState();
  const provider = state.provider;
  const descriptor = state.telemetrySourceId === null
    ? null
    : state.telemetrySources.find((source) => source.id === state.telemetrySourceId) ?? null;
  const allowed = descriptor === null
    ? provider?.listEnvironments().includes(normalizedEnvironment) === true
    : telemetrySourceAllowsEnvironment(descriptor, normalizedEnvironment);
  if (!provider || !allowed) {
    return;
  }
  state.setEnvironment(normalizedEnvironment);
  void state.refreshTelemetry().catch(() => {});
}
