import type { FlowSelectionRef } from "../../derive/flowBlocks";
import type { FlowTreeEntry } from "../../derive/flowTree";
import { selectionKey } from "./flowSelection";

export function entryOpenKeysForSelection(entries: readonly FlowTreeEntry[], selection: FlowSelectionRef | null): string[] {
  if (selection === null) {
    return [];
  }
  const key = findFlowEntryId(entries, selection.rootId);
  return key ? [key] : [];
}

export function blockOpenKeysForSelection(selection: FlowSelectionRef | null): string[] {
  if (selection === null) {
    return [];
  }
  const keys: string[] = [];
  for (let depth = 1; depth <= selection.blockPath.length; depth += 1) {
    keys.push(selectionKey({ rootId: selection.rootId, blockPath: selection.blockPath.slice(0, depth) }));
  }
  return keys;
}

export function withOpenKeys(current: Set<string>, keys: readonly string[]): Set<string> {
  let next: Set<string> | null = null;
  for (const key of keys) {
    if (current.has(key)) {
      continue;
    }
    next ??= new Set(current);
    next.add(key);
  }
  return next ?? current;
}

function findFlowEntryId(entries: readonly FlowTreeEntry[], rootId: string): string | null {
  for (const entry of entries) {
    if (entry.flowRootId === rootId) {
      return entry.id;
    }
    const child = findFlowEntryId(entry.children, rootId);
    if (child) {
      return child;
    }
  }
  return null;
}
