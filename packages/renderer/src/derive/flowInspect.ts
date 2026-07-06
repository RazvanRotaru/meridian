/**
 * Logic-flow inspection: pure derivations that answer "what does this callable reach, and where
 * does that reach show up across the charted flows?" — the data behind the Logic-flow inspector.
 *
 * All functions are pure (no React, no store) and tolerant of odd input (missing nodes, empty
 * flows) — they return empty rather than throw, because the lenient viewer must render partial or
 * malformed artifacts without blowing up.
 */

import type { FlowStep, GraphEdge, LogicFlows, NodeId } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";

/** A distinct callee of a node: what one hop of the call graph reaches, ready to render as a chip. */
export interface Callee {
  id: string;
  resolution: GraphEdge["resolution"];
  kind: string;
  label: string;
}

const EXTERNAL_PREFIXES = ["ext:", "unresolved:"] as const;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Distinct callees of a node, from its call-graph out-edges. Deduped by target id (the graph can
 * fold several call sites into one edge, but repeats still happen across kinds), first edge wins.
 * Resolved targets take their label/kind from the node they point at; boundary pseudo-targets
 * (`ext:` / `unresolved:`) keep their pseudo-id, wear a stripped readable label, and read as kind
 * "external" since there is no real node behind them.
 */
export function calleesOf(index: GraphIndex, nodeId: string): Callee[] {
  const callees: Callee[] = [];
  const seen = new Set<string>();
  for (const edge of index.outEdges.get(nodeId) ?? []) {
    if (seen.has(edge.target)) {
      continue;
    }
    seen.add(edge.target);
    callees.push(calleeFor(index, edge));
  }
  return callees;
}

/**
 * Every resolved call TARGET id reachable anywhere in a flow, recursing into loop bodies and every
 * branch path. Only genuine call steps with a resolved, non-null target count — a loop/branch is
 * structure, and unresolved/external calls point at nothing we can navigate to.
 */
export function flowCallTargets(steps: FlowStep[]): Set<string> {
  const targets = new Set<string>();
  collectCallTargets(steps, targets);
  return targets;
}

/**
 * The "ghost" callees of a node: everything a change to it also reaches that ISN'T already drawn in
 * the current flow. Defined as calleesOf(node) minus the in-flow targets, because those are exactly
 * the reachable-but-hidden hops worth surfacing. Resolved callees sort first (they're navigable;
 * the boundary ones are dead ends), stably preserving edge order within each group.
 */
export function ghostCallees(
  index: GraphIndex,
  nodeId: string,
  inFlowTargets: ReadonlySet<string>,
): Callee[] {
  const ghosts = calleesOf(index, nodeId).filter((callee) => !inFlowTargets.has(callee.id));
  return ghosts.sort((a, b) => resolvedRank(a) - resolvedRank(b));
}

/**
 * Reverse index over ALL logic flows: for each resolved call target, the flow-root ids whose flow
 * contains a call to it. Built once per artifact (the store/UI memoizes it) so "which flows touch
 * this callable?" is an O(1) lookup. Root lists are sorted lexicographically for stable display.
 */
export function buildFlowContainmentIndex(flows: LogicFlows): Map<string, string[]> {
  const containment = new Map<string, string[]>();
  for (const rootId of Object.keys(flows)) {
    for (const target of flowCallTargets(flows[rootId])) {
      appendRoot(containment, target, rootId);
    }
  }
  for (const roots of containment.values()) {
    roots.sort();
  }
  return containment;
}

/**
 * Transitive callers of a target, keyed by the MIN number of hops (1..maxDepth) to reach it — a
 * backward BFS over the containment map read as a REVERSE call graph (target → its direct callers).
 * Callables are both flow-roots AND call-targets, so `containment.get(caller)` yields the caller's
 * OWN callers; walking that chain surfaces indirect callers: for A→B→C, target C sees B at depth 1
 * and A at depth 2. BFS visits nearer callers first, so first-seen wins == each caller's minimum
 * hop count. A `visited` set seeded with the target guards cycles AND excludes the target itself.
 *
 * `transparent` callers are a PASSTHROUGH: not emitted and costing NO hop — reaching one absorbs it
 * at the current depth and expands its OWN callers at that same depth. This exists so the charted
 * flow you're already inside is a FREE hop: a call site's direct external caller IS the flow's root,
 * and counting the root you're already viewing would strand that true caller one level too deep.
 */
export function transitiveCallers(
  containment: Map<string, string[]>,
  targetId: string,
  maxDepth: number,
  transparent: ReadonlySet<string> = EMPTY,
): Map<string, number> {
  const callers = new Map<string, number>();
  const visited = new Set<string>([targetId]);
  let frontier = [targetId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    // A within-depth queue so a TRANSPARENT caller (the flow you're already inside) is absorbed at
    // THIS depth: it isn't emitted and costs no hop — its own callers are enqueued at the same depth.
    const queue: string[] = frontier.flatMap((node) => containment.get(node) ?? []);
    while (queue.length > 0) {
      const caller = queue.shift() as string;
      if (visited.has(caller)) continue;
      visited.add(caller);
      if (transparent.has(caller)) {
        for (const up of containment.get(caller) ?? []) queue.push(up);
        continue;
      }
      callers.set(caller, depth);
      next.push(caller);
    }
    frontier = next;
  }
  return callers;
}

function calleeFor(index: GraphIndex, edge: GraphEdge): Callee {
  if (isExternalId(edge.target)) {
    return { id: edge.target, resolution: edge.resolution, kind: "external", label: stripPrefix(edge.target) };
  }
  const node = index.nodesById.get(edge.target);
  return {
    id: edge.target,
    resolution: edge.resolution,
    kind: node?.kind ?? edge.kind,
    label: node?.displayName ?? edge.target,
  };
}

/** Shared recursive walker: descends loop bodies and branch paths, gathering resolved call targets. */
function collectCallTargets(steps: FlowStep[], targets: Set<string>): void {
  for (const step of steps) {
    if (step.kind === "call") {
      if (step.resolution === "resolved" && step.target !== null) {
        targets.add(step.target);
      }
    } else if (step.kind === "loop" || step.kind === "callback") {
      collectCallTargets(step.body, targets);
    } else {
      for (const path of step.paths) {
        collectCallTargets(path.body, targets);
      }
    }
  }
}

/** 0 for resolved (sort first), 1 otherwise — a stable-sort key that floats navigable callees up. */
function resolvedRank(callee: Callee): number {
  return callee.resolution === "resolved" ? 0 : 1;
}

function appendRoot(containment: Map<string, string[]>, target: string, rootId: NodeId): void {
  const roots = containment.get(target);
  if (roots) {
    roots.push(rootId);
    return;
  }
  containment.set(target, [rootId]);
}

function isExternalId(id: string): boolean {
  return EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function stripPrefix(id: string): string {
  for (const prefix of EXTERNAL_PREFIXES) {
    if (id.startsWith(prefix)) {
      return id.slice(prefix.length);
    }
  }
  return id;
}
