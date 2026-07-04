/**
 * Graph primitives behind the component-design metrics: which node belongs to which composition
 * unit, and the raw coupling/cohesion tallies read off the edge set. Pure — no React, no DOM.
 * Split from `composition.ts` so that file carries only Martin's metric formulas + ranking.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";

/** The composition units: a class/interface/object body, or a module treated as one. */
export const UNIT_KINDS: ReadonlySet<string> = new Set(["class", "interface", "object", "module"]);

/** The callable members a unit is measured over. */
export const MEMBER_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

/** Edge kinds that express a dependency between units (references/imports are ignored for v1). */
export const COUPLING_KINDS: ReadonlySet<string> = new Set(["calls", "instantiates", "extends", "implements"]);

const EXTERNAL_PREFIXES = ["ext:", "unresolved:"] as const;

export interface UnitIndex {
  nodesById: Map<string, GraphNode>;
  units: GraphNode[];
  /** The id of the unit a node belongs to (nearest self-or-ancestor unit), or null if none. */
  unitIdOf(nodeId: string): string | null;
}

export function buildUnitIndex(nodes: GraphNode[]): UnitIndex {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const units = nodes.filter((node) => UNIT_KINDS.has(node.kind));
  const cache = new Map<string, string | null>();
  return { nodesById, units, unitIdOf: (nodeId) => resolveUnitId(nodeId, nodesById, cache) };
}

/**
 * Walk parentId upward to the nearest node whose kind is a unit — a class/interface/object always
 * sits below its module, so it wins; a top-level callable resolves to the module. Memoized per id,
 * with a visited guard so a malformed parentId cycle can't loop forever.
 */
function resolveUnitId(startId: string, nodesById: Map<string, GraphNode>, cache: Map<string, string | null>): string | null {
  const cached = cache.get(startId);
  if (cached !== undefined) {
    return cached;
  }
  const visited = new Set<string>();
  let current = nodesById.get(startId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (UNIT_KINDS.has(current.kind)) {
      cache.set(startId, current.id);
      return current.id;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  cache.set(startId, null);
  return null;
}

/** A target is external when it is a boundary pseudo-id or simply absent from the node set. */
export function isExternalTarget(targetId: string, nodesById: Map<string, GraphNode>): boolean {
  if (EXTERNAL_PREFIXES.some((prefix) => targetId.startsWith(prefix))) {
    return true;
  }
  return !nodesById.has(targetId);
}

/** The callable members of each unit, keyed by unit id — a disjoint partition of all callables. */
export function groupMembersByUnit(nodes: GraphNode[], index: UnitIndex): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>(index.units.map((unit) => [unit.id, []]));
  for (const node of nodes) {
    if (!MEMBER_KINDS.has(node.kind)) {
      continue;
    }
    const unitId = index.unitIdOf(node.id);
    if (unitId !== null) {
      groups.get(unitId)?.push(node);
    }
  }
  return groups;
}

/** Distinct in/out unit couplings, external fan-out, and same-unit call pairs (for LCOM). */
export interface UnitCoupling {
  efferent: Set<string>;
  afferent: Set<string>;
  external: Set<string>;
  internalCalls: Array<[string, string]>;
}

export function accumulateCoupling(edges: GraphEdge[], index: UnitIndex): Map<string, UnitCoupling> {
  const coupling = new Map<string, UnitCoupling>(index.units.map((unit) => [unit.id, emptyCoupling()]));
  for (const edge of edges) {
    if (COUPLING_KINDS.has(edge.kind)) {
      applyCouplingEdge(edge, index, coupling);
    }
  }
  return coupling;
}

/** Attribute one coupling edge: external fan-out, an internal (same-unit) call, or a cross-unit link. */
function applyCouplingEdge(edge: GraphEdge, index: UnitIndex, coupling: Map<string, UnitCoupling>): void {
  const sourceUnit = index.unitIdOf(edge.source);
  const record = sourceUnit === null ? undefined : coupling.get(sourceUnit);
  if (!record || sourceUnit === null) {
    return;
  }
  if (isExternalTarget(edge.target, index.nodesById)) {
    record.external.add(edge.target);
    return;
  }
  const targetUnit = index.unitIdOf(edge.target);
  if (targetUnit === null) {
    return;
  }
  if (targetUnit === sourceUnit) {
    if (edge.kind === "calls") {
      record.internalCalls.push([edge.source, edge.target]);
    }
    return;
  }
  record.efferent.add(targetUnit);
  coupling.get(targetUnit)?.afferent.add(sourceUnit);
}

export function emptyCoupling(): UnitCoupling {
  return { efferent: new Set(), afferent: new Set(), external: new Set(), internalCalls: [] };
}

/** LCOM4: weakly-connected components among members linked by internal calls (singletons count). */
export function countComponents(memberIds: string[], callPairs: Array<[string, string]>): number {
  if (memberIds.length === 0) {
    return 0;
  }
  const parent = new Map(memberIds.map((id) => [id, id]));
  for (const [caller, callee] of callPairs) {
    if (parent.has(caller) && parent.has(callee)) {
      union(parent, caller, callee);
    }
  }
  return new Set(memberIds.map((id) => find(parent, id))).size;
}

function find(parent: Map<string, string>, id: string): string {
  let root = id;
  while (parent.get(root) !== root) {
    root = parent.get(root) as string;
  }
  return root;
}

function union(parent: Map<string, string>, a: string, b: string): void {
  parent.set(find(parent, a), find(parent, b));
}
