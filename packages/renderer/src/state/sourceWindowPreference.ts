import type { SourceWindowRect } from "../components/source/sourceWindowGeometry";

const STORAGE_KEY = "meridian.sourceDockPreference";

export interface SourceWindowPreference {
  version: 2;
  rect: SourceWindowRect | null;
}

const DEFAULT_SOURCE_WINDOW_PREFERENCE: SourceWindowPreference = { version: 2, rect: null };
let memoryPreference = clonePreference(DEFAULT_SOURCE_WINDOW_PREFERENCE);
let memoryAuthoritative = false;

/** Read preferred shell-local CSS pixels. Runtime viewport constraints belong to geometry code. */
export function readSourceWindowPreference(): SourceWindowPreference {
  if (memoryAuthoritative) return clonePreference(memoryPreference);
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    memoryAuthoritative = true;
    return clonePreference(memoryPreference);
  }
  if (raw === null) {
    memoryPreference = clonePreference(DEFAULT_SOURCE_WINDOW_PREFERENCE);
    return clonePreference(memoryPreference);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return migrateToResponsiveDefault();
  }
  if (isSourceWindowPreference(value)) {
    memoryPreference = clonePreference(value);
    return clonePreference(memoryPreference);
  }

  // Shipped version 1 stored a width ratio. The branch-local incompatible version 2 stored
  // ratio/placement/sticky. Neither can manufacture a trustworthy two-dimensional rectangle.
  return migrateToResponsiveDefault();
}

/** Persist a user-committed rectangle. Pointer-move frames must stay runtime-only. */
export function writeSourceWindowPreference(
  rect: SourceWindowRect | null,
): SourceWindowPreference {
  memoryPreference = {
    version: 2,
    rect: isSourceWindowRect(rect) ? { ...rect } : null,
  };
  memoryAuthoritative = !persistPreference(memoryPreference);
  return clonePreference(memoryPreference);
}

export function resetSourceWindowPreference(): SourceWindowPreference {
  return writeSourceWindowPreference(null);
}

function persistPreference(preference: SourceWindowPreference): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
    return true;
  } catch {
    // The module-level copy keeps this browser session functional when storage is unavailable.
    return false;
  }
}

function migrateToResponsiveDefault(): SourceWindowPreference {
  memoryPreference = clonePreference(DEFAULT_SOURCE_WINDOW_PREFERENCE);
  memoryAuthoritative = !persistPreference(memoryPreference);
  return clonePreference(memoryPreference);
}

function isSourceWindowPreference(value: unknown): value is SourceWindowPreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; rect?: unknown };
  return candidate.version === 2
    && Object.prototype.hasOwnProperty.call(candidate, "rect")
    && (candidate.rect === null || isSourceWindowRect(candidate.rect));
}

function isSourceWindowRect(value: unknown): value is SourceWindowRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Partial<SourceWindowRect>;
  return typeof rect.x === "number"
    && Number.isFinite(rect.x)
    && typeof rect.y === "number"
    && Number.isFinite(rect.y)
    && typeof rect.width === "number"
    && Number.isFinite(rect.width)
    && rect.width > 0
    && typeof rect.height === "number"
    && Number.isFinite(rect.height)
    && rect.height > 0;
}

function clonePreference(preference: SourceWindowPreference): SourceWindowPreference {
  return {
    version: 2,
    rect: preference.rect === null ? null : { ...preference.rect },
  };
}
