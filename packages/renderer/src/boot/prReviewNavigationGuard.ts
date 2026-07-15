/**
 * Prevent a horizontal trackpad gesture from turning into browser Back while PR review is doing
 * work the reader did not explicitly ask to leave. Standards-compliant browsers honour the root
 * overscroll class; Safari currently needs the non-passive wheel fallback as well.
 *
 * The controller starts before URL restoration so a bookmarked/reloaded `rev=1` review is guarded
 * during its initial fetch + preparation, then follows the store for fresh entry/close transitions.
 * Browser Back needs a confirm because it is same-document URL navigation (so `beforeunload` never
 * fires); reload/tab close use the browser's native `beforeunload` confirmation instead.
 */

import type { BlueprintState, BlueprintStore } from "../state/store";

const ROOT_LOCK_CLASS = "mrd-pr-review-navigation-lock";
const WHEEL_OPTIONS: AddEventListenerOptions = { capture: true, passive: false };
export const PR_REVIEW_LEAVE_MESSAGE = "Are you sure you want to leave this page? All review progress will be lost.";
export const REVIEW_COMMENT_LEAVE_MESSAGE = "You have an unfinished comment. Leave and discard it?";

type GuardState = Pick<
  BlueprintState,
  "minimalSeedIds" | "prReviewed" | "prReviewStatus" | "reviewLineComposer" | "viewMode"
>;

export interface PrReviewNavigationGuard {
  /** Begin following live review state once bootstrap has created the store. */
  bindStore(store: BlueprintStore): void;
  /** Drop the temporary lock held while a `rev=1` URL is being restored. */
  completeInitialRestore(): void;
  dispose(): void;
}

/** True while preparation is cancelable or a live (possibly parked/resumable) review exists. */
export function prReviewNeedsNavigationLock(state: GuardState): boolean {
  return state.prReviewStatus === "preparing"
    || state.prReviewed !== null
    || (state.reviewLineComposer?.body.trim().length ?? 0) > 0;
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
  let restoringCanceledHistory = false;

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Modern browsers intentionally replace custom copy with their own native warning, but setting
    // returnValue is still required by older engines to request the dialog.
    event.returnValue = leaveMessage(store);
  };

  const onPopState = (event: PopStateEvent) => {
    if (restoringCanceledHistory) {
      restoringCanceledHistory = false;
      event.stopImmediatePropagation();
      return;
    }
    if (window.confirm(leaveMessage(store))) {
      return;
    }
    // popstate cannot be canceled. Stop the URL-sync listener before it tears down the review, then
    // return to the history entry the reader just left. The follow-up popstate is swallowed above.
    event.stopImmediatePropagation();
    restoringCanceledHistory = true;
    window.history.forward();
  };

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
      window.addEventListener("beforeunload", onBeforeUnload);
      window.addEventListener("popstate", onPopState);
    } else {
      window.removeEventListener("wheel", onWheel, WHEEL_OPTIONS);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
      restoringCanceledHistory = false;
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
        window.removeEventListener("beforeunload", onBeforeUnload);
        window.removeEventListener("popstate", onPopState);
      }
      document.documentElement.classList.remove(ROOT_LOCK_CLASS);
    },
  };
}

const IDLE_GUARD_STATE: GuardState = {
  viewMode: "modules",
  prReviewed: null,
  prReviewStatus: "idle",
  reviewLineComposer: null,
  minimalSeedIds: [],
};

function leaveMessage(store: BlueprintStore | null): string {
  return (store?.getState().reviewLineComposer?.body.trim().length ?? 0) > 0
    ? REVIEW_COMMENT_LEAVE_MESSAGE
    : PR_REVIEW_LEAVE_MESSAGE;
}

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
