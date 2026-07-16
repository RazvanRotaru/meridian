/**
 * Static test coverage, derived purely from the graph the extractors already emit.
 *
 * A callable is "covered" when a test node calls it directly, "indirect" when it is only
 * reachable from tests through other production code, and "uncovered" otherwise — with a
 * REASON (never called at all vs. only called by code that is itself uncovered). Containers
 * (classes/modules/packages) roll their callables up into a percentage. Only `resolved`
 * execution edges count: honest resolution means unresolved calls from tests are surfaced as
 * a summary caveat, never silently treated as coverage.
 */

import type { GraphEdge, GraphNode, NodeId } from "./types";
import { collectTestIds } from "./test-detection";

export type LeafCoverageStatus = "covered" | "indirect" | "uncovered";

export interface UncoveredReason {
  kind: "never-called" | "only-uncovered-callers";
  /** Direct production callers (all themselves uncovered); empty for never-called. */
  callers: NodeId[];
}

export interface LeafCoverage {
  status: LeafCoverageStatus;
  /** Hops from the nearest test callable; 1 == called directly by a test. */
  distance: number | null;
  /** Test nodes that call this callable directly (capped at CALLER_CAP). */
  directTestCallers: NodeId[];
  reason?: UncoveredReason;
}

export interface ContainerCoverage {
  covered: number;
  total: number;
  percent: number;
  status: "covered" | "partial" | "uncovered" | "no-callables";
}

export interface CoverageSummary {
  callables: number;
  covered: number;
  indirect: number;
  uncovered: number;
  percent: number;
  testNodes: number;
  /** Unresolved call edges leaving test code — real coverage may exceed the static estimate. */
  unresolvedFromTests: number;
}

export interface CoverageReport {
  /** Every non-test callable (function/method-ranked node). */
  leaves: Record<NodeId, LeafCoverage>;
  /** Every non-test container that has descendant callables (or none: "no-callables"). */
  containers: Record<NodeId, ContainerCoverage>;
  summary: CoverageSummary;
  testIds: Set<NodeId>;
}

/** Edge kinds that model execution reaching the target (a rendered component runs, too). */
const EXECUTION_EDGE_KINDS: ReadonlySet<string> = new Set(["calls", "instantiates", "renders"]);
const CALLER_CAP = 8;

export function computeCoverage(nodes: GraphNode[], edges: GraphEdge[]): CoverageReport {
  const testIds = collectTestIds(nodes);
  const callables = nodes.filter((node) => isCallableKind(node.kind) && !testIds.has(node.id));
  const execution = expandInstantiations(edges.filter(isResolvedExecution), nodes);
  const leaves = labelLeaves(callables, execution, testIds);
  return {
    leaves,
    containers: rollUpContainers(nodes, leaves, testIds),
    summary: summarize(leaves, edges, testIds),
    testIds,
  };
}

function isCallableKind(kind: string): boolean {
  return kind === "function" || kind === "method";
}

const CONSTRUCTOR_NAMES = new Set(["constructor", "__init__"]);

/** `new X()` executes X's constructor, so an instantiates edge to a class also reaches its ctor. */
function expandInstantiations(execution: GraphEdge[], nodes: GraphNode[]): GraphEdge[] {
  const ctorsByClass = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId && CONSTRUCTOR_NAMES.has(node.displayName)) {
      const ctors = ctorsByClass.get(node.parentId) ?? [];
      ctors.push(node.id);
      ctorsByClass.set(node.parentId, ctors);
    }
  }
  const expanded = [...execution];
  for (const edge of execution) {
    if (edge.kind !== "instantiates") {
      continue;
    }
    for (const ctorId of ctorsByClass.get(edge.target) ?? []) {
      expanded.push({ ...edge, target: ctorId });
    }
  }
  return expanded;
}

function isResolvedExecution(edge: GraphEdge): boolean {
  return EXECUTION_EDGE_KINDS.has(edge.kind) && (edge.resolution ?? "resolved") === "resolved";
}

/** Multi-source BFS out of test code: distance 1 == direct, 2+ == indirect, unreached == uncovered. */
function labelLeaves(
  callables: GraphNode[],
  execution: GraphEdge[],
  testIds: ReadonlySet<string>,
): Record<NodeId, LeafCoverage> {
  const outgoing = groupBySource(execution);
  const distance = new Map<string, number>();
  const directTestCallers = new Map<string, NodeId[]>();
  let frontier = seedFromTests(execution, testIds, distance, directTestCallers);
  while (frontier.length > 0) {
    frontier = advance(frontier, outgoing, testIds, distance);
  }
  const result: Record<NodeId, LeafCoverage> = {};
  for (const callable of callables) {
    result[callable.id] = leafCoverageOf(callable.id, distance, directTestCallers, execution, testIds);
  }
  return result;
}

function seedFromTests(
  execution: GraphEdge[],
  testIds: ReadonlySet<string>,
  distance: Map<string, number>,
  directTestCallers: Map<string, NodeId[]>,
): string[] {
  const seeds: string[] = [];
  for (const edge of execution) {
    if (!testIds.has(edge.source) || testIds.has(edge.target)) {
      continue;
    }
    const callers = directTestCallers.get(edge.target) ?? [];
    if (callers.length < CALLER_CAP && !callers.includes(edge.source)) {
      callers.push(edge.source);
    }
    directTestCallers.set(edge.target, callers);
    if (!distance.has(edge.target)) {
      distance.set(edge.target, 1);
      seeds.push(edge.target);
    }
  }
  return seeds;
}

function advance(
  frontier: string[],
  outgoing: ReadonlyMap<string, GraphEdge[]>,
  testIds: ReadonlySet<string>,
  distance: Map<string, number>,
): string[] {
  const next: string[] = [];
  for (const id of frontier) {
    for (const edge of outgoing.get(id) ?? []) {
      if (testIds.has(edge.target) || distance.has(edge.target)) {
        continue;
      }
      distance.set(edge.target, (distance.get(id) ?? 0) + 1);
      next.push(edge.target);
    }
  }
  return next;
}

function leafCoverageOf(
  id: string,
  distance: ReadonlyMap<string, number>,
  directTestCallers: ReadonlyMap<string, NodeId[]>,
  execution: GraphEdge[],
  testIds: ReadonlySet<string>,
): LeafCoverage {
  const hops = distance.get(id);
  if (hops === 1) {
    return { status: "covered", distance: 1, directTestCallers: directTestCallers.get(id) ?? [] };
  }
  if (hops !== undefined) {
    return { status: "indirect", distance: hops, directTestCallers: [] };
  }
  return { status: "uncovered", distance: null, directTestCallers: [], reason: uncoveredReason(id, execution, testIds) };
}

/** An unreached callable is either dead/entry-point code or a victim of its callers' gap. */
function uncoveredReason(id: string, execution: GraphEdge[], testIds: ReadonlySet<string>): UncoveredReason {
  const callers: NodeId[] = [];
  for (const edge of execution) {
    if (edge.target === id && !testIds.has(edge.source) && !callers.includes(edge.source)) {
      callers.push(edge.source);
      if (callers.length === CALLER_CAP) break;
    }
  }
  return callers.length === 0 ? { kind: "never-called", callers: [] } : { kind: "only-uncovered-callers", callers };
}

function rollUpContainers(
  nodes: GraphNode[],
  leaves: Record<NodeId, LeafCoverage>,
  testIds: ReadonlySet<string>,
): Record<NodeId, ContainerCoverage> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  const hasChildren = new Set(nodes.map((node) => node.parentId).filter((id): id is string => !!id));
  const tally = new Map<string, { covered: number; total: number }>();
  for (const [leafId, coverage] of Object.entries(leaves)) {
    addToAncestors(leafId, coverage.status !== "uncovered", parentOf, tally);
  }
  const result: Record<NodeId, ContainerCoverage> = {};
  for (const node of nodes) {
    if (!hasChildren.has(node.id) || testIds.has(node.id)) {
      continue;
    }
    result[node.id] = finalizeContainer(tally.get(node.id));
  }
  return result;
}

function addToAncestors(
  leafId: string,
  covered: boolean,
  parentOf: ReadonlyMap<string, string | null>,
  tally: Map<string, { covered: number; total: number }>,
): void {
  const seen = new Set<string>();
  let current = parentOf.get(leafId) ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const entry = tally.get(current) ?? { covered: 0, total: 0 };
    entry.total += 1;
    if (covered) entry.covered += 1;
    tally.set(current, entry);
    current = parentOf.get(current) ?? null;
  }
}

function finalizeContainer(entry: { covered: number; total: number } | undefined): ContainerCoverage {
  if (!entry || entry.total === 0) {
    return { covered: 0, total: 0, percent: 0, status: "no-callables" };
  }
  const percent = Math.round((entry.covered / entry.total) * 100);
  const status = entry.covered === 0 ? "uncovered" : entry.covered === entry.total ? "covered" : "partial";
  return { covered: entry.covered, total: entry.total, percent, status };
}

function summarize(
  leaves: Record<NodeId, LeafCoverage>,
  edges: GraphEdge[],
  testIds: ReadonlySet<string>,
): CoverageSummary {
  const statuses = Object.values(leaves);
  const covered = statuses.filter((leaf) => leaf.status === "covered").length;
  const indirect = statuses.filter((leaf) => leaf.status === "indirect").length;
  const callables = statuses.length;
  const unresolvedFromTests = edges.filter(
    (edge) => testIds.has(edge.source) && edge.resolution === "unresolved",
  ).length;
  return {
    callables,
    covered,
    indirect,
    uncovered: callables - covered - indirect,
    percent: callables === 0 ? 0 : Math.round(((covered + indirect) / callables) * 100),
    testNodes: testIds.size,
    unresolvedFromTests,
  };
}

function groupBySource(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const bySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const existing = bySource.get(edge.source);
    if (existing) {
      existing.push(edge);
    } else {
      bySource.set(edge.source, [edge]);
    }
  }
  return bySource;
}
