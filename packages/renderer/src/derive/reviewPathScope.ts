/**
 * Session-only path scoping for a PR review. Review file paths are repo-relative, so a scope is a
 * normalized path prefix matched on a `/` segment boundary — `src/aria/app` must never include
 * `src/aria/application`.
 */

import { normalizePath } from "./matchAffectedFiles";

/** Normalize free-form review path input without treating it as a filesystem path. */
export function normalizeReviewPathScope(path: string): string {
  return normalizePath(path.trim())
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/** Whether one changed-file path belongs to a review path scope. Empty scope means all files. */
export function isReviewPathInScope(path: string, scope: string | null): boolean {
  if (scope === null) {
    return true;
  }
  const normalizedPath = normalizeReviewPathScope(path);
  const normalizedScope = normalizeReviewPathScope(scope);
  if (normalizedScope === "") {
    return true;
  }
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

/**
 * Directory prefixes worth offering in the review scope autocomplete. Single-file directories are
 * omitted to keep a large PR's suggestion list useful; readers can still type any exact prefix.
 */
export function reviewPathSuggestions(paths: readonly string[]): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  for (const rawPath of new Set(paths.map(normalizeReviewPathScope))) {
    const segments = rawPath.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, files]) => files > 1)
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
