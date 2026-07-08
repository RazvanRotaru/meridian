import type { GraphNode, LogicFlows } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

export interface FlowTreeEntry {
  id: string;
  kind: "container" | "module" | "class" | "callable";
  label: string;
  flowRootId: string | null;
  children: FlowTreeEntry[];
}

export function buildFlowTree(index: GraphIndex, flows: LogicFlows): FlowTreeEntry[] {
  const roots: FlowTreeEntry[] = [];
  const byId = new Map<string, FlowTreeEntry>();
  for (const rootId of Object.keys(flows)) {
    addFlowRoot(rootId, roots, byId, index, flows);
  }
  sortEntries(roots, null, index);
  return roots.map(collapseContainerChain);
}

function addFlowRoot(
  rootId: string,
  roots: FlowTreeEntry[],
  byId: Map<string, FlowTreeEntry>,
  index: GraphIndex,
  flows: LogicFlows,
): void {
  let siblings = roots;
  for (const node of index.ancestorsOf(rootId)) {
    const entry = getOrCreateEntry(node, byId, siblings, flows);
    siblings = entry.children;
  }
}

function getOrCreateEntry(
  node: GraphNode,
  byId: Map<string, FlowTreeEntry>,
  siblings: FlowTreeEntry[],
  flows: LogicFlows,
): FlowTreeEntry {
  const existing = byId.get(node.id);
  if (existing) {
    existing.flowRootId ??= flowRootFor(node, flows);
    return existing;
  }
  const entry: FlowTreeEntry = {
    id: node.id,
    kind: entryKind(node),
    label: node.displayName,
    flowRootId: flowRootFor(node, flows),
    children: [],
  };
  byId.set(node.id, entry);
  siblings.push(entry);
  return entry;
}

function flowRootFor(node: GraphNode, flows: LogicFlows): string | null {
  if (!Object.prototype.hasOwnProperty.call(flows, node.id)) {
    return null;
  }
  return node.kind === "package" ? null : node.id;
}

function entryKind(node: GraphNode): FlowTreeEntry["kind"] {
  if (node.kind === "package") {
    return "container";
  }
  if (node.kind === "module") {
    return "module";
  }
  if (node.kind === "class" || node.kind === "object" || node.kind === "interface") {
    return "class";
  }
  return isCallable(node) ? "callable" : "class";
}

function isCallable(node: GraphNode): boolean {
  return node.kind === "function" || node.kind === "method" || node.kind === "constructor";
}

function sortEntries(entries: FlowTreeEntry[], parentId: string | null, index: GraphIndex): void {
  const sourceOrder = orderBySource(parentId, index);
  entries.sort((a, b) => compareEntries(a, b, sourceOrder));
  entries.forEach((entry) => sortEntries(entry.children, entry.id, index));
}

function orderBySource(parentId: string | null, index: GraphIndex): Map<string, number> {
  const nodes = parentId === null ? index.roots : index.childrenOf(parentId);
  return new Map(nodes.map((node, order) => [node.id, order]));
}

function compareEntries(a: FlowTreeEntry, b: FlowTreeEntry, sourceOrder: ReadonlyMap<string, number>): number {
  const aOrder = sourceOrder.get(a.id);
  const bOrder = sourceOrder.get(b.id);
  if (aOrder !== undefined && bOrder !== undefined) {
    return aOrder - bOrder;
  }
  if (aOrder !== undefined) {
    return -1;
  }
  if (bOrder !== undefined) {
    return 1;
  }
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

function collapseContainerChain(entry: FlowTreeEntry): FlowTreeEntry {
  const children = entry.children.map(collapseContainerChain);
  if (entry.kind !== "container" || entry.flowRootId !== null) {
    return { ...entry, children };
  }
  let current: FlowTreeEntry = { ...entry, children };
  const labels = [current.label];
  while (isCollapsibleContainer(current.children[0]) && current.children.length === 1) {
    current = current.children[0];
    labels.push(current.label);
  }
  return current === entry ? current : { ...current, label: labels.join("/") };
}

function isCollapsibleContainer(entry: FlowTreeEntry | undefined): entry is FlowTreeEntry {
  return entry?.kind === "container" && entry.flowRootId === null;
}
