import {
  createPrReviewProgressSnapshot,
  PR_REVIEW_PROGRESS_MODEL,
  reducePrReviewProgress,
} from "@meridian/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { progressStageFromReviewState, readStoredPrReviewProgressHandoff } from "./bootProgress";

const IDLE = {
  prsLoading: false,
  prSelected: null,
  prReviewed: null,
  prReviewStatus: "idle" as const,
  prPrepareStage: null,
  prReviewProgress: createPrReviewProgressSnapshot(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("boot review progress mapping", () => {
  it("reports detail loading and each server analysis stage", () => {
    expect(progressStageFromReviewState({ ...IDLE, prsLoading: true, prSelected: 41 }))
      .toBe("review-details");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "resolve",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "resolve",
      }),
    })).toBe("review-resolve");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "clone",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "clone",
      }),
    })).toBe("review-clone");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "checkout",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "checkout",
      }),
    })).toBe("review-checkout");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "extract",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "extract",
      }),
    })).toBe("review-extract");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "extract-head",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "extract-head",
      }),
    })).toBe("review-extract-head");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "reuse-head",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "reuse-head",
      }),
    })).toBe("review-reuse-head");
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "reuse-merge-base",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "reuse-merge-base",
      }),
    })).toBe("review-reuse-merge-base");
  });

  it("supports a prepared-pair handoff without inventing clone work", () => {
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prReviewStatus: "preparing",
      prPrepareStage: "load-artifacts",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "load-artifacts",
      }),
    })).toBe("review-artifacts");
  });

  it("reports projection only after the review has exact graph state", () => {
    expect(progressStageFromReviewState({
      ...IDLE,
      prSelected: 41,
      prPrepareStage: "projection",
      prReviewProgress: reducePrReviewProgress(IDLE.prReviewProgress, {
        type: "stage",
        stage: "projection",
      }),
    })).toBe("review-projection");
    expect(progressStageFromReviewState({ ...IDLE, prSelected: 41, prReviewed: 41 }))
      .toBe("review-projection");
    expect(progressStageFromReviewState(IDLE)).toBeNull();
  });

  it("reads only the destination-scoped landing handoff and consumes it once", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "handoff" });
    const values = new Map<string, string>();
    const pathname = "/view";
    const search = "?id=head&prn=7&rev=1";
    const key = PR_REVIEW_PROGRESS_MODEL.handoffStorageKeyPrefix + pathname + search;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    values.set(key, JSON.stringify({
      version: PR_REVIEW_PROGRESS_MODEL.version,
      destination: pathname + search,
      createdAt: Date.now(),
      progress,
    }));
    vi.stubGlobal("window", {
      location: { pathname, search },
      sessionStorage: {
        getItem: (candidate: string) => values.get(candidate) ?? null,
        removeItem: (candidate: string) => values.delete(candidate),
      },
    });

    expect(readStoredPrReviewProgressHandoff()).toEqual(progress);
    expect(values.has(key)).toBe(true);
    expect(readStoredPrReviewProgressHandoff(true)).toEqual(progress);
    expect(values.has(key)).toBe(false);
    expect(readStoredPrReviewProgressHandoff()).toBeNull();
  });

  it("rejects stale and cross-destination handoff envelopes", () => {
    let progress = reducePrReviewProgress(
      createPrReviewProgressSnapshot(7),
      { type: "stage", stage: "resolve" },
    );
    progress = reducePrReviewProgress(progress, { type: "analysis-done", cache: "hit" });
    progress = reducePrReviewProgress(progress, { type: "stage", stage: "handoff" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const pathname = "/view";
    const search = "?id=head&prn=7&rev=1";
    const key = PR_REVIEW_PROGRESS_MODEL.handoffStorageKeyPrefix + pathname + search;
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { pathname, search },
      sessionStorage: {
        getItem: (candidate: string) => values.get(candidate) ?? null,
        removeItem: (candidate: string) => values.delete(candidate),
      },
    });

    values.set(key, JSON.stringify({
      version: PR_REVIEW_PROGRESS_MODEL.version,
      destination: "/view?id=other&prn=7&rev=1",
      createdAt: Date.now(),
      progress,
    }));
    expect(readStoredPrReviewProgressHandoff()).toBeNull();

    values.set(key, JSON.stringify({
      version: PR_REVIEW_PROGRESS_MODEL.version,
      destination: pathname + search,
      createdAt: Date.now() - PR_REVIEW_PROGRESS_MODEL.handoffTtlMs - 1,
      progress,
    }));
    expect(readStoredPrReviewProgressHandoff()).toBeNull();

    const mismatchedSearch = "?id=head&prn=8&rev=1";
    const mismatchedKey = PR_REVIEW_PROGRESS_MODEL.handoffStorageKeyPrefix
      + pathname
      + mismatchedSearch;
    values.set(mismatchedKey, JSON.stringify({
      version: PR_REVIEW_PROGRESS_MODEL.version,
      destination: pathname + mismatchedSearch,
      createdAt: Date.now(),
      progress,
    }));
    vi.stubGlobal("window", {
      location: { pathname, search: mismatchedSearch },
      sessionStorage: {
        getItem: (candidate: string) => values.get(candidate) ?? null,
        removeItem: (candidate: string) => values.delete(candidate),
      },
    });
    expect(readStoredPrReviewProgressHandoff()).toBeNull();
  });
});
