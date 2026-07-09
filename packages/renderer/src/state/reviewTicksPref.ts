/**
 * Persist a reader's PR-review progress — which logic flows they have ticked as reviewed — across
 * reloads, scoped per review (the CLI's `reviewKey`, which is stable across pushes and rebases). Each
 * tick stores a fingerprint of the flow it confirmed, so a flow that changed after being ticked can be
 * detected as "stale" and never silently stay green (see tickStateOf in derive/reviewData.ts).
 *
 * Mirrors solidMetricsPref: reads/writes are guarded — localStorage can be absent or throw (private
 * mode, a non-browser test env) — and default to no progress. The stored record is returned WHOLE:
 * this layer NEVER prunes ticks for unknown flowIds, so a transient extraction hiccup that drops a flow
 * from the affected set can't destroy the reader's progress (those ticks are just not shown/counted).
 */

const STORAGE_PREFIX = "meridian.review.";

export interface ReviewTick {
  /** ISO timestamp of the tick — display-only ("reviewed at …"). */
  at: string;
  /** flowFingerprint of the steps confirmed; a mismatch with the live flow marks the tick stale. */
  fingerprint: string;
}

export interface ReviewProgress {
  version: 1;
  ticks: Record<string, ReviewTick>;
}

/** localStorage key for a review scope. reviewKey is opaque (repo|branch|base) and rides through as-is. */
function storageKey(reviewKey: string): string {
  return STORAGE_PREFIX + reviewKey;
}

/** A fresh empty record — returned (never a shared constant) so a caller can safely mutate its ticks. */
function emptyProgress(): ReviewProgress {
  return { version: 1, ticks: {} };
}

/** Load this scope's ticks. Missing/malformed/version≠1 all fall back to empty — progress is best-effort. */
export function readReviewProgress(reviewKey: string): ReviewProgress {
  try {
    const raw = window.localStorage.getItem(storageKey(reviewKey));
    if (raw === null) {
      return emptyProgress();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isProgress(parsed)) {
      return emptyProgress();
    }
    // Return the stored ticks verbatim — unknown flowIds are kept, never pruned.
    return { version: 1, ticks: parsed.ticks };
  } catch {
    return emptyProgress();
  }
}

export function writeReviewProgress(reviewKey: string, progress: ReviewProgress): void {
  try {
    window.localStorage.setItem(storageKey(reviewKey), JSON.stringify(progress));
  } catch {
    // Persistence is best-effort; a blocked localStorage just means the ticks are session-only.
  }
}

export function clearReviewProgress(reviewKey: string): void {
  try {
    window.localStorage.removeItem(storageKey(reviewKey));
  } catch {
    // Best-effort, same as writeReviewProgress.
  }
}

/** Shape guard: a persisted record must be an object with version 1 and an object `ticks` map. */
function isProgress(value: unknown): value is ReviewProgress {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.ticks === "object" && record.ticks !== null;
}
