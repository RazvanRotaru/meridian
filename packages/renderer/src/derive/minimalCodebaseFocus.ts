/** LCA candidates and selective expansion paths for a minimal graph's codebase projection. */

import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

/** Try a shared file first, then package ancestors, and finally the repository overview. */
export function minimalCodebaseFocusCandidates(
  targetIds: readonly string[],
  index: GraphIndex,
): Array<string | null> {
  const candidates: Array<string | null> = [];
  const commonFile = deepestCommonOfKind(targetIds, index, "module");
  if (commonFile !== null) candidates.push(commonFile);
  const commonPackage = deepestCommonOfKind(targetIds, index, "package");
  if (commonPackage !== null) {
    candidates.push(commonPackage);
    const path = index.ancestorsOf(commonPackage);
    for (let index = path.length - 2; index >= 0; index -= 1) {
      if (path[index].kind === "package") candidates.push(path[index].id);
    }
  }
  candidates.push(null);
  return [...new Set(candidates)];
}

/** Expand strict target ancestors below `focus`, plus disclosure gates already open in Minimal. */
export function minimalCodebaseExpandedPaths(
  targetIds: readonly string[],
  focus: string | null,
  index: GraphIndex,
  retainedExpandedIds: ReadonlySet<string>,
): Set<string> {
  const expanded = new Set(retainedExpandedIds);
  for (const targetId of targetIds) {
    const path = index.ancestorsOf(targetId);
    const focusIndex = focus === null ? -1 : path.findIndex((node) => node.id === focus);
    if (focus !== null && focusIndex < 0) continue;
    for (let index = focusIndex + 1; index < path.length - 1; index += 1) {
      expanded.add(path[index].id);
    }
  }
  return expanded;
}

function deepestCommonOfKind(
  targetIds: readonly string[],
  index: GraphIndex,
  kind: GraphNode["kind"],
): string | null {
  const paths = targetIds.map((id) =>
    index.ancestorsOf(id).filter((node) => node.kind === kind).map((node) => node.id),
  );
  let common: string | null = null;
  for (let depth = 0; ; depth += 1) {
    const candidate = paths[0]?.[depth];
    if (candidate === undefined || paths.some((path) => path[depth] !== candidate)) return common;
    common = candidate;
  }
}
