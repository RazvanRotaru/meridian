/**
 * Prevent a horizontal trackpad gesture from turning into browser Back while PR review is doing
 * work the reader did not explicitly ask to leave. Standards-compliant browsers honour the root
 * overscroll class; Safari currently needs the non-passive wheel fallback as well.
 *
 * The controller starts before URL restoration so a bookmarked/reloaded `rev=1` review is guarded
 * during its initial fetch + preparation, then follows the store for fresh entry/close transitions.
 * It never touches popstate, so toolbar/keyboard Back and Forward keep their normal URL semantics.
 */

import type { BlueprintState, BlueprintStore } from "../state/store";

const ROOT_LOCK_CLASS = "mrd-pr-review-navigation-lock";
const WHEEL_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };

type GuardState = Pick<BlueprintState, "minimalSeedIds" | "prReviewed" | "prReviewStatus" | "viewMode">;

export interface PrReviewNavigationGuard {
  /** Begin following live review state once bootstrap has created the store. */
  bindStore(store: BlueprintStore): void;
  /** Drop the temporary lock held while a `rev=1` URL is being restored. */
  completeInitialRestore(): void;
  dispose(): void;
}

/** True while preparation is cancelable or the visible review overlay owns the canvas. */
export function prReviewNeedsNavigationLock(state: GuardState): boolean {
  return state.prReviewStatus === "preparing"
    || (state.viewMode === "modules" && state.prReviewed !== null && state.minimalSeedIds.length > 0);
}

/** Trackpad history swipes are horizontal wheel sequences; ctrl+wheel is pinch zoom, not Back. */
export function isHorizontalNavigationWheel(event: Pick<WheelEvent, "ctrlKey" | "deltaX" | "deltaY">): boolean {
  return !event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY);
}

/** Install the root CSS lock and Safari wheel fallback for the lifetime of the renderer. */
export function startPrReviewNavigationGuard(): PrReviewNavigationGuard {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { bindStore() {}, completeInitialRestore() {}, dispose() {} };
  }

  // restoreFromUrl can spend meaningful time resolving and preparing a review before the store's
  // `preparing` flag is set. Hold the lock from the first boot frame when the URL already says rev=1.
  let restoringReviewUrl = reviewRestoreRequested(window.location.search);
  let active = false;
  let disposed = false;
  let store: BlueprintStore | null = null;
  let unsubscribe: (() => void) | null = null;

  const onWheel = (event: WheelEvent) => {
    if (
      !event.cancelable
      || !isHorizontalNavigationWheel(event)
      || canConsumeHorizontalWheel(event.target, event.deltaX)
    ) {
      return;
    }
    // Do not stop propagation: React Flow may still interpret the gesture. We only cancel the user
    // agent's boundary default action (history navigation).
    event.preventDefault();
  };

  const sync = (state: GuardState) => {
    if (disposed) {
      return;
    }
    const next = restoringReviewUrl || prReviewNeedsNavigationLock(state);
    if (next === active) {
      return;
    }
    active = next;
    document.documentElement.classList.toggle(ROOT_LOCK_CLASS, active);
    if (active) {
      window.addEventListener("wheel", onWheel, WHEEL_OPTIONS);
    } else {
      window.removeEventListener("wheel", onWheel, WHEEL_OPTIONS);
    }
  };

  // Apply the URL-derived lock synchronously, before bootstrap's first graph/provider await.
  sync(IDLE_GUARD_STATE);

  return {
    bindStore(nextStore) {
      if (disposed) {
        return;
      }
      unsubscribe?.();
      store = nextStore;
      unsubscribe = store.subscribe(sync);
      sync(store.getState());
    },
    completeInitialRestore() {
      if (disposed) {
        return;
      }
      restoringReviewUrl = false;
      sync(store?.getState() ?? IDLE_GUARD_STATE);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      store = null;
      restoringReviewUrl = false;
      if (active) {
        active = false;
        window.removeEventListener("wheel", onWheel, WHEEL_OPTIONS);
      }
      document.documentElement.classList.remove(ROOT_LOCK_CLASS);
    },
  };
}

const IDLE_GUARD_STATE: GuardState = {
  viewMode: "modules",
  prReviewed: null,
  prReviewStatus: "idle",
  minimalSeedIds: [],
};

/** Match the URL decoder's review contract; a stray `rev=1` without a valid PR is not a lock. */
export function reviewRestoreRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  const prNumber = Number(params.get("prn"));
  return params.get("rev") === "1" && Number.isInteger(prNumber) && prNumber > 0;
}

/** Let a real horizontal scroller consume the gesture until it reaches its own boundary. */
function canConsumeHorizontalWheel(target: EventTarget | null, deltaX: number): boolean {
  let element = typeof Element !== "undefined" && target instanceof Element ? target : null;
  while (element && element !== document.documentElement) {
    const style = window.getComputedStyle(element);
    const scrollable = /^(auto|overlay|scroll)$/.test(style.overflowX)
      && element.scrollWidth > element.clientWidth;
    if (scrollable) {
      const canScrollLeft = deltaX < 0 && element.scrollLeft > 0;
      const canScrollRight = deltaX > 0
        && element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      if (canScrollLeft || canScrollRight) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}
