import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

export interface ModuleRevealState {
  moduleFocus: string | null;
  moduleExpanded: Set<string>;
  moduleSelected: Set<string>;
}

export function withAncestorsOf(nodeId: string, index: GraphIndex, expanded: ReadonlySet<string>): Set<string> {
  const next = new Set(expanded);
  addAncestorsOf(next, nodeId, index);
  return next;
}

export function withAncestorsOfMany(nodeIds: readonly string[], index: GraphIndex, expanded: ReadonlySet<string>): Set<string> {
  const next = new Set(expanded);
  nodeIds.forEach((nodeId) => addAncestorsOf(next, nodeId, index));
  return next;
}

export function moduleRevealStateFor(nodeIds: readonly string[], index: GraphIndex): ModuleRevealState | null {
  const modules = uniqueModules(nodeIds, index);
  if (modules.length === 0) {
    return null;
  }
  const focus = commonPackageFocus(modules.map((module) => module.id), index);
  return {
    moduleFocus: focus,
    moduleExpanded: expandedModulePaths(modules, focus, index),
    moduleSelected: new Set(modules.map((module) => module.id)),
  };
}

function addAncestorsOf(next: Set<string>, nodeId: string, index: GraphIndex): void {
  const visited = new Set<string>();
  let current: string | null | undefined = index.isContainer(nodeId) ? nodeId : index.parentOf.get(nodeId);
  while (current && !visited.has(current)) {
    visited.add(current);
    next.add(current);
    current = index.parentOf.get(current);
  }
}

function uniqueModules(nodeIds: readonly string[], index: GraphIndex): GraphNode[] {
  const modules: GraphNode[] = [];
  const seen = new Set<string>();
  for (const nodeId of nodeIds) {
    const module = nearestModule(nodeId, index);
    if (module && !seen.has(module.id)) {
      seen.add(module.id);
      modules.push(module);
    }
  }
  return modules;
}

function nearestModule(nodeId: string, index: GraphIndex): GraphNode | null {
  const ancestors = index.ancestorsOf(nodeId);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === "module") {
      return ancestors[i];
    }
  }
  return null;
}

/** The DEEPEST `package` ancestor shared by ALL of `nodeIds`, or null (repo root) when they share
 * none — the natural dive-in focus for revealing several nodes at once. */
export function commonPackageFocus(nodeIds: readonly string[], index: GraphIndex): string | null {
  const packagePaths = nodeIds.map((nodeId) => index.ancestorsOf(nodeId).filter((node) => node.kind === "package"));
  let common: GraphNode | null = null;
  for (let depth = 0; ; depth += 1) {
    const candidate = packagePaths[0]?.[depth];
    if (!candidate || packagePaths.some((path) => path[depth]?.id !== candidate.id)) {
      return common?.id ?? null;
    }
    common = candidate;
  }
}

function expandedModulePaths(modules: readonly GraphNode[], focus: string | null, index: GraphIndex): Set<string> {
  const expanded = new Set<string>();
  for (const module of modules) {
    let withinFocus = focus === null;
    for (const node of index.ancestorsOf(module.id)) {
      if (node.id === focus) {
        withinFocus = true;
        continue;
      }
      if (withinFocus && (node.kind === "package" || node.kind === "module")) {
        expanded.add(node.id);
      }
    }
  }
  return expanded;
}
