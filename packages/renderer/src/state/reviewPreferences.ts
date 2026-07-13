/**
 * User preferences for the PR-review experience. These settings are intentionally global to the
 * browser profile rather than scoped to one PR: a reader's chosen split-view projection should
 * follow them between repositories and reviews. Reads and writes are best-effort because browser
 * privacy settings, storage quotas, and non-browser test environments can make localStorage throw.
 */

import { STATIC_LOGIC_VIEW_MODES, type StaticLogicViewMode } from "../derive/flowViewModel";

const STORAGE_KEY = "meridian.prReviewPreferences";

/** Request trace is an observed-telemetry surface, not a static PR-review projection. Keeping the
 * preference vocabulary narrower prevents a telemetry source from becoming a persisted review
 * layout choice. */
export type ReviewFlowSplitView = StaticLogicViewMode;
export type ReviewCodePreviewTrigger = "hover" | "click";

export interface ReviewPreferences {
  version: 3;
  flowSplitView: ReviewFlowSplitView;
  openFlowSplitOnSelect: boolean;
  codePreviewTrigger: ReviewCodePreviewTrigger;
}

export const DEFAULT_REVIEW_PREFERENCES: Readonly<ReviewPreferences> = {
  version: 3,
  flowSplitView: "timeline",
  openFlowSplitOnSelect: true,
  codePreviewTrigger: "hover",
};

/** Load the current reader's preferences, migrating v1/v2 and defaulting malformed v3 fields
 * independently so one damaged choice does not erase the other valid one. */
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
  if (record.version === 1) {
    if (typeof record.flowSplitView !== "string" || !isReviewFlowSplitView(record.flowSplitView)) {
      return defaults();
    }
    return {
      version: 3,
      flowSplitView: record.flowSplitView,
      openFlowSplitOnSelect: true,
      codePreviewTrigger: "hover",
    };
  }
  if (record.version !== 2 && record.version !== 3) {
    return defaults();
  }
  const flowSplitView = typeof record.flowSplitView === "string" && isReviewFlowSplitView(record.flowSplitView)
    ? record.flowSplitView
    : DEFAULT_REVIEW_PREFERENCES.flowSplitView;
  const openFlowSplitOnSelect = typeof record.openFlowSplitOnSelect === "boolean"
    ? record.openFlowSplitOnSelect
    : DEFAULT_REVIEW_PREFERENCES.openFlowSplitOnSelect;
  const codePreviewTrigger = record.version === 3
    && typeof record.codePreviewTrigger === "string"
    && isReviewCodePreviewTrigger(record.codePreviewTrigger)
    ? record.codePreviewTrigger
    : DEFAULT_REVIEW_PREFERENCES.codePreviewTrigger;
  return { version: 3, flowSplitView, openFlowSplitOnSelect, codePreviewTrigger };
}

function defaults(): ReviewPreferences {
  return { ...DEFAULT_REVIEW_PREFERENCES };
}

function isReviewFlowSplitView(value: string): value is ReviewFlowSplitView {
  return STATIC_LOGIC_VIEW_MODES.some((entry) => entry.mode === value);
}

function isReviewCodePreviewTrigger(value: string): value is ReviewCodePreviewTrigger {
  return value === "hover" || value === "click";
}
