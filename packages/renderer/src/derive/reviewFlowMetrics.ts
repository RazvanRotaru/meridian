/**
 * Per-flow measurements for the PR-review list: the file a node lives in, the affected files a flow
 * calls into, the module nodes it touches (for graph highlighting), and its step/branch size. All
 * pure and by `location.file` (never modulePath), split out of `reviewFlows` to keep each file small.
 */

import type { FlowStep } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { normalizePath } from "./matchAffectedFiles";

const MODULE_KIND = "module";

/** A node's normalized `location.file`, or null when it has none. */
export function fileOf(index: GraphIndex, id: string): string | null {
  const file = index.nodesById.get(id)?.location?.file;
  return file ? normalizePath(file) : null;
}

/** Distinct affected files reached by the callees, excluding the flow's own file (already "changed"). */
export function calleeFiles(index: GraphIndex, calleeIds: string[], rootFile: string | null): string[] {
  const files = new Set<string>();
  for (const id of calleeIds) {
    const file = fileOf(index, id);
    if (file !== null && file !== rootFile) {
      files.add(file);
    }
  }
  return [...files].sort();
}

/** Module (file) node ids to highlight: the root's module + each affected callee's module. */
export function touchedModules(index: GraphIndex, rootId: string, calleeIds: string[]): string[] {
  const modules = new Set<string>();
  for (const id of [rootId, ...calleeIds]) {
    const moduleId = nearestModuleId(index, id);
    if (moduleId !== null) {
      modules.add(moduleId);
    }
  }
  return [...modules].sort();
}

/** Walk parentId up to the nearest `module` ancestor (visited-guarded against a parentId cycle). */
function nearestModuleId(index: GraphIndex, nodeId: string): string | null {
  const visited = new Set<string>();
  let current = index.nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === MODULE_KIND) {
      return current.id;
    }
    current = current.parentId ? index.nodesById.get(current.parentId) : undefined;
  }
  return null;
}

/** Total steps (any kind, recursively) and how many of them are branches. */
export function countSteps(steps: FlowStep[]): { stepCount: number; branchCount: number } {
  let stepCount = 0;
  let branchCount = 0;
  const walk = (list: FlowStep[]): void => {
    for (const step of list) {
      stepCount += 1;
      if (step.kind === "branch") {
        branchCount += 1;
        step.paths.forEach((path) => walk(path.body));
      } else if (step.kind === "loop" || step.kind === "callback") {
        walk(step.body);
      }
    }
  };
  walk(steps);
  return { stepCount, branchCount };
}
