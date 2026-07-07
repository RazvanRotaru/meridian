/**
 * Classify a source file (meridian `module`) into a coarse role from its path — the colour/legend
 * bucket the Module-map lens paints and the filter toggles hide. Pure path-segment heuristics: no
 * graph, no I/O. `entry` is never inferred here; the caller stamps it on the blast-radius root.
 */

/** The file's role. `entry` is assigned by the caller (the root file), never by path. */
export type ModuleCategory = "entry" | "ui" | "util" | "config" | "app";

/** Categories a viewer can toggle off — `entry`/`app` always show, so they're not offered. */
export const TOGGLEABLE_CATEGORIES: ModuleCategory[] = ["ui", "util", "config"];

export const CATEGORY_LABEL: Record<ModuleCategory, string> = {
  entry: "Entry",
  ui: "UI",
  util: "Utilities",
  config: "Config",
  app: "App",
};

const UTIL_SEGMENTS: ReadonlySet<string> = new Set(["utils", "util", "helpers", "lib", "shared", "common"]);
const UI_SEGMENTS: ReadonlySet<string> = new Set(["ui", "components", "component", "pages", "views", "hooks", "styles"]);
const CONFIG_NAMES: ReadonlySet<string> = new Set(["config", "constants", "types"]);

/**
 * A file's role from its module path. Checked in precedence order — util, then ui, then config —
 * so a path that reads as several roles resolves to the earliest listed. `app` is the catch-all for
 * ordinary domain code.
 */
export function categorize(modulePath: string): ModuleCategory {
  const segments = pathSegments(modulePath);
  if (segments.some((segment) => UTIL_SEGMENTS.has(segment))) {
    return "util";
  }
  if (segments.some((segment) => UI_SEGMENTS.has(segment))) {
    return "ui";
  }
  if (isConfig(segments)) {
    return "config";
  }
  return "app";
}

/** Config when a directory segment OR the file's own stem is one of the config names. */
function isConfig(segments: string[]): boolean {
  if (segments.some((segment) => CONFIG_NAMES.has(segment))) {
    return true;
  }
  return CONFIG_NAMES.has(fileStem(segments));
}

/** Lower-cased, extension-free path segments so matching is case- and suffix-insensitive. */
function pathSegments(modulePath: string): string[] {
  return modulePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/** The last segment with its file extension stripped, e.g. `config.ts` → `config`. */
function fileStem(segments: string[]): string {
  const last = segments[segments.length - 1] ?? "";
  const dot = last.indexOf(".");
  return dot === -1 ? last : last.slice(0, dot);
}
