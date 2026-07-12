/**
 * User preferences for the PR-review experience. These settings are intentionally global to the
 * browser profile rather than scoped to one PR: a reader's chosen split-view projection should
 * follow them between repositories and reviews. Reads and writes are best-effort because browser
 * privacy settings, storage quotas, and non-browser test environments can make localStorage throw.
 */

import { isLogicViewMode, type LogicViewMode } from "../derive/flowViewModel";

const STORAGE_KEY = "meridian.prReviewPreferences";

export type ReviewFlowSplitView = LogicViewMode;

export interface ReviewPreferences {
  version: 1;
  flowSplitView: ReviewFlowSplitView;
}

export const DEFAULT_REVIEW_PREFERENCES: Readonly<ReviewPreferences> = {
  version: 1,
  flowSplitView: "timeline",
};

/** Load the current reader's preferences, falling back as a whole for unknown or corrupt records. */
export function readReviewPreferences(): ReviewPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return defaults();
    }
    return coerce(JSON.parse(raw) as unknown);
  } catch {
    return defaults();
  }
}

/** Persist the complete versioned record. Failure leaves the in-memory preference usable. */
export function writeReviewPreferences(preferences: ReviewPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Persistence is best-effort; blocked localStorage makes the choice session-only.
  }
}

function coerce(value: unknown): ReviewPreferences {
  if (typeof value !== "object" || value === null) {
    return defaults();
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.flowSplitView !== "string"
    || !isLogicViewMode(record.flowSplitView)
  ) {
    return defaults();
  }
  return { version: 1, flowSplitView: record.flowSplitView };
}

function defaults(): ReviewPreferences {
  return { ...DEFAULT_REVIEW_PREFERENCES };
}
