/**
 * Persist the reader's "show per-card SOLID metrics" choice across reloads. The metric rows and smell
 * chips on the Service-composition scorecards can be toggled off for a decluttered, structure-only
 * view; the choice lives in localStorage so it survives a reload (the only persisted UI preference in
 * the renderer today). Reads/writes are guarded — localStorage can be absent or throw (private mode,
 * a non-browser test env) — and default to metrics SHOWN.
 */

const STORAGE_KEY = "meridian.showSolidMetrics";

export function readSolidMetricsPref(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeSolidMetricsPref(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Persistence is best-effort; a blocked localStorage just means the choice is session-only.
  }
}
