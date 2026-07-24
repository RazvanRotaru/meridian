import {
  parsePrReviewProgressSnapshot,
  PR_REVIEW_PROGRESS_MODEL,
  type PrReviewProgressSnapshot,
} from "@meridian/core";
import type { PrAnalyzeStage, PrPrepareStage } from "../state/prAnalysis";

/**
 * Observable milestones in the renderer's blocking boot path.
 *
 * These are deliberately presentation-neutral. A cached analysis can move directly from the
 * revision-reuse stage to `review-artifacts`; skipped extraction work is never implied to have run.
 */
export type BootProgressStage =
  | "graph"
  | "index"
  | "services"
  | "initial-layout"
  | "review-details"
  | "review-resolve"
  | `review-${PrAnalyzeStage}`
  | "review-artifacts"
  | "review-projection";

export type BootProgressPath = "graph" | "review-analysis";

export interface BootProgressUpdate {
  stage: BootProgressStage;
  path: BootProgressPath;
  /** Present for every review boot update; rendered by the same canonical component as in-app. */
  reviewProgress: PrReviewProgressSnapshot | null;
}

export interface BootstrapProgressOptions {
  onProgress?: (update: BootProgressUpdate) => void;
  /** Already-consumed one-tab landing handoff, passed by main so the first paint can use it too. */
  reviewProgressHandoff?: PrReviewProgressSnapshot | null;
}

export interface BootProgressState {
  prsLoading: boolean;
  prSelected: number | null;
  prReviewed: number | null;
  prReviewStatus: "idle" | "preparing" | "error";
  prPrepareStage: PrPrepareStage | null;
  prReviewProgress: PrReviewProgressSnapshot;
}

/** Read the one-tab landing handoff. Direct/copied review URLs simply return null. */
export function readStoredPrReviewProgressHandoff(consume = false): PrReviewProgressSnapshot | null {
  if (typeof window === "undefined") return null;
  const destination = window.location.pathname + window.location.search;
  const key = PR_REVIEW_PROGRESS_MODEL.handoffStorageKeyPrefix + destination;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (consume) window.sessionStorage.removeItem(key);
    if (raw === null) return null;
    const envelope = JSON.parse(raw) as unknown;
    if (
      !isRecord(envelope)
      || envelope.version !== PR_REVIEW_PROGRESS_MODEL.version
      || envelope.destination !== destination
      || !Number.isSafeInteger(envelope.createdAt)
    ) {
      return null;
    }
    const now = Date.now();
    const createdAt = envelope.createdAt as number;
    if (
      createdAt > now + 5_000
      || now - createdAt > PR_REVIEW_PROGRESS_MODEL.handoffTtlMs
    ) {
      return null;
    }
    const parsed = parsePrReviewProgressSnapshot(envelope.progress);
    const prNumber = reviewPrNumber(window.location.search);
    return parsed?.status === "running"
      && parsed.activeStage === "handoff"
      && parsed.prNumber === prNumber
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewPrNumber(search: string): number | null {
  const params = new URLSearchParams(search);
  const value = Number(params.get("prn"));
  return params.get("rev") === "1" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** Translate live store state into the part of initial URL restoration that is otherwise hidden. */
export function progressStageFromReviewState(state: BootProgressState): BootProgressStage | null {
  const canonicalStage = state.prReviewProgress.activeStage;
  if (canonicalStage !== null) {
    switch (canonicalStage) {
      case "details":
        return "review-details";
      case "resolve":
        return "review-resolve";
      case "handoff":
      case "load-artifacts":
        return "review-artifacts";
      case "projection":
        return "review-projection";
      default:
        return `review-${canonicalStage}`;
    }
  }
  if (state.prReviewProgress.status === "success") {
    return "review-projection";
  }
  // Successful entry disarms cancellation before its synchronous projection changes lenses. Keep
  // that explicitly-published final stage visible even during the brief idle handoff boundary.
  if (state.prPrepareStage === "projection") {
    return "review-projection";
  }
  if (state.prReviewStatus === "preparing") {
    switch (state.prPrepareStage) {
      case "resolve":
        return "review-resolve";
      case "clone":
      case "checkout":
      case "extract":
      case "extract-head":
      case "reuse-head":
      case "extract-merge-base":
      case "reuse-merge-base":
        return `review-${state.prPrepareStage}`;
      case "load-artifacts":
        return "review-artifacts";
      default:
        return state.prReviewed === null ? "review-resolve" : "review-artifacts";
    }
  }
  if (state.prsLoading && state.prSelected !== null) {
    return "review-details";
  }
  if (state.prReviewed !== null) {
    return "review-projection";
  }
  return null;
}
