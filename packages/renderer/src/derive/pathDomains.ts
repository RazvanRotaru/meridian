/**
 * Stable filesystem-domain grouping for dense architectural views.
 *
 * Most extracted paths share a long source root (`src/aria/app`, `packages/foo/src`, ...). The
 * useful label is the first directory BELOW that root, not `src`. A handful of generated/resource
 * paths must not erase that prefix for the majority, so the common root is derived from the largest
 * first-segment cohort when it is a true majority. Outliers retain their own first directory.
 */

export interface PathDomainInput {
  id: string;
  file: string | null | undefined;
}

export interface PathDomain {
  /** Full stable directory key; labels may collide, keys may not. */
  key: string;
  /** Human-sized basename displayed on the parent frame. */
  label: string;
  ids: string[];
}

const ROOT_KEY = "(root)";

export function groupByPathDomain(entries: readonly PathDomainInput[]): PathDomain[] {
  const prepared = entries
    .map((entry) => ({ id: entry.id, dirs: directorySegments(entry.file) }))
    .sort((a, b) => compareCodeUnit(a.id, b.id));
  const paths = prepared.map((entry) => entry.dirs).filter((dirs) => dirs.length > 0);
  const commonPrefix = dominantCommonPrefix(paths);
  const grouped = new Map<string, { label: string; ids: string[] }>();

  for (const entry of prepared) {
    const domain = domainFor(entry.dirs, commonPrefix);
    const existing = grouped.get(domain.key);
    if (existing) {
      existing.ids.push(entry.id);
    } else {
      grouped.set(domain.key, { label: domain.label, ids: [entry.id] });
    }
  }

  return [...grouped.entries()]
    .map(([key, value]) => ({ key, label: value.label, ids: value.ids.sort() }))
    .sort((a, b) => compareCodeUnit(a.label, b.label) || compareCodeUnit(a.key, b.key));
}

function directorySegments(file: string | null | undefined): string[] {
  if (!file) {
    return [];
  }
  const segments = file.replaceAll("\\", "/").split("/").filter(Boolean);
  segments.pop(); // UnitMetrics.moduleFile is a file, never a directory.
  return segments;
}

function domainFor(dirs: readonly string[], commonPrefix: readonly string[]): { key: string; label: string } {
  if (dirs.length === 0) {
    return { key: ROOT_KEY, label: ROOT_KEY };
  }
  const sharesPrefix = commonPrefix.length > 0
    && commonPrefix.every((segment, index) => dirs[index] === segment);
  const depth = sharesPrefix ? commonPrefix.length : 0;
  const label = dirs[depth] ?? dirs.at(-1) ?? ROOT_KEY;
  // Keep enough ancestry in the key to distinguish linked systems with the same `components` /
  // `services` basename; only the compact basename becomes visible chrome.
  const keyDepth = Math.min(dirs.length, depth + 1);
  return { key: dirs.slice(0, Math.max(1, keyDepth)).join("/"), label };
}

function dominantCommonPrefix(paths: readonly string[][]): string[] {
  if (paths.length === 0) {
    return [];
  }
  const byFirst = new Map<string, string[][]>();
  for (const path of paths) {
    const list = byFirst.get(path[0]);
    if (list) {
      list.push(path);
    } else {
      byFirst.set(path[0], [path]);
    }
  }
  const cohorts = [...byFirst.entries()]
    .sort((a, b) => b[1].length - a[1].length || compareCodeUnit(a[0], b[0]));
  const cohort = (cohorts[0]?.[1].length ?? 0) > paths.length / 2 ? cohorts[0][1] : paths;
  const limit = Math.min(...cohort.map((path) => path.length));
  let depth = 0;
  while (depth < limit && cohort.every((path) => path[depth] === cohort[0][depth])) {
    depth += 1;
  }
  return cohort[0].slice(0, depth);
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
