/**
 * Resolve the current Map/minimal selection (or the visible file cards when nothing is selected)
 * to browser-relative source paths for related-PR discovery. Paths always come from
 * `GraphNode.location.file`: node-id module paths are not filesystem paths for every language.
 */

import type { Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import { normalizePath } from "./matchAffectedFiles";

const MAX_PATHS = 100;

export interface FileScopeState {
  index: GraphIndex;
  moduleSelected: ReadonlySet<string>;
  minimalSeedIds: readonly string[];
  minimalRfNodes: readonly Node[];
  moduleRfNodes: readonly Node[];
}

export interface FilesInScopeResult {
  paths: string[];
  truncated: boolean;
}

/** The normalized, deduplicated paths currently selected or visible, capped at 100. */
export function filesInScope(state: FileScopeState): string[] {
  return filesInScopeResult(state).paths;
}

/** Same resolution as filesInScope, with an explicit indication that the 100-path cap applied. */
export function filesInScopeResult(state: FileScopeState): FilesInScopeResult {
  const candidates =
    state.moduleSelected.size > 0
      ? [...state.moduleSelected].flatMap((id) => pathsForSelectedId(id, state.index))
      : visibleFilePaths(state);
  const paths: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const candidate of candidates) {
    const path = normalizePath(candidate);
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    if (paths.length < MAX_PATHS) {
      paths.push(path);
    } else {
      truncated = true;
    }
  }
  return { paths, truncated };
}

function pathsForSelectedId(id: string, index: GraphIndex): string[] {
  const node = index.nodesById.get(id);
  if (!node) {
    return [];
  }
  if (node.kind === "module") {
    return [node.location.file];
  }
  if (node.kind === "package") {
    return descendantModulePaths(id, index);
  }
  const ancestors = index.ancestorsOf(id);
  for (let position = ancestors.length - 1; position >= 0; position -= 1) {
    const ancestor = ancestors[position];
    if (ancestor.kind === "module") {
      return [ancestor.location.file];
    }
  }
  return [];
}

function descendantModulePaths(rootId: string, index: GraphIndex): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    for (const child of index.childrenOf(id)) {
      if (child.kind === "module") {
        paths.push(child.location.file);
      } else {
        stack.push(child.id);
      }
    }
  }
  return paths;
}

function visibleFilePaths(state: FileScopeState): string[] {
  const nodes = state.minimalSeedIds.length > 0 ? state.minimalRfNodes : state.moduleRfNodes;
  return nodes
    .filter((node) => node.type === "file")
    .map((node) => state.index.nodesById.get(node.id)?.location.file)
    .filter((path): path is string => typeof path === "string");
}
