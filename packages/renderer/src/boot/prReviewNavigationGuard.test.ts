import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintState, BlueprintStore } from "../state/store";
import {
  isHorizontalNavigationWheel,
  prReviewNeedsNavigationLock,
  reviewRestoreRequested,
  startPrReviewNavigationGuard,
} from "./prReviewNavigationGuard";

const IDLE = {
  viewMode: "modules" as const,
  prReviewed: null,
  prReviewStatus: "idle" as const,
  minimalSeedIds: [] as string[],
};

describe("PR review navigation gesture lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("locks while prepare-first review entry is in flight", () => {
    expect(prReviewNeedsNavigationLock({ ...IDLE, viewMode: "prs", prReviewStatus: "preparing" })).toBe(true);
  });

  it("locks only while an active review overlay is visible", () => {
    const review = { ...IDLE, prReviewed: 7, minimalSeedIds: ["ts:src/a.ts"] };
    expect(prReviewNeedsNavigationLock(review)).toBe(true);
    expect(prReviewNeedsNavigationLock({ ...review, minimalSeedIds: [] })).toBe(false);
    expect(prReviewNeedsNavigationLock({ ...review, viewMode: "logic" })).toBe(false);
  });

  it("recognizes horizontal history-wheel input without swallowing pinch or vertical scroll", () => {
    expect(isHorizontalNavigationWheel({ deltaX: 30, deltaY: 4, ctrlKey: false })).toBe(true);
    expect(isHorizontalNavigationWheel({ deltaX: -30, deltaY: 4, ctrlKey: false })).toBe(true);
    expect(isHorizontalNavigationWheel({ deltaX: 4, deltaY: 30, ctrlKey: false })).toBe(false);
    expect(isHorizontalNavigationWheel({ deltaX: 30, deltaY: 4, ctrlKey: true })).toBe(false);
  });

  it("only pre-locks a valid review restore URL", () => {
    expect(reviewRestoreRequested("?view=modules&prn=7&rev=1")).toBe(true);
    expect(reviewRestoreRequested("?rev=1")).toBe(false);
    expect(reviewRestoreRequested("?prn=0&rev=1")).toBe(false);
    expect(reviewRestoreRequested("?prn=nope&rev=1")).toBe(false);
  });

  it("installs early, follows store transitions, cancels horizontal wheel, and cleans up", () => {
    const browser = stubBrowser("?view=modules&prn=7&rev=1");
    const store = fakeStore(IDLE);
    const guard = startPrReviewNavigationGuard();

    // URL restoration is protected synchronously, before a store is bound.
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(true);
    expect(browser.add).toHaveBeenCalledWith("wheel", expect.any(Function), { capture: true, passive: false });

    guard.bindStore(store.store);
    guard.completeInitialRestore();
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(false);
    expect(browser.wheel).toBeNull();

    store.set({ viewMode: "prs", prReviewStatus: "preparing" });
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(true);
    expect(browser.wheel).not.toBeNull();

    const horizontal = wheelEvent(30, 3);
    browser.wheel!(horizontal.event);
    expect(horizontal.preventDefault).toHaveBeenCalledOnce();

    const vertical = wheelEvent(3, 30);
    browser.wheel!(vertical.event);
    expect(vertical.preventDefault).not.toHaveBeenCalled();

    // Successful entry may briefly clear `preparing`; the visible overlay keeps the lock active.
    store.set({
      viewMode: "modules",
      prReviewStatus: "idle",
      prReviewed: 7,
      minimalSeedIds: ["ts:src/a.ts"],
    });
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(true);

    // Explicit Close parks a resumable review but releases gesture suppression.
    store.set({ minimalSeedIds: [] });
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(false);
    expect(browser.wheel).toBeNull();

    guard.dispose();
    store.set({ viewMode: "prs", prReviewStatus: "preparing" });
    guard.bindStore(store.store);
    expect(browser.classes.has("mrd-pr-review-navigation-lock")).toBe(false);
    expect(browser.wheel).toBeNull();
  });
});

function fakeStore(initial: typeof IDLE): {
  store: BlueprintStore;
  set: (partial: Partial<BlueprintState>) => void;
} {
  let state = initial as unknown as BlueprintState;
  const listeners = new Set<(state: BlueprintState, previous: BlueprintState) => void>();
  return {
    store: {
      getState: () => state,
      subscribe: (listener: (state: BlueprintState, previous: BlueprintState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as BlueprintStore,
    set(partial) {
      const previous = state;
      state = { ...state, ...partial };
      listeners.forEach((listener) => listener(state, previous));
    },
  };
}

function stubBrowser(search: string) {
  const classes = new Set<string>();
  let wheel: ((event: WheelEvent) => void) | null = null;
  const add = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "wheel") wheel = listener as (event: WheelEvent) => void;
  });
  const remove = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    if (type === "wheel" && wheel === listener) wheel = null;
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        toggle(name: string, force?: boolean) {
          if (force) classes.add(name);
          else classes.delete(name);
          return force === true;
        },
        remove(name: string) {
          classes.delete(name);
        },
      },
    },
  });
  vi.stubGlobal("window", {
    location: { search },
    addEventListener: add,
    removeEventListener: remove,
    getComputedStyle: () => ({ overflowX: "visible" }),
  });
  return {
    classes,
    add,
    remove,
    get wheel() {
      return wheel;
    },
  };
}

function wheelEvent(deltaX: number, deltaY: number) {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    event: {
      cancelable: true,
      ctrlKey: false,
      deltaX,
      deltaY,
      target: null,
      preventDefault,
    } as unknown as WheelEvent,
  };
}
