/**
 * Deterministic, size-bounded partitioning for service affinity graphs.
 *
 * This is a small client-side heuristic, not METIS. It borrows the useful shape of multilevel
 * partitioners — spread seeds, grow affinity-connected regions, then refine the boundary — while
 * optimizing the product metric directly: affinity weight (and, optionally, visible edge/bundle
 * counts) crossing between groups. A connectivity guard prevents a cheaper cut from needlessly
 * turning a connected group into islands.
 */

export interface ServiceAffinityEdge {
  a: string;
  b: string;
  weight: number;
}

export interface ServicePartitionObjectiveWeights {
  /** Sum of affinity weights crossing between groups. This is the primary objective by default. */
  cutWeight: number;
  /** Number of individual affinity edges crossing between groups. */
  cutEdgeCount: number;
  /** Number of connected group pairs in the quotient graph (visible inter-group bundles). */
  quotientEdgeCount: number;
}

export interface BalancedServicePartitionOptions {
  /** Fraction around the target used for default size bounds. Defaults to 0.25. */
  imbalanceTolerance?: number;
  /** A hard preference unless it conflicts with the maximum bound or the graph is smaller. */
  minimumGroupSize?: number;
  /** Maximum group size. Defaults to target * (1 + tolerance). */
  maximumGroupSize?: number;
  objective?: Partial<ServicePartitionObjectiveWeights>;
  /** Connectivity is compared before the scalar cut objective. Defaults to true. */
  preserveConnectedness?: boolean;
  /** Deterministic local move/swap sweeps. Defaults to 8. */
  refinementPasses?: number;
}

export interface ServicePartitionMetrics {
  cutWeight: number;
  cutEdgeCount: number;
  quotientEdgeCount: number;
  connectedGroupCount: number;
  disconnectedGroupCount: number;
  /** Sum of (connected components - 1) across groups. Zero means every group is connected. */
  extraConnectedComponents: number;
}

export interface BalancedServicePartitionResult {
  /** Complete, disjoint groups. Members and groups are in deterministic id order. */
  groups: string[][];
  metrics: ServicePartitionMetrics;
  objectiveScore: number;
  targetGroupSize: number;
  groupCount: number;
  /** Effective bounds. The minimum can be relaxed when the requested interval is infeasible. */
  bounds: { minimum: number; maximum: number };
}

interface NormalizedEdge extends ServiceAffinityEdge {
  key: string;
}

interface NormalizedGraph {
  nodes: string[];
  edges: NormalizedEdge[];
  adjacency: Map<string, NormalizedEdge[]>;
  weightedDegree: Map<string, number>;
}

interface SizePlan {
  capacities: number[];
  minimum: number;
  maximum: number;
}

interface WorkingState {
  groups: Set<string>[];
  assignment: Map<string, number>;
  pairEdgeCounts: Map<string, number>;
  componentCounts: number[];
  metrics: ServicePartitionMetrics;
  score: number;
}

interface CandidateEvaluation {
  changes: Map<string, number>;
  key: string;
  cutWeight: number;
  cutEdgeCount: number;
  quotientEdgeCount: number;
  extraConnectedComponents: number;
  score: number;
}

const DEFAULT_OBJECTIVE: ServicePartitionObjectiveWeights = {
  cutWeight: 1,
  cutEdgeCount: 0,
  quotientEdgeCount: 0,
};
const EPSILON = 1e-9;
const SWAP_CANDIDATES_PER_SIDE = 4;

/**
 * Partition service lead ids into deterministic, approximately target-sized groups.
 *
 * The result is heuristic because balanced graph partitioning is NP-hard. Unlike modularity
 * clustering, however, every accepted refinement is measured against the requested cross-group
 * cut objective itself.
 */
export function partitionServiceGraph(
  leadIds: readonly string[],
  affinityEdges: readonly ServiceAffinityEdge[],
  targetGroupSize: number,
  options: BalancedServicePartitionOptions = {},
): BalancedServicePartitionResult {
  const target = positiveInteger(targetGroupSize, "targetGroupSize");
  const graph = normalizeGraph(leadIds, affinityEdges);
  const objective = objectiveWeights(options.objective);
  if (graph.nodes.length === 0) {
    return {
      groups: [],
      metrics: emptyMetrics(),
      objectiveScore: 0,
      targetGroupSize: target,
      groupCount: 0,
      bounds: { minimum: 0, maximum: 0 },
    };
  }

  const sizePlan = planGroupSizes(graph.nodes.length, target, options);
  const initialGroups = growInitialPartition(graph, sizePlan.capacities);
  const refined = refinePartition(
    graph,
    initialGroups,
    sizePlan,
    objective,
    options.preserveConnectedness !== false,
    options.refinementPasses === undefined
      ? 8
      : nonNegativeInteger(options.refinementPasses, "refinementPasses"),
  );
  const groups = canonicalGroups(refined.groups.map((group) => [...group]));
  const metrics = measureServicePartition(groups, graph.edges);
  return {
    groups,
    metrics,
    objectiveScore: servicePartitionObjectiveScore(metrics, objective),
    targetGroupSize: target,
    groupCount: groups.length,
    bounds: { minimum: sizePlan.minimum, maximum: sizePlan.maximum },
  };
}

/** Measure the visible cut and within-group connectivity of any proposed partition. */
export function measureServicePartition(
  groups: readonly (readonly string[])[],
  affinityEdges: readonly ServiceAffinityEdge[],
): ServicePartitionMetrics {
  const assignment = new Map<string, number>();
  const normalizedGroups: string[][] = [];
  for (const inputGroup of groups) {
    const group = [...new Set(inputGroup)].sort(compareId);
    if (group.length === 0) {
      continue;
    }
    const groupIndex = normalizedGroups.length;
    for (const id of group) {
      if (assignment.has(id)) {
        throw new Error(`Service ${id} appears in more than one partition group`);
      }
      assignment.set(id, groupIndex);
    }
    normalizedGroups.push(group);
  }
  const graph = normalizeGraph([...assignment.keys()], affinityEdges);
  const pairEdgeCounts = new Map<string, number>();
  let cutWeight = 0;
  let cutEdgeCount = 0;
  for (const edge of graph.edges) {
    const a = assignment.get(edge.a);
    const b = assignment.get(edge.b);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    cutWeight += edge.weight;
    cutEdgeCount += 1;
    incrementPairCount(pairEdgeCounts, groupPairKey(a, b), 1);
  }
  const componentCounts = normalizedGroups.map((group) => connectedComponentCount(
    new Set(group),
    graph.adjacency,
  ));
  return metricsFrom(cutWeight, cutEdgeCount, pairEdgeCounts.size, componentCounts);
}

/** Scalar portion of the objective. Connectedness is an optional lexicographic guard, not a term. */
export function servicePartitionObjectiveScore(
  metrics: Pick<ServicePartitionMetrics, "cutWeight" | "cutEdgeCount" | "quotientEdgeCount">,
  inputWeights: Partial<ServicePartitionObjectiveWeights> = {},
): number {
  const weights = objectiveWeights(inputWeights);
  return weights.cutWeight * metrics.cutWeight
    + weights.cutEdgeCount * metrics.cutEdgeCount
    + weights.quotientEdgeCount * metrics.quotientEdgeCount;
}

function planGroupSizes(
  nodeCount: number,
  target: number,
  options: BalancedServicePartitionOptions,
): SizePlan {
  const tolerance = options.imbalanceTolerance ?? 0.25;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("imbalanceTolerance must be a finite non-negative number");
  }
  const defaultMinimum = target === 1
    ? 1
    : Math.max(2, Math.floor(target * Math.max(0, 1 - tolerance)));
  const requestedMinimum = options.minimumGroupSize === undefined
    ? defaultMinimum
    : positiveInteger(options.minimumGroupSize, "minimumGroupSize");
  const requestedMaximum = options.maximumGroupSize === undefined
    ? Math.max(target, Math.ceil(target * (1 + tolerance)))
    : positiveInteger(options.maximumGroupSize, "maximumGroupSize");
  if (requestedMaximum < requestedMinimum) {
    throw new RangeError("maximumGroupSize must be at least minimumGroupSize");
  }

  const desiredCount = Math.max(1, Math.round(nodeCount / target));
  const minimumCount = Math.max(1, Math.ceil(nodeCount / requestedMaximum));
  const maximumCount = Math.max(1, Math.floor(nodeCount / requestedMinimum));
  // When no count satisfies both bounds, preserve the maximum and relax only the minimum. That
  // avoids one oversized catch-all while still choosing the largest feasible non-trivial groups.
  const groupCount = minimumCount <= maximumCount
    ? clamp(desiredCount, minimumCount, maximumCount)
    : minimumCount;
  const smaller = Math.floor(nodeCount / groupCount);
  const larger = Math.ceil(nodeCount / groupCount);
  const largeGroupCount = nodeCount % groupCount;
  return {
    capacities: Array.from(
      { length: groupCount },
      (_, index) => index < largeGroupCount ? larger : smaller,
    ),
    minimum: Math.min(requestedMinimum, smaller),
    maximum: Math.max(requestedMaximum, larger),
  };
}

function growInitialPartition(graph: NormalizedGraph, capacities: readonly number[]): Set<string>[] {
  const seeds = spreadSeeds(graph, capacities.length);
  const groups = seeds.map((seed) => new Set([seed]));
  const assignment = new Map(seeds.map((seed, index) => [seed, index]));
  const unassigned = new Set(graph.nodes.filter((id) => !assignment.has(id)));

  while (unassigned.size > 0) {
    let best: { node: string; group: number; attraction: number } | undefined;
    for (const node of unassigned) {
      const attraction = affinityByAssignedGroup(node, graph.adjacency, assignment);
      for (let group = 0; group < groups.length; group += 1) {
        if (groups[group].size >= capacities[group]) {
          continue;
        }
        const candidate = { node, group, attraction: attraction.get(group) ?? 0 };
        if (candidate.attraction > EPSILON && (!best || compareGrowthCandidate(
          candidate,
          best,
          groups,
          capacities,
          graph.weightedDegree,
        ) < 0)) {
          best = candidate;
        }
      }
    }
    if (!best) {
      const group = groups
        .map((members, index) => ({ index, remaining: capacities[index] - members.size }))
        .filter(({ remaining }) => remaining > 0)
        .sort((a, b) => b.remaining - a.remaining
          || compareId(seeds[a.index], seeds[b.index]))[0].index;
      const node = [...unassigned].sort((a, b) => {
        const unassignedA = affinityToSet(a, unassigned, graph.adjacency);
        const unassignedB = affinityToSet(b, unassigned, graph.adjacency);
        return unassignedB - unassignedA
          || (graph.weightedDegree.get(b) ?? 0) - (graph.weightedDegree.get(a) ?? 0)
          || compareId(a, b);
      })[0];
      best = { node, group, attraction: 0 };
    }
    groups[best.group].add(best.node);
    assignment.set(best.node, best.group);
    unassigned.delete(best.node);
  }
  return groups;
}

function spreadSeeds(graph: NormalizedGraph, count: number): string[] {
  const seeds: string[] = [];
  const selected = new Set<string>();
  while (seeds.length < count) {
    const distances = hopDistances(graph, seeds);
    const candidate = graph.nodes
      .filter((id) => !selected.has(id))
      .sort((a, b) => compareSeedCandidate(a, b, distances, graph.weightedDegree))[0];
    seeds.push(candidate);
    selected.add(candidate);
  }
  return seeds;
}

function hopDistances(graph: NormalizedGraph, seeds: readonly string[]): Map<string, number> {
  const distance = new Map(graph.nodes.map((id) => [id, Number.POSITIVE_INFINITY]));
  const queue: string[] = [];
  for (const seed of seeds) {
    distance.set(seed, 0);
    queue.push(seed);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const nextDistance = (distance.get(current) ?? 0) + 1;
    for (const edge of graph.adjacency.get(current) ?? []) {
      const neighbour = otherEnd(edge, current);
      if (nextDistance < (distance.get(neighbour) ?? Number.POSITIVE_INFINITY)) {
        distance.set(neighbour, nextDistance);
        queue.push(neighbour);
      }
    }
  }
  return distance;
}

function compareSeedCandidate(
  a: string,
  b: string,
  distances: ReadonlyMap<string, number>,
  degree: ReadonlyMap<string, number>,
): number {
  const aDistance = distances.get(a) ?? Number.POSITIVE_INFINITY;
  const bDistance = distances.get(b) ?? Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) {
    return bDistance - aDistance;
  }
  return (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || compareId(a, b);
}

function compareGrowthCandidate(
  a: { node: string; group: number; attraction: number },
  b: { node: string; group: number; attraction: number },
  groups: readonly ReadonlySet<string>[],
  capacities: readonly number[],
  degree: ReadonlyMap<string, number>,
): number {
  const attraction = b.attraction - a.attraction;
  if (Math.abs(attraction) > EPSILON) {
    return attraction;
  }
  const aFill = groups[a.group].size / capacities[a.group];
  const bFill = groups[b.group].size / capacities[b.group];
  return aFill - bFill
    || (degree.get(b.node) ?? 0) - (degree.get(a.node) ?? 0)
    || compareId(a.node, b.node)
    || a.group - b.group;
}

function refinePartition(
  graph: NormalizedGraph,
  initialGroups: Set<string>[],
  sizePlan: SizePlan,
  objective: ServicePartitionObjectiveWeights,
  preserveConnectedness: boolean,
  passes: number,
): WorkingState {
  let state = buildWorkingState(graph, initialGroups, objective);
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    for (const node of graph.nodes) {
      const source = state.assignment.get(node)!;
      if (state.groups[source].size <= sizePlan.minimum) {
        continue;
      }
      let best: CandidateEvaluation | undefined;
      const targetGroups = objective.quotientEdgeCount > 0
        ? state.groups.map((_, index) => index)
        : neighbourGroups(node, graph.adjacency, state.assignment);
      for (const target of targetGroups) {
        if (target === source || state.groups[target].size >= sizePlan.maximum) {
          continue;
        }
        const candidate = evaluateCandidate(
          graph,
          state,
          new Map([[node, target]]),
          `move:${node}:${target}`,
          objective,
        );
        if (isImprovement(candidate, state, preserveConnectedness)
          && (!best || compareCandidates(candidate, best, preserveConnectedness) < 0)) {
          best = candidate;
        }
      }
      if (best) {
        state = applyCandidate(graph, state, best, objective);
        changed = true;
      }
    }

    for (let a = 0; a < state.groups.length; a += 1) {
      for (let b = a + 1; b < state.groups.length; b += 1) {
        let best: CandidateEvaluation | undefined;
        // Boundary-ranked candidates retain the useful KL-style exchanges without an O(V^2)
        // sweep for every group pair. Four candidates per side is ample for ~12-service groups
        // and keeps the 200+ service interaction synchronous and responsive.
        const aMembers = swapBoundaryCandidates(
          a,
          b,
          state,
          graph.adjacency,
          SWAP_CANDIDATES_PER_SIDE,
        );
        const bMembers = swapBoundaryCandidates(
          b,
          a,
          state,
          graph.adjacency,
          SWAP_CANDIDATES_PER_SIDE,
        );
        for (const left of aMembers) {
          for (const right of bMembers) {
            const candidate = evaluateCandidate(
              graph,
              state,
              new Map([[left, b], [right, a]]),
              `swap:${left}:${right}`,
              objective,
            );
            if (isImprovement(candidate, state, preserveConnectedness)
              && (!best || compareCandidates(candidate, best, preserveConnectedness) < 0)) {
              best = candidate;
            }
          }
        }
        if (best) {
          state = applyCandidate(graph, state, best, objective);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }
  return state;
}

function neighbourGroups(
  node: string,
  adjacency: ReadonlyMap<string, readonly NormalizedEdge[]>,
  assignment: ReadonlyMap<string, number>,
): number[] {
  const source = assignment.get(node);
  const groups = new Set<number>();
  for (const edge of adjacency.get(node) ?? []) {
    const group = assignment.get(otherEnd(edge, node));
    if (group !== undefined && group !== source) {
      groups.add(group);
    }
  }
  return [...groups].sort((a, b) => a - b);
}

function swapBoundaryCandidates(
  source: number,
  target: number,
  state: WorkingState,
  adjacency: ReadonlyMap<string, readonly NormalizedEdge[]>,
  limit: number,
): string[] {
  return [...state.groups[source]]
    .map((id) => {
      let sourceAffinity = 0;
      let targetAffinity = 0;
      for (const edge of adjacency.get(id) ?? []) {
        const neighbourGroup = state.assignment.get(otherEnd(edge, id));
        if (neighbourGroup === source) {
          sourceAffinity += edge.weight;
        } else if (neighbourGroup === target) {
          targetAffinity += edge.weight;
        }
      }
      return { id, gain: targetAffinity - sourceAffinity, targetAffinity };
    })
    .sort((a, b) => b.gain - a.gain
      || b.targetAffinity - a.targetAffinity
      || compareId(a.id, b.id))
    .slice(0, limit)
    .map(({ id }) => id);
}

function buildWorkingState(
  graph: NormalizedGraph,
  inputGroups: readonly ReadonlySet<string>[],
  objective: ServicePartitionObjectiveWeights,
): WorkingState {
  const groups = inputGroups.map((group) => new Set(group));
  const assignment = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group) {
      assignment.set(id, index);
    }
  });
  const pairEdgeCounts = new Map<string, number>();
  let cutWeight = 0;
  let cutEdgeCount = 0;
  for (const edge of graph.edges) {
    const a = assignment.get(edge.a)!;
    const b = assignment.get(edge.b)!;
    if (a !== b) {
      cutWeight += edge.weight;
      cutEdgeCount += 1;
      incrementPairCount(pairEdgeCounts, groupPairKey(a, b), 1);
    }
  }
  const componentCounts = groups.map((group) => connectedComponentCount(group, graph.adjacency));
  const metrics = metricsFrom(cutWeight, cutEdgeCount, pairEdgeCounts.size, componentCounts);
  return {
    groups,
    assignment,
    pairEdgeCounts,
    componentCounts,
    metrics,
    score: servicePartitionObjectiveScore(metrics, objective),
  };
}

function evaluateCandidate(
  graph: NormalizedGraph,
  state: WorkingState,
  changes: Map<string, number>,
  key: string,
  objective: ServicePartitionObjectiveWeights,
): CandidateEvaluation {
  const affectedEdges = new Map<string, NormalizedEdge>();
  const affectedGroups = new Set<number>();
  for (const [id, target] of changes) {
    affectedGroups.add(state.assignment.get(id)!);
    affectedGroups.add(target);
    for (const edge of graph.adjacency.get(id) ?? []) {
      affectedEdges.set(edge.key, edge);
    }
  }
  let cutWeight = state.metrics.cutWeight;
  let cutEdgeCount = state.metrics.cutEdgeCount;
  const pairEdgeCounts = new Map(state.pairEdgeCounts);
  for (const edge of affectedEdges.values()) {
    const oldA = state.assignment.get(edge.a)!;
    const oldB = state.assignment.get(edge.b)!;
    const newA = changes.get(edge.a) ?? oldA;
    const newB = changes.get(edge.b) ?? oldB;
    if (oldA !== oldB) {
      cutWeight -= edge.weight;
      cutEdgeCount -= 1;
      incrementPairCount(pairEdgeCounts, groupPairKey(oldA, oldB), -1);
    }
    if (newA !== newB) {
      cutWeight += edge.weight;
      cutEdgeCount += 1;
      incrementPairCount(pairEdgeCounts, groupPairKey(newA, newB), 1);
    }
  }

  let extraConnectedComponents = state.metrics.extraConnectedComponents;
  for (const groupIndex of affectedGroups) {
    extraConnectedComponents -= Math.max(0, state.componentCounts[groupIndex] - 1);
    const members = new Set(state.groups[groupIndex]);
    for (const [id, target] of changes) {
      const old = state.assignment.get(id)!;
      if (old === groupIndex && target !== groupIndex) {
        members.delete(id);
      } else if (old !== groupIndex && target === groupIndex) {
        members.add(id);
      }
    }
    extraConnectedComponents += Math.max(0, connectedComponentCount(members, graph.adjacency) - 1);
  }
  const metrics = { cutWeight, cutEdgeCount, quotientEdgeCount: pairEdgeCounts.size };
  return {
    changes,
    key,
    ...metrics,
    extraConnectedComponents,
    score: servicePartitionObjectiveScore(metrics, objective),
  };
}

function applyCandidate(
  graph: NormalizedGraph,
  state: WorkingState,
  candidate: CandidateEvaluation,
  objective: ServicePartitionObjectiveWeights,
): WorkingState {
  const groups = state.groups.map((group) => new Set(group));
  for (const [id, target] of candidate.changes) {
    groups[state.assignment.get(id)!].delete(id);
    groups[target].add(id);
  }
  return buildWorkingState(graph, groups, objective);
}

function isImprovement(
  candidate: CandidateEvaluation,
  state: WorkingState,
  preserveConnectedness: boolean,
): boolean {
  if (preserveConnectedness
    && candidate.extraConnectedComponents !== state.metrics.extraConnectedComponents) {
    return candidate.extraConnectedComponents < state.metrics.extraConnectedComponents;
  }
  return compareObjectiveTuple(candidate, {
    score: state.score,
    cutWeight: state.metrics.cutWeight,
    cutEdgeCount: state.metrics.cutEdgeCount,
    quotientEdgeCount: state.metrics.quotientEdgeCount,
  }) < 0;
}

function compareCandidates(
  a: CandidateEvaluation,
  b: CandidateEvaluation,
  preserveConnectedness: boolean,
): number {
  if (preserveConnectedness && a.extraConnectedComponents !== b.extraConnectedComponents) {
    return a.extraConnectedComponents - b.extraConnectedComponents;
  }
  return compareObjectiveTuple(a, b) || compareId(a.key, b.key);
}

function compareObjectiveTuple(
  a: { score: number; cutWeight: number; cutEdgeCount: number; quotientEdgeCount: number },
  b: { score: number; cutWeight: number; cutEdgeCount: number; quotientEdgeCount: number },
): number {
  return compareNumber(a.score, b.score)
    || compareNumber(a.cutWeight, b.cutWeight)
    || a.cutEdgeCount - b.cutEdgeCount
    || a.quotientEdgeCount - b.quotientEdgeCount;
}

function normalizeGraph(
  leadIds: readonly string[],
  affinityEdges: readonly ServiceAffinityEdge[],
): NormalizedGraph {
  const nodes = [...new Set(leadIds)].sort(compareId);
  const known = new Set(nodes);
  const byPair = new Map<string, NormalizedEdge>();
  for (const input of affinityEdges) {
    if (!known.has(input.a) || !known.has(input.b) || input.a === input.b
      || !Number.isFinite(input.weight) || input.weight <= 0) {
      continue;
    }
    const [a, b] = orderedPair(input.a, input.b);
    const key = edgeKey(a, b);
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += input.weight;
    } else {
      byPair.set(key, { a, b, weight: input.weight, key });
    }
  }
  const edges = [...byPair.values()].sort((a, b) => compareId(a.key, b.key));
  const adjacency = new Map(nodes.map((id) => [id, [] as NormalizedEdge[]]));
  const weightedDegree = new Map(nodes.map((id) => [id, 0]));
  for (const edge of edges) {
    adjacency.get(edge.a)!.push(edge);
    adjacency.get(edge.b)!.push(edge);
    weightedDegree.set(edge.a, (weightedDegree.get(edge.a) ?? 0) + edge.weight);
    weightedDegree.set(edge.b, (weightedDegree.get(edge.b) ?? 0) + edge.weight);
  }
  return { nodes, edges, adjacency, weightedDegree };
}

function connectedComponentCount(
  members: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, readonly NormalizedEdge[]>,
): number {
  if (members.size === 0) {
    return 0;
  }
  const remaining = new Set(members);
  let components = 0;
  while (remaining.size > 0) {
    components += 1;
    const start = [...remaining].sort(compareId)[0];
    const queue = [start];
    remaining.delete(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      for (const edge of adjacency.get(current) ?? []) {
        const neighbour = otherEnd(edge, current);
        if (remaining.delete(neighbour)) {
          queue.push(neighbour);
        }
      }
    }
  }
  return components;
}

function metricsFrom(
  cutWeight: number,
  cutEdgeCount: number,
  quotientEdgeCount: number,
  componentCounts: readonly number[],
): ServicePartitionMetrics {
  const disconnectedGroupCount = componentCounts.filter((count) => count > 1).length;
  return {
    cutWeight: normalizeZero(cutWeight),
    cutEdgeCount,
    quotientEdgeCount,
    connectedGroupCount: componentCounts.length - disconnectedGroupCount,
    disconnectedGroupCount,
    extraConnectedComponents: componentCounts.reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
  };
}

function objectiveWeights(
  input: Partial<ServicePartitionObjectiveWeights> = {},
): ServicePartitionObjectiveWeights {
  const result = { ...DEFAULT_OBJECTIVE, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} objective weight must be a finite non-negative number`);
    }
  }
  return result;
}

function affinityByAssignedGroup(
  node: string,
  adjacency: ReadonlyMap<string, readonly NormalizedEdge[]>,
  assignment: ReadonlyMap<string, number>,
): Map<number, number> {
  const result = new Map<number, number>();
  for (const edge of adjacency.get(node) ?? []) {
    const group = assignment.get(otherEnd(edge, node));
    if (group !== undefined) {
      result.set(group, (result.get(group) ?? 0) + edge.weight);
    }
  }
  return result;
}

function affinityToSet(
  node: string,
  members: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, readonly NormalizedEdge[]>,
): number {
  let total = 0;
  for (const edge of adjacency.get(node) ?? []) {
    if (members.has(otherEnd(edge, node))) {
      total += edge.weight;
    }
  }
  return total;
}

function canonicalGroups(groups: readonly (readonly string[])[]): string[][] {
  return groups
    .map((group) => [...group].sort(compareId))
    .filter((group) => group.length > 0)
    .sort((a, b) => compareId(a[0], b[0]));
}

function emptyMetrics(): ServicePartitionMetrics {
  return {
    cutWeight: 0,
    cutEdgeCount: 0,
    quotientEdgeCount: 0,
    connectedGroupCount: 0,
    disconnectedGroupCount: 0,
    extraConnectedComponents: 0,
  };
}

function incrementPairCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
}

function otherEnd(edge: ServiceAffinityEdge, id: string): string {
  return edge.a === id ? edge.b : edge.a;
}

function orderedPair(a: string, b: string): [string, string] {
  return compareId(a, b) <= 0 ? [a, b] : [b, a];
}

function edgeKey(a: string, b: string): string {
  return `${a.length}:${a}${b}`;
}

function groupPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`);
  }
  return Math.max(1, Math.round(value));
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return Math.round(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compareNumber(a: number, b: number): number {
  const delta = a - b;
  return Math.abs(delta) <= EPSILON ? 0 : delta;
}

function normalizeZero(value: number): number {
  return Math.abs(value) <= EPSILON ? 0 : value;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
