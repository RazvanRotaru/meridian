/**
 * Deterministic community partitioners used by Service-lens grouping modes.
 *
 * Leiden follows the three-phase CPM algorithm from Traag, Waltman & van Eck (2019): fast local
 * moving, constrained refinement, and aggregation over the refined partition while retaining the
 * non-refined partition. Random choices are driven by a stable seeded generator, so identical graph
 * inputs produce identical groups without removing the positive-temperature refinement step on
 * which Leiden's connectivity argument relies.
 *
 * Bunch MQ uses Mitchell & Mancoridis' weighted cluster-factor objective (also called TurboMQ in
 * the Bunch literature). The original Bunch tool offers several
 * stochastic search strategies; this module deliberately uses a deterministic greedy hill climb
 * (best target per visited node, plus community merges) over that exact objective. It is therefore an MQ
 * optimizer, not a port of the Bunch tool's search engine.
 */

export interface UndirectedCommunityEdge {
  a: string;
  b: string;
  weight?: number;
}

export interface DirectedCommunityEdge {
  source: string;
  target: string;
  weight?: number;
}

export interface LeidenCpmOptions {
  /** CPM density threshold. Higher values produce smaller/denser communities. */
  resolution?: number;
  /** Positive refinement temperature from the Leiden paper. */
  randomness?: number;
  /** Stable seed; input order never affects the generated pseudo-random sequence. */
  seed?: number;
  /** Re-run Leiden from its previous flat partition to improve subset optimality. */
  maxIterations?: number;
  /** Safety cap for successive aggregate graphs inside one Leiden iteration. */
  maxLevels?: number;
}

export interface BunchMqOptions {
  /** Optional feasibility constraint. It is not part of the Bunch MQ objective. */
  maxClusterSize?: number;
  maxPasses?: number;
}

interface CommunityNode {
  /** Original node ids represented by this aggregate node. */
  members: string[];
  /** CPM node weight: the number of original nodes represented here. */
  size: number;
}

interface CommunityGraph {
  nodes: CommunityNode[];
  /** Symmetric adjacency; each undirected weight occurs once in each endpoint map. */
  adjacency: Array<Map<number, number>>;
}

const EPSILON = 1e-10;
const DEFAULT_LEIDEN_RESOLUTION = 0.1;
const DEFAULT_LEIDEN_RANDOMNESS = 0.01;

/**
 * Partition a weighted undirected graph with the Leiden algorithm using the Constant Potts Model.
 * Duplicate/reversed input edges are summed. Unknown endpoints, loops, and non-positive weights are
 * ignored. The result is a complete disjoint partition, sorted independently of input order.
 */
export function leidenCpmPartition(
  inputIds: readonly string[],
  inputEdges: readonly UndirectedCommunityEdge[],
  options: LeidenCpmOptions = {},
): string[][] {
  const ids = uniqueSorted(inputIds);
  if (ids.length === 0) {
    return [];
  }
  const graph = undirectedGraph(ids, inputEdges);
  const resolution = finitePositive(options.resolution, DEFAULT_LEIDEN_RESOLUTION);
  const randomness = finitePositive(options.randomness, DEFAULT_LEIDEN_RANDOMNESS);
  const maxIterations = positiveInteger(options.maxIterations, 10);
  const maxLevels = positiveInteger(options.maxLevels, Math.max(2, ids.length));
  const random = seededRandom(options.seed ?? stableGraphSeed(ids, inputEdges));

  let partition = ids.map((id) => [id]);
  let signature = partitionSignature(partition);
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const initial = assignmentForFlatPartition(graph, partition);
    const next = leidenIteration(graph, initial, resolution, randomness, maxLevels, random);
    const nextSignature = partitionSignature(next);
    partition = next;
    if (nextSignature === signature) {
      break;
    }
    signature = nextSignature;
  }
  return canonicalPartition(partition);
}

/** The CPM objective H = sum_c [internalWeight(c) - gamma * choose(|c|, 2)]. */
export function cpmQuality(
  inputIds: readonly string[],
  inputEdges: readonly UndirectedCommunityEdge[],
  partition: readonly (readonly string[])[],
  resolution: number,
): number {
  const ids = uniqueSorted(inputIds);
  const community = communityByNode(ids, partition);
  const sizes = new Map<number, number>();
  for (const id of ids) {
    const group = community.get(id)!;
    sizes.set(group, (sizes.get(group) ?? 0) + 1);
  }
  let quality = 0;
  for (const edge of normalizedUndirectedEdges(ids, inputEdges)) {
    if (community.get(edge.a) === community.get(edge.b)) {
      quality += edge.weight;
    }
  }
  const gamma = finiteNonNegative(resolution, 0);
  for (const size of sizes.values()) {
    quality -= gamma * size * (size - 1) / 2;
  }
  return quality;
}

/**
 * Maximize the published TurboMQ cluster-factor objective using deterministic local search. The graph remains
 * directed: an edge crossing A -> B contributes external weight to both endpoint clusters.
 */
export function bunchMqPartition(
  inputIds: readonly string[],
  inputEdges: readonly DirectedCommunityEdge[],
  options: BunchMqOptions = {},
): string[][] {
  const ids = uniqueSorted(inputIds);
  if (ids.length === 0) {
    return [];
  }
  const edges = normalizedDirectedEdges(ids, inputEdges);
  const index = new Map(ids.map((id, position) => [id, position]));
  const neighbours = ids.map(() => new Set<number>());
  for (const edge of edges) {
    const source = index.get(edge.source)!;
    const target = index.get(edge.target)!;
    neighbours[source].add(target);
    neighbours[target].add(source);
  }
  const maxClusterSize = options.maxClusterSize === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxClusterSize, 1);
  const maxPasses = positiveInteger(options.maxPasses, Math.max(20, ids.length * 2));
  let assignment = ids.map((_, position) => position);
  let nextCommunity = ids.length;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (let node = 0; node < ids.length; node += 1) {
      const currentScore = bunchScoreForAssignment(ids, edges, assignment);
      const sizes = assignmentSizes(assignment);
      const current = assignment[node];
      const candidates = new Set<number>();
      for (const neighbour of neighbours[node]) {
        candidates.add(assignment[neighbour]);
      }
      if ((sizes.get(current) ?? 0) > 1) {
        candidates.add(nextCommunity);
      }
      candidates.delete(current);

      let best: { community: number; score: number; key: string } | null = null;
      for (const candidate of candidates) {
        if (candidate !== nextCommunity && (sizes.get(candidate) ?? 0) + 1 > maxClusterSize) {
          continue;
        }
        const proposal = assignment.slice();
        proposal[node] = candidate;
        const score = bunchScoreForAssignment(ids, edges, proposal);
        const key = candidate === nextCommunity ? `~${ids[node]}` : communityKey(ids, assignment, candidate);
        if (score > currentScore + EPSILON && (!best || score > best.score + EPSILON
          || (Math.abs(score - best.score) <= EPSILON && compareCodeUnit(key, best.key) < 0))) {
          best = { community: candidate, score, key };
        }
      }
      if (best) {
        assignment[node] = best.community;
        if (best.community === nextCommunity) {
          nextCommunity += 1;
        }
        changed = true;
      }
    }

    const merge = bestMqMerge(ids, edges, assignment, neighbours, maxClusterSize);
    if (merge) {
      assignment = assignment.map((community) => community === merge.drop ? merge.keep : community);
      changed = true;
    }
    if (!changed) {
      break;
    }
  }
  return partitionFromAssignment(ids.map((id) => [id]), assignment);
}

/**
 * Bunch MQ = sum_c internal(c) / [internal(c) + 0.5 * external(c)]. A cluster without any internal
 * edge has factor zero. Edge direction and positive edge weights are retained.
 */
export function bunchMqQuality(
  inputIds: readonly string[],
  inputEdges: readonly DirectedCommunityEdge[],
  partition: readonly (readonly string[])[],
): number {
  const ids = uniqueSorted(inputIds);
  const edges = normalizedDirectedEdges(ids, inputEdges);
  const byId = communityByNode(ids, partition);
  const assignment = ids.map((id) => byId.get(id)!);
  return bunchScoreForAssignment(ids, edges, assignment);
}

function leidenIteration(
  baseGraph: CommunityGraph,
  initialAssignment: number[],
  resolution: number,
  randomness: number,
  maxLevels: number,
  random: () => number,
): string[][] {
  let graph = baseGraph;
  let assignment = initialAssignment;
  for (let level = 0; level < maxLevels; level += 1) {
    assignment = moveNodesFast(graph, assignment, resolution, random);
    if (communityCount(assignment) === graph.nodes.length) {
      return partitionFromAssignment(graph.nodes.map((node) => node.members), assignment);
    }
    const refined = refinePartition(graph, assignment, resolution, randomness, random);
    const aggregate = aggregateGraph(graph, refined, assignment);
    if (aggregate.graph.nodes.length === graph.nodes.length) {
      return partitionFromAssignment(graph.nodes.map((node) => node.members), assignment);
    }
    graph = aggregate.graph;
    assignment = aggregate.parentAssignment;
  }
  return partitionFromAssignment(graph.nodes.map((node) => node.members), assignment);
}

/** Fast local move with the Leiden queue rule; stable shuffling replaces ambient Math.random. */
function moveNodesFast(
  graph: CommunityGraph,
  initialAssignment: readonly number[],
  resolution: number,
  random: () => number,
): number[] {
  const assignment = [...initialAssignment];
  const sizes = communityNodeSizes(graph, assignment);
  let nextCommunity = Math.max(-1, ...assignment) + 1;
  const queue = shuffled(graph.nodes.map((_, index) => index), random);
  const queued = new Set(queue);
  const safetyLimit = Math.max(100, graph.nodes.length * graph.nodes.length * 20);
  let steps = 0;
  while (queue.length > 0 && steps < safetyLimit) {
    steps += 1;
    const node = queue.shift()!;
    queued.delete(node);
    const current = assignment[node];
    const nodeSize = graph.nodes[node].size;
    const currentSize = sizes.get(current) ?? nodeSize;
    const removal = edgeWeightToCommunity(graph, node, current, assignment)
      - resolution * nodeSize * (currentSize - nodeSize);
    const candidates = new Set<number>();
    for (const neighbour of graph.adjacency[node].keys()) {
      candidates.add(assignment[neighbour]);
    }
    if (currentSize > nodeSize) {
      candidates.add(nextCommunity);
    }
    candidates.delete(current);

    let best: { community: number; delta: number; key: string } | null = null;
    for (const candidate of candidates) {
      const insertion = candidate === nextCommunity
        ? 0
        : edgeWeightToCommunity(graph, node, candidate, assignment)
          - resolution * nodeSize * (sizes.get(candidate) ?? 0);
      const delta = insertion - removal;
      const key = candidate === nextCommunity
        ? graph.nodes[node].members.join("\0")
        : aggregateCommunityKey(graph, assignment, candidate);
      if (delta > EPSILON && (!best || delta > best.delta + EPSILON
        || (Math.abs(delta - best.delta) <= EPSILON && compareCodeUnit(key, best.key) < 0))) {
        best = { community: candidate, delta, key };
      }
    }
    if (!best) {
      continue;
    }
    sizes.set(current, currentSize - nodeSize);
    sizes.set(best.community, (sizes.get(best.community) ?? 0) + nodeSize);
    assignment[node] = best.community;
    if (best.community === nextCommunity) {
      nextCommunity += 1;
    }
    for (const neighbour of graph.adjacency[node].keys()) {
      if (assignment[neighbour] !== best.community && !queued.has(neighbour)) {
        queue.push(neighbour);
        queued.add(neighbour);
      }
    }
  }
  return assignment;
}

function refinePartition(
  graph: CommunityGraph,
  parent: readonly number[],
  resolution: number,
  randomness: number,
  random: () => number,
): number[] {
  const refined = graph.nodes.map((_, index) => index);
  const refinedSizes = communityNodeSizes(graph, refined);
  const parents = groupedNodeIndices(parent)
    .sort((a, b) => compareCodeUnit(nodeSetKey(graph, a), nodeSetKey(graph, b)));

  for (const subset of parents) {
    const subsetSet = new Set(subset);
    const subsetSize = subset.reduce((sum, node) => sum + graph.nodes[node].size, 0);
    const eligible = subset.filter((node) => {
      const nodeSize = graph.nodes[node].size;
      return edgeWeightToSubset(graph, node, subsetSet) + EPSILON
        >= resolution * nodeSize * (subsetSize - nodeSize);
    });
    for (const node of shuffled(eligible, random)) {
      const current = refined[node];
      if ((refinedSizes.get(current) ?? 0) !== graph.nodes[node].size) {
        continue;
      }
      const candidates = new Set<number>([current]);
      for (const neighbour of graph.adjacency[node].keys()) {
        if (subsetSet.has(neighbour)) {
          candidates.add(refined[neighbour]);
        }
      }
      const choices: Array<{ community: number; delta: number; key: string }> = [];
      for (const candidate of candidates) {
        const candidateNodes = subset.filter((member) => refined[member] === candidate);
        const candidateSet = new Set(candidateNodes);
        const candidateSize = refinedSizes.get(candidate) ?? 0;
        if (boundaryWeight(graph, candidateSet, subsetSet) + EPSILON
          < resolution * candidateSize * (subsetSize - candidateSize)) {
          continue;
        }
        const delta = candidate === current
          ? 0
          : edgeWeightToCommunity(graph, node, candidate, refined)
            - resolution * graph.nodes[node].size * candidateSize;
        if (delta >= -EPSILON) {
          choices.push({
            community: candidate,
            delta: Math.max(0, delta),
            key: nodeSetKey(graph, candidateNodes),
          });
        }
      }
      if (choices.length === 0) {
        continue;
      }
      choices.sort((a, b) => compareCodeUnit(a.key, b.key));
      const selected = softmaxChoice(choices, randomness, random);
      if (selected.community !== current) {
        const nodeSize = graph.nodes[node].size;
        refinedSizes.set(current, (refinedSizes.get(current) ?? 0) - nodeSize);
        refinedSizes.set(selected.community, (refinedSizes.get(selected.community) ?? 0) + nodeSize);
        refined[node] = selected.community;
      }
    }
  }
  return refined;
}

function aggregateGraph(
  graph: CommunityGraph,
  refined: readonly number[],
  parent: readonly number[],
): { graph: CommunityGraph; parentAssignment: number[] } {
  const groups = groupedNodeIndices(refined)
    .sort((a, b) => compareCodeUnit(nodeSetKey(graph, a), nodeSetKey(graph, b)));
  const aggregateOf = new Map<number, number>();
  const nodes = groups.map((members, aggregate) => {
    for (const member of members) {
      aggregateOf.set(member, aggregate);
    }
    const originals = members.flatMap((member) => graph.nodes[member].members).sort(compareCodeUnit);
    return {
      members: originals,
      size: members.reduce((sum, member) => sum + graph.nodes[member].size, 0),
    };
  });
  const adjacency = nodes.map(() => new Map<number, number>());
  for (let source = 0; source < graph.nodes.length; source += 1) {
    for (const [target, weight] of graph.adjacency[source]) {
      if (source >= target) {
        continue;
      }
      const a = aggregateOf.get(source)!;
      const b = aggregateOf.get(target)!;
      if (a === b) {
        continue;
      }
      adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + weight);
      adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + weight);
    }
  }
  const parentLabels = new Map<number, number>();
  let nextParent = 0;
  const parentAssignment = groups.map((members) => {
    const oldParent = parent[members[0]];
    if (!parentLabels.has(oldParent)) {
      parentLabels.set(oldParent, nextParent);
      nextParent += 1;
    }
    return parentLabels.get(oldParent)!;
  });
  return { graph: { nodes, adjacency }, parentAssignment };
}

function undirectedGraph(ids: readonly string[], edges: readonly UndirectedCommunityEdge[]): CommunityGraph {
  const index = new Map(ids.map((id, position) => [id, position]));
  const adjacency = ids.map(() => new Map<number, number>());
  for (const edge of normalizedUndirectedEdges(ids, edges)) {
    const a = index.get(edge.a)!;
    const b = index.get(edge.b)!;
    adjacency[a].set(b, edge.weight);
    adjacency[b].set(a, edge.weight);
  }
  return {
    nodes: ids.map((id) => ({ members: [id], size: 1 })),
    adjacency,
  };
}

function normalizedUndirectedEdges(
  ids: readonly string[],
  inputEdges: readonly UndirectedCommunityEdge[],
): Array<{ a: string; b: string; weight: number }> {
  const known = new Set(ids);
  const byPair = new Map<string, { a: string; b: string; weight: number }>();
  for (const input of inputEdges) {
    if (input.a === input.b || !known.has(input.a) || !known.has(input.b)) {
      continue;
    }
    const weight = usableWeight(input.weight);
    if (weight <= 0) {
      continue;
    }
    const [a, b] = orderedPair(input.a, input.b);
    const key = pairKey(a, b);
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += weight;
    } else {
      byPair.set(key, { a, b, weight });
    }
  }
  return [...byPair.values()].sort(compareUndirectedEdge);
}

function normalizedDirectedEdges(
  ids: readonly string[],
  inputEdges: readonly DirectedCommunityEdge[],
): Array<{ source: string; target: string; weight: number }> {
  const known = new Set(ids);
  const byPair = new Map<string, { source: string; target: string; weight: number }>();
  for (const input of inputEdges) {
    if (input.source === input.target || !known.has(input.source) || !known.has(input.target)) {
      continue;
    }
    const weight = usableWeight(input.weight);
    if (weight <= 0) {
      continue;
    }
    const key = pairKey(input.source, input.target);
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += weight;
    } else {
      byPair.set(key, { source: input.source, target: input.target, weight });
    }
  }
  return [...byPair.values()].sort((a, b) =>
    compareCodeUnit(a.source, b.source) || compareCodeUnit(a.target, b.target));
}

function bunchScoreForAssignment(
  ids: readonly string[],
  edges: readonly { source: string; target: string; weight: number }[],
  assignment: readonly number[],
): number {
  const index = new Map(ids.map((id, position) => [id, position]));
  const internal = new Map<number, number>();
  const external = new Map<number, number>();
  for (const edge of edges) {
    const source = assignment[index.get(edge.source)!];
    const target = assignment[index.get(edge.target)!];
    if (source === target) {
      internal.set(source, (internal.get(source) ?? 0) + edge.weight);
    } else {
      external.set(source, (external.get(source) ?? 0) + edge.weight);
      external.set(target, (external.get(target) ?? 0) + edge.weight);
    }
  }
  let score = 0;
  for (const community of new Set(assignment)) {
    const inside = internal.get(community) ?? 0;
    if (inside > 0) {
      score += inside / (inside + 0.5 * (external.get(community) ?? 0));
    }
  }
  return score;
}

function bestMqMerge(
  ids: readonly string[],
  edges: readonly { source: string; target: string; weight: number }[],
  assignment: readonly number[],
  neighbours: readonly ReadonlySet<number>[],
  maxClusterSize: number,
): { keep: number; drop: number } | null {
  const current = bunchScoreForAssignment(ids, edges, assignment);
  const sizes = assignmentSizes(assignment);
  const pairs = new Map<string, [number, number]>();
  for (let node = 0; node < ids.length; node += 1) {
    for (const neighbour of neighbours[node]) {
      const a = assignment[node];
      const b = assignment[neighbour];
      if (a === b) continue;
      const [first, second] = a < b ? [a, b] : [b, a];
      pairs.set(`${first}:${second}`, [first, second]);
    }
  }
  let best: { keep: number; drop: number; score: number; key: string } | null = null;
  for (const [a, b] of pairs.values()) {
    if ((sizes.get(a) ?? 0) + (sizes.get(b) ?? 0) > maxClusterSize) {
      continue;
    }
    const keyA = communityKey(ids, assignment, a);
    const keyB = communityKey(ids, assignment, b);
    const [keep, drop] = compareCodeUnit(keyA, keyB) <= 0 ? [a, b] : [b, a];
    const proposal = assignment.map((community) => community === drop ? keep : community);
    const score = bunchScoreForAssignment(ids, edges, proposal);
    const key = `${communityKey(ids, proposal, keep)}\0${keyA}\0${keyB}`;
    if (score > current + EPSILON && (!best || score > best.score + EPSILON
      || (Math.abs(score - best.score) <= EPSILON && compareCodeUnit(key, best.key) < 0))) {
      best = { keep, drop, score, key };
    }
  }
  return best && { keep: best.keep, drop: best.drop };
}

function assignmentForFlatPartition(graph: CommunityGraph, partition: readonly (readonly string[])[]): number[] {
  const group = new Map<string, number>();
  canonicalPartition(partition).forEach((members, community) => {
    for (const member of members) group.set(member, community);
  });
  return graph.nodes.map((node, index) => group.get(node.members[0]) ?? partition.length + index);
}

function communityByNode(ids: readonly string[], partition: readonly (readonly string[])[]): Map<string, number> {
  const known = new Set(ids);
  const result = new Map<string, number>();
  canonicalPartition(partition).forEach((members, community) => {
    for (const member of members) {
      if (known.has(member) && !result.has(member)) result.set(member, community);
    }
  });
  let next = partition.length;
  for (const id of ids) {
    if (!result.has(id)) {
      result.set(id, next);
      next += 1;
    }
  }
  return result;
}

function partitionFromAssignment(memberSets: readonly (readonly string[])[], assignment: readonly number[]): string[][] {
  const groups = new Map<number, string[]>();
  assignment.forEach((community, index) => {
    const members = groups.get(community) ?? [];
    members.push(...memberSets[index]);
    groups.set(community, members);
  });
  return canonicalPartition([...groups.values()]);
}

function canonicalPartition(partition: readonly (readonly string[])[]): string[][] {
  return partition
    .map((members) => uniqueSorted(members))
    .filter((members) => members.length > 0)
    .sort(compareMemberSets);
}

function groupedNodeIndices(assignment: readonly number[]): number[][] {
  const groups = new Map<number, number[]>();
  assignment.forEach((community, node) => {
    const members = groups.get(community) ?? [];
    members.push(node);
    groups.set(community, members);
  });
  return [...groups.values()];
}

function communityNodeSizes(graph: CommunityGraph, assignment: readonly number[]): Map<number, number> {
  const sizes = new Map<number, number>();
  assignment.forEach((community, node) => {
    sizes.set(community, (sizes.get(community) ?? 0) + graph.nodes[node].size);
  });
  return sizes;
}

function assignmentSizes(assignment: readonly number[]): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const community of assignment) sizes.set(community, (sizes.get(community) ?? 0) + 1);
  return sizes;
}

function edgeWeightToCommunity(
  graph: CommunityGraph,
  node: number,
  community: number,
  assignment: readonly number[],
): number {
  let weight = 0;
  for (const [neighbour, value] of graph.adjacency[node]) {
    if (assignment[neighbour] === community) weight += value;
  }
  return weight;
}

function edgeWeightToSubset(graph: CommunityGraph, node: number, subset: ReadonlySet<number>): number {
  let weight = 0;
  for (const [neighbour, value] of graph.adjacency[node]) {
    if (neighbour !== node && subset.has(neighbour)) weight += value;
  }
  return weight;
}

function boundaryWeight(
  graph: CommunityGraph,
  community: ReadonlySet<number>,
  subset: ReadonlySet<number>,
): number {
  let weight = 0;
  for (const node of community) {
    for (const [neighbour, value] of graph.adjacency[node]) {
      if (subset.has(neighbour) && !community.has(neighbour)) weight += value;
    }
  }
  return weight;
}

function softmaxChoice<T extends { delta: number }>(choices: readonly T[], temperature: number, random: () => number): T {
  const max = Math.max(...choices.map((choice) => choice.delta));
  const weights = choices.map((choice) => Math.exp((choice.delta - max) / temperature));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let draw = random() * total;
  for (let index = 0; index < choices.length; index += 1) {
    draw -= weights[index];
    if (draw <= 0) return choices[index];
  }
  return choices[choices.length - 1];
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function stableGraphSeed(ids: readonly string[], edges: readonly UndirectedCommunityEdge[]): number {
  const normalized = normalizedUndirectedEdges(ids, edges);
  return stableHash(`${ids.join("\0")}\u0001${normalized.map((edge) => `${edge.a}>${edge.b}:${edge.weight}`).join("\0")}`);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function usableWeight(weight: number | undefined): number {
  return weight === undefined ? 1 : Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnit);
}

function orderedPair(a: string, b: string): [string, string] {
  return compareCodeUnit(a, b) <= 0 ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  return `${a.length}:${a}${b}`;
}

function compareUndirectedEdge(
  a: { a: string; b: string },
  b: { a: string; b: string },
): number {
  return compareCodeUnit(a.a, b.a) || compareCodeUnit(a.b, b.b);
}

function compareMemberSets(a: readonly string[], b: readonly string[]): number {
  return compareCodeUnit(a[0] ?? "", b[0] ?? "") || compareCodeUnit(a.join("\0"), b.join("\0"));
}

function partitionSignature(partition: readonly (readonly string[])[]): string {
  return canonicalPartition(partition).map((members) => members.join("\0")).join("\u0001");
}

function communityCount(assignment: readonly number[]): number {
  return new Set(assignment).size;
}

function nodeSetKey(graph: CommunityGraph, nodes: readonly number[]): string {
  return nodes.flatMap((node) => graph.nodes[node].members).sort(compareCodeUnit).join("\0");
}

function aggregateCommunityKey(graph: CommunityGraph, assignment: readonly number[], community: number): string {
  return nodeSetKey(graph, graph.nodes.map((_, node) => node).filter((node) => assignment[node] === community));
}

function communityKey(ids: readonly string[], assignment: readonly number[], community: number): string {
  return ids.filter((_, index) => assignment[index] === community).join("\0");
}

/** Algorithm and stable ids must not depend on the browser's locale/ICU build. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
