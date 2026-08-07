const STORAGE_KEY = "meridian.sourceDockPreference";

export const DEFAULT_SOURCE_DOCK_RATIO = 0.6;
export const MIN_SOURCE_DOCK_RATIO = 0.4;
export const MAX_SOURCE_DOCK_RATIO = 0.9;

interface SourceDockPreference {
  version: 1;
  ratio: number;
}

/** The preferred ratio is global to the reader and best-effort across browser sessions. Viewport
 * constraints remain runtime-only so narrowing a window never overwrites the wider preference. */
export function readSourceDockRatio(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SOURCE_DOCK_RATIO;
    const value = JSON.parse(raw) as Partial<SourceDockPreference> | null;
    return value?.version === 1 && typeof value.ratio === "number" && Number.isFinite(value.ratio)
      ? clampSourceDockRatio(value.ratio)
      : DEFAULT_SOURCE_DOCK_RATIO;
  } catch {
    return DEFAULT_SOURCE_DOCK_RATIO;
  }
}

export function writeSourceDockRatio(ratio: number): void {
  const preference: SourceDockPreference = { version: 1, ratio: clampSourceDockRatio(ratio) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // A blocked or unavailable localStorage leaves the in-memory resize fully functional.
  }
}

export function clampSourceDockRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SOURCE_DOCK_RATIO;
  return Math.max(MIN_SOURCE_DOCK_RATIO, Math.min(MAX_SOURCE_DOCK_RATIO, ratio));
}
