import type { FlowTreeEntry } from "../../derive/flowTree";

export function filterFlowTree(entries: readonly FlowTreeEntry[], query: string): FlowTreeEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries as FlowTreeEntry[];
  }
  return entries.flatMap((entry) => filterEntry(entry, needle));
}

function filterEntry(entry: FlowTreeEntry, needle: string): FlowTreeEntry[] {
  const children = entry.children.flatMap((child) => filterEntry(child, needle));
  if (entry.label.toLowerCase().includes(needle) || children.length > 0) {
    return [{ ...entry, children }];
  }
  return [];
}
