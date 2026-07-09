import type { GraphNode } from "@meridian/core";
import type { PrChangedFile } from "../state/prTypes";

export interface PrFileMatch {
  path: string;
  status: PrChangedFile["status"];
  moduleId: string;
  moduleFile: string;
}

export function matchPrFilesToModules(
  files: readonly PrChangedFile[],
  nodes: Iterable<GraphNode>,
): PrFileMatch[] {
  const modules = [...nodes].filter((node) => node.kind === "module");
  return files.flatMap((file) => {
    const match = exactModule(file.path, modules) ?? suffixModule(file.path, modules);
    return match ? [{ path: file.path, status: file.status, moduleId: match.id, moduleFile: match.location.file }] : [];
  });
}

function exactModule(path: string, modules: readonly GraphNode[]): GraphNode | null {
  const normalized = normalizePath(path);
  return modules.find((node) => normalizePath(node.location.file) === normalized) ?? null;
}

function suffixModule(path: string, modules: readonly GraphNode[]): GraphNode | null {
  const normalized = normalizePath(path);
  let best: GraphNode | null = null;
  for (const node of modules) {
    const file = normalizePath(node.location.file);
    if (!isBoundarySuffix(normalized, file)) {
      continue;
    }
    if (!best || file.length > normalizePath(best.location.file).length) {
      best = node;
    }
  }
  return best;
}

function isBoundarySuffix(path: string, suffix: string): boolean {
  return path.length > suffix.length && path.endsWith(`/${suffix}`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}
