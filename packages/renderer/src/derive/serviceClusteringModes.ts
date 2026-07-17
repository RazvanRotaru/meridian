/**
 * Alternative, deterministic partitions for the Service lens.
 *
 * Every mode groups the already-derived service COMPOSITION clusters by their lead id. Folder is
 * the existing path-domain partition; semantic modes use modularity, CPM, or Bunch MQ; balanced
 * modes optimize the requested cross-parent cut directly. Keeping this pure makes the expensive
 * full-system assignment cacheable and prevents focus/viewport state from changing a service's
 * home.
 */

import type { ServiceMemberFeature } from "@meridian/design-metrics";
import { partitionServiceGraph } from "./balancedServicePartition";
import { groupByPathDomain } from "./pathDomains";
import type { ServiceCluster, ServiceClustering } from "./serviceComposition";
import { bunchMqPartition, leidenCpmPartition, type DirectedCommunityEdge } from "./serviceCommunityPartitioners";
import { DEFAULT_SERVICE_GROUPING_TARGET_SIZE } from "../state/serviceGroupingTargetSize";

export const SERVICE_GROUPING_OPTIONS = [
  { id: "domain", label: "Domain" },
  { id: "edge-cut", label: "Fewest links" },
  { id: "coupling-cut", label: "Least coupling" },
  { id: "leiden", label: "Leiden + CPM" },
  { id: "bunch", label: "Bunch MQ" },
  { id: "dependency", label: "Dependency" },
  { id: "api", label: "Similar API" },
  { id: "vocabulary", label: "Vocabulary" },
  { id: "folder", label: "Folder" },
] as const;

export type ServiceGroupingMode = (typeof SERVICE_GROUPING_OPTIONS)[number]["id"];

export type ServiceGroupingLabelMode = "single" | "pair";

export const DEFAULT_SERVICE_GROUPING_LABEL_MODE: ServiceGroupingLabelMode = "single";

export interface ServiceNodeGroup {
  /** Stable for the same mode + exact member set; independent of input iteration order and label. */
  id: string;
  mode: ServiceGroupingMode;
  label: string;
  /** Service-composition lead ids, never the helper units owned by those leads. */
  leadIds: string[];
}

interface AffinityEdge {
  a: string;
  b: string;
  weight: number;
}

type FeatureVector = Map<string, number>;

const DEPENDENCY_RESOLUTION = 1.05;
const VOCABULARY_RESOLUTION = 1.15;
const IMPLEMENTATION_RESOLUTION = 1.12;
const DOMAIN_MIN_RESOLUTION = 1.2;
const DOMAIN_MAX_RESOLUTION = 2.4;
const EPSILON = 1e-10;

/** Derive one complete, disjoint partition of all service leads. */
export function deriveServiceNodeGroups(
  clustering: ServiceClustering,
  mode: ServiceGroupingMode,
  targetSize: number = DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  labelMode: ServiceGroupingLabelMode = DEFAULT_SERVICE_GROUPING_LABEL_MODE,
): ServiceNodeGroup[] {
  const leads = sortedLeads(clustering.clusters);
  if (leads.length === 0) {
    return [];
  }
  if (mode === "folder") {
    return folderGroups(clustering);
  }

  const labelVocabulary = labelVocabularyVectors(clustering);
  const dependencyEdges = dependencyAffinities(clustering);
  if (mode === "edge-cut" || mode === "coupling-cut") {
    const edges = servicePairAffinities(clustering, mode === "edge-cut" ? "unique" : "typed");
    const objective = mode === "edge-cut"
      ? { cutWeight: 1, quotientEdgeCount: 0.2 }
      : { cutWeight: 1, cutEdgeCount: 0.1, quotientEdgeCount: 0.2 };
    const partition = partitionServiceGraph(leads, edges, targetSize, { objective }).groups;
    return materializeGroups(mode, partition, clustering, labelVocabulary, labelMode);
  }
  if (mode === "leiden") {
    const partition = leidenCpmPartition(leads, dependencyEdges, {
      resolution: leidenCpmResolution(dependencyEdges, targetSize),
    });
    return materializeGroups(mode, partition, clustering, labelVocabulary, labelMode);
  }
  if (mode === "bunch") {
    const partition = targetSizedBunchPartition(
      leads,
      directedDependencyAffinities(clustering),
      targetSize,
    );
    return materializeGroups(mode, partition, clustering, labelVocabulary, labelMode);
  }

  const vocabulary = vocabularyVectors(clustering);
  const implementation = implementationVectors(clustering);
  const vocabularyEdges = similarityAffinities(leads, vocabulary, cosineSimilarity, 7, 0.08);
  const implementationEdges = similarityAffinities(
    leads,
    implementation,
    weightedJaccard,
    6,
    0.14,
  );
  const { edges, resolution } = evidenceFor(
    mode,
    clustering,
    dependencyEdges,
    vocabularyEdges,
    implementationEdges,
  );
  const partition = deterministicModularityPartition(leads, edges, resolution);
  return materializeGroups(mode, partition, clustering, labelVocabulary, labelMode);
}

/** Bunch discovers cohesive fine modules. The visual parent size is a separate product constraint:
 * preserve every MQ community intact, then pack those communities into the requested number of
 * parents using their cross-community coupling as affinity. */
function targetSizedBunchPartition(
  ids: readonly string[],
  edges: readonly DirectedCommunityEdge[],
  targetSize: number,
): string[][] {
  const target = Math.max(1, Math.round(targetSize));
  const maximum = Math.max(target, Math.ceil(target * 1.25));
  const fine = bunchMqPartition(ids, edges, { maxClusterSize: maximum });
  const desiredCount = Math.max(1, Math.round(ids.length / target));
  if (fine.length <= desiredCount) {
    return fine;
  }

  const communityOf = new Map<string, number>();
  fine.forEach((members, index) => members.forEach((id) => communityOf.set(id, index)));
  const pairAffinity = new Map<string, number>();
  for (const edge of edges) {
    const source = communityOf.get(edge.source);
    const targetCommunity = communityOf.get(edge.target);
    if (source === undefined || targetCommunity === undefined || source === targetCommunity) {
      continue;
    }
    const key = numericPairKey(source, targetCommunity);
    pairAffinity.set(key, (pairAffinity.get(key) ?? 0) + (edge.weight ?? 1));
  }
  const order = fine.map((members, index) => ({ index, members }))
    .sort((a, b) => b.members.length - a.members.length
      || compareMemberSets(a.members, b.members));
  const bins = Array.from({ length: desiredCount }, () => ({ communities: [] as number[], size: 0 }));
  for (let index = 0; index < desiredCount; index += 1) {
    const community = order[index];
    bins[index].communities.push(community.index);
    bins[index].size = community.members.length;
  }
  for (const community of order.slice(desiredCount)) {
    const feasible = bins.map((bin, index) => ({ bin, index }))
      .filter(({ bin }) => bin.size + community.members.length <= maximum);
    const candidates = feasible.length > 0 ? feasible : bins.map((bin, index) => ({ bin, index }));
    candidates.sort((a, b) => {
      const affinityA = affinityToPackedBin(community.index, a.bin.communities, pairAffinity);
      const affinityB = affinityToPackedBin(community.index, b.bin.communities, pairAffinity);
      return affinityB - affinityA
        || Math.max(0, a.bin.size + community.members.length - maximum)
          - Math.max(0, b.bin.size + community.members.length - maximum)
        || Math.abs(target - (a.bin.size + community.members.length))
          - Math.abs(target - (b.bin.size + community.members.length))
        || a.bin.size - b.bin.size
        || a.index - b.index;
    });
    const selected = candidates[0].bin;
    selected.communities.push(community.index);
    selected.size += community.members.length;
  }
  return bins
    .map((bin) => bin.communities.flatMap((index) => fine[index]).sort(compareCodeUnit))
    .sort(compareMemberSets);
}

function affinityToPackedBin(
  community: number,
  packed: readonly number[],
  affinity: ReadonlyMap<string, number>,
): number {
  return packed.reduce((sum, other) => sum + (affinity.get(numericPairKey(community, other)) ?? 0), 0);
}

function numericPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** CPM's density threshold must share the affinity graph's scale. A robust median keeps one noisy
 * hub from setting it; the bounded target-size scale acts as a soft resolution hint rather than a
 * hard cardinality constraint. */
function leidenCpmResolution(edges: readonly AffinityEdge[], targetSize: number): number {
  if (edges.length === 0) {
    return 0.005;
  }
  const weights = edges.map((edge) => edge.weight).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)] ?? 0;
  const sizeScale = DEFAULT_SERVICE_GROUPING_TARGET_SIZE / Math.max(1, targetSize);
  return Math.min(0.05, Math.max(0.001, median * 0.12 * sizeScale));
}

function evidenceFor(
  mode: Exclude<ServiceGroupingMode, "folder" | "edge-cut" | "coupling-cut" | "leiden" | "bunch">,
  clustering: ServiceClustering,
  dependency: readonly AffinityEdge[],
  vocabulary: readonly AffinityEdge[],
  implementation: readonly AffinityEdge[],
): { edges: AffinityEdge[]; resolution: number } {
  switch (mode) {
    case "dependency":
      return { edges: [...dependency], resolution: DEPENDENCY_RESOLUTION };
    case "vocabulary":
      return { edges: [...vocabulary], resolution: VOCABULARY_RESOLUTION };
    case "api":
      return { edges: [...implementation], resolution: IMPLEMENTATION_RESOLUTION };
    case "domain": {
      const edges = combineAffinities([
        { edges: dependency, factor: 0.5 },
        { edges: vocabulary, factor: 0.25 },
        { edges: folderAffinities(clustering), factor: 0.15 },
        { edges: implementation, factor: 0.1 },
      ]);
      return {
        edges,
        resolution: domainResolution(clustering.clusters.length, edges.length),
      };
    }
  }
}

/** Larger and denser service graphs need finer communities. Log scaling generalizes without a
 * repository-specific node-count target; clamps keep small systems coherent and huge ones bounded. */
function domainResolution(serviceCount: number, affinityCount: number): number {
  const sizeScale = Math.log2(Math.max(1, serviceCount / 12));
  const averageDegree = serviceCount === 0 ? 0 : 2 * affinityCount / serviceCount;
  const densityScale = Math.log2(Math.max(1, averageDegree / 4));
  const resolution = DOMAIN_MIN_RESOLUTION + 0.25 * sizeScale + 0.08 * densityScale;
  return Math.min(DOMAIN_MAX_RESOLUTION, Math.max(DOMAIN_MIN_RESOLUTION, resolution));
}

function folderGroups(clustering: ServiceClustering): ServiceNodeGroup[] {
  return groupByPathDomain(clustering.clusters.map((cluster) => ({
    id: cluster.leadId,
    file: clustering.metrics.get(cluster.leadId)?.moduleFile,
  }))).map((domain) => group("folder", domain.label, domain.ids));
}

function folderAffinities(clustering: ServiceClustering): AffinityEdge[] {
  const edges: AffinityEdge[] = [];
  for (const domain of groupByPathDomain(clustering.clusters.map((cluster) => ({
    id: cluster.leadId,
    file: clustering.metrics.get(cluster.leadId)?.moduleFile,
  })))) {
    // A bounded neighbourhood is a path PRIOR, not a dense clique that makes a 60-service folder
    // mathematically impossible for stronger domain evidence to split.
    for (let i = 0; i < domain.ids.length; i += 1) {
      for (let j = i + 1; j < Math.min(domain.ids.length, i + 4); j += 1) {
        edges.push({ a: domain.ids[i], b: domain.ids[j], weight: 1 });
      }
    }
  }
  return edges;
}

/**
 * Aggregate typed unit couplings at service-lead level, then cosine-normalize by each endpoint's
 * total strength. This preserves a strong pair while preventing ubiquitous infrastructure hubs
 * from pulling every service into one community.
 */
function dependencyAffinities(clustering: ServiceClustering): AffinityEdge[] {
  const raw = servicePairAffinities(clustering, "typed");
  const strength = new Map<string, number>();
  for (const edge of raw) {
    strength.set(edge.a, (strength.get(edge.a) ?? 0) + edge.weight);
    strength.set(edge.b, (strength.get(edge.b) ?? 0) + edge.weight);
  }
  return raw
    .map((edge) => ({
      ...edge,
      weight: edge.weight / Math.sqrt((strength.get(edge.a) ?? 1) * (strength.get(edge.b) ?? 1)),
    }))
    .sort(compareAffinity);
}

/** One undirected edge per service pair. Unique mode asks “how many lead-to-lead lines cross?”;
 * typed mode retains accumulated relationship importance for least-coupling cuts. */
function servicePairAffinities(
  clustering: ServiceClustering,
  weighting: "unique" | "typed",
): AffinityEdge[] {
  const raw = new Map<string, AffinityEdge>();
  for (const coupling of clustering.couplings) {
    const source = clustering.leadOf.get(coupling.source);
    const target = clustering.leadOf.get(coupling.target);
    if (!source || !target || source === target) {
      continue;
    }
    const [a, b] = orderedPair(source, target);
    const key = pairKey(a, b);
    const weight = weighting === "unique"
      ? 1
      : [...coupling.kinds].reduce((sum, kind) => sum + dependencyKindWeight(kind), 0);
    const existing = raw.get(key);
    if (existing) {
      existing.weight = weighting === "unique" ? 1 : existing.weight + weight;
    } else {
      raw.set(key, { a, b, weight });
    }
  }
  return [...raw.values()].sort(compareAffinity);
}

/** Direction is irrelevant to cut modes but is part of Bunch's module-dependency graph. */
function directedDependencyAffinities(clustering: ServiceClustering): DirectedCommunityEdge[] {
  const edges = new Map<string, DirectedCommunityEdge>();
  for (const coupling of clustering.couplings) {
    const source = clustering.leadOf.get(coupling.source);
    const target = clustering.leadOf.get(coupling.target);
    if (!source || !target || source === target) {
      continue;
    }
    const key = `${source}\0${target}`;
    const weight = [...coupling.kinds].reduce((sum, kind) => sum + dependencyKindWeight(kind), 0);
    const existing = edges.get(key);
    if (existing) {
      existing.weight = (existing.weight ?? 0) + weight;
    } else {
      edges.set(key, { source, target, weight });
    }
  }
  return [...edges.values()].sort((a, b) =>
    compareCodeUnit(a.source, b.source) || compareCodeUnit(a.target, b.target));
}

function dependencyKindWeight(kind: string): number {
  switch (kind) {
    case "instantiates":
      return 5;
    case "calls":
      return 4;
    case "implements":
    case "extends":
      return 2;
    case "imports":
    case "references":
      return 1;
    default:
      return 0.5;
  }
}

/** Developer vocabulary: lead/unit names, paths, member names, signatures, and summaries. */
function vocabularyVectors(clustering: ServiceClustering): Map<string, FeatureVector> {
  const counts = new Map<string, FeatureVector>();
  for (const cluster of clustering.clusters) {
    const vector = new Map<string, number>();
    for (const id of cluster.memberIds) {
      const metric = clustering.metrics.get(id);
      if (metric) {
        addWords(vector, `${metric.displayName} ${metric.moduleFile}`);
      }
      for (const member of clustering.membersByUnit.get(id) ?? []) {
        addWords(vector, `${member.displayName} ${member.qualifiedName} ${member.signature ?? ""} ${member.summary ?? ""}`);
      }
    }
    counts.set(cluster.leadId, vector);
  }
  return tfIdf(counts);
}

/** A quieter vocabulary used only for visible group names. Clustering benefits from paths and full
 * signatures; labels do not — those promote incidental path/type words over concepts readers know. */
function labelVocabularyVectors(clustering: ServiceClustering): Map<string, FeatureVector> {
  const counts = new Map<string, FeatureVector>();
  for (const cluster of clustering.clusters) {
    const vector = new Map<string, number>();
    for (const id of cluster.memberIds) {
      const metric = clustering.metrics.get(id);
      for (const token of tokens(metric?.displayName ?? "")) {
        addFeature(vector, token, 3);
      }
      for (const member of clustering.membersByUnit.get(id) ?? []) {
        addWords(vector, `${member.displayName} ${member.summary ?? ""}`);
      }
    }
    counts.set(cluster.leadId, vector);
  }
  return tfIdf(counts);
}

/**
 * API-role fingerprint available in GraphArtifact v1: signature shapes, method roles, unit shape,
 * and typed in/out dependency profiles. This deliberately does not claim full AST clone matching.
 */
function implementationVectors(clustering: ServiceClustering): Map<string, FeatureVector> {
  const vectors = new Map<string, FeatureVector>();
  for (const cluster of clustering.clusters) {
    const vector = new Map<string, number>();
    for (const id of cluster.memberIds) {
      const metric = clustering.metrics.get(id);
      const members = clustering.membersByUnit.get(id) ?? [];
      // Empty classes/modules share only boilerplate shape; leaving them featureless prevents an
      // artificial "everything with zero methods" similarity cluster.
      if (metric && members.length > 0) {
        addFeature(vector, `unit:${metric.kind}`, 0.25);
        addFeature(vector, `members:${bucket(metric.members, [0, 2, 5, 10, 20])}`, 0.25);
        addFeature(vector, `cohesion:${bucket(metric.cohesion, [0.25, 0.5, 0.75, 0.99])}`, 0.25);
        addFeature(vector, `abstract:${bucket(metric.abstractness, [0.01, 0.5, 0.99])}`, 0.25);
      }
      for (const member of members) {
        addFeature(vector, `member:${member.kind}`, 0.25);
        for (const tag of member.tags ?? []) {
          addFeature(vector, `tag:${tag.toLowerCase()}`, 0.5);
        }
        for (const token of tokens(member.displayName)) {
          addFeature(vector, `role:${token}`, 2);
        }
        const signature = normalizedSignature(member);
        if (signature) {
          addFeature(vector, `signature:${signature}`, 4);
          addFeature(vector, `arity:${signatureArity(member.signature ?? "")}`, 0.5);
        }
      }
    }
    vectors.set(cluster.leadId, vector);
  }
  addCouplingProfileFeatures(vectors, clustering);
  return vectors;
}

function addCouplingProfileFeatures(
  vectors: Map<string, FeatureVector>,
  clustering: ServiceClustering,
): void {
  for (const coupling of clustering.couplings) {
    const source = clustering.leadOf.get(coupling.source);
    const target = clustering.leadOf.get(coupling.target);
    if (!source || !target || source === target) {
      continue;
    }
    const sourceVector = vectors.get(source);
    const targetVector = vectors.get(target);
    if (!sourceVector || !targetVector) {
      continue;
    }
    const targetName = clustering.metrics.get(target)?.displayName ?? target;
    const sourceName = clustering.metrics.get(source)?.displayName ?? source;
    for (const kind of coupling.kinds) {
      addFeature(sourceVector, `out:${kind}`);
      addFeature(targetVector, `in:${kind}`);
      for (const token of tokens(targetName)) {
        addFeature(sourceVector, `out-role:${token}`);
      }
      for (const token of tokens(sourceName)) {
        addFeature(targetVector, `in-role:${token}`);
      }
    }
  }
}

function normalizedSignature(member: ServiceMemberFeature): string {
  const signature = member.signature?.trim();
  if (!signature) {
    return "";
  }
  const escapedName = escapeRegExp(member.displayName);
  return signature
    .replace(new RegExp(`\\b${escapedName}\\s*(?=\\()`, "i"), "method")
    .replace(/\b[$A-Z_a-z][$\w]*\s*(?=\??\s*:)/g, "arg")
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "text")
    .replace(/\b\d+(?:\.\d+)?\b/g, "number")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, 180);
}

function signatureArity(signature: string): number {
  const open = signature.indexOf("(");
  if (open === -1) {
    return 0;
  }
  let depth = 0;
  let commas = 0;
  let hasArgument = false;
  for (let index = open + 1; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === "(" || char === "[" || char === "{" || char === "<") {
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    } else if (char === "]" || char === "}" || char === ">") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      commas += 1;
    } else if (!/\s/.test(char)) {
      hasArgument = true;
    }
  }
  return hasArgument ? commas + 1 : 0;
}

function tfIdf(counts: Map<string, FeatureVector>): Map<string, FeatureVector> {
  const documentFrequency = new Map<string, number>();
  for (const vector of counts.values()) {
    for (const term of vector.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = counts.size;
  const result = new Map<string, FeatureVector>();
  for (const [id, countVector] of counts) {
    const vector = new Map<string, number>();
    let normSquared = 0;
    for (const [term, count] of countVector) {
      const tf = 1 + Math.log(count);
      const idf = Math.log((total + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      const value = tf * idf;
      vector.set(term, value);
      normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared) || 1;
    for (const [term, value] of vector) {
      vector.set(term, value / norm);
    }
    result.set(id, vector);
  }
  return result;
}

function similarityAffinities(
  ids: readonly string[],
  vectors: ReadonlyMap<string, FeatureVector>,
  similarity: (a: FeatureVector, b: FeatureVector) => number,
  topK: number,
  minimum: number,
): AffinityEdge[] {
  const candidates = new Map<string, AffinityEdge>();
  for (let i = 0; i < ids.length; i += 1) {
    const source = ids[i];
    const sourceVector = vectors.get(source) ?? new Map();
    const neighbours: AffinityEdge[] = [];
    for (let j = 0; j < ids.length; j += 1) {
      if (i === j) {
        continue;
      }
      const target = ids[j];
      const weight = similarity(sourceVector, vectors.get(target) ?? new Map());
      if (weight >= minimum) {
        const [a, b] = orderedPair(source, target);
        neighbours.push({ a, b, weight });
      }
    }
    neighbours.sort((a, b) => b.weight - a.weight || compareAffinity(a, b));
    for (const edge of neighbours.slice(0, topK)) {
      const key = pairKey(edge.a, edge.b);
      const existing = candidates.get(key);
      if (!existing || edge.weight > existing.weight) {
        candidates.set(key, edge);
      }
    }
  }
  return [...candidates.values()].sort(compareAffinity);
}

function cosineSimilarity(a: FeatureVector, b: FeatureVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [feature, value] of small) {
    dot += value * (large.get(feature) ?? 0);
  }
  return dot;
}

function weightedJaccard(a: FeatureVector, b: FeatureVector): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const av = a.get(key) ?? 0;
    const bv = b.get(key) ?? 0;
    intersection += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union === 0 ? 0 : intersection / union;
}

function combineAffinities(
  sources: ReadonlyArray<{ edges: readonly AffinityEdge[]; factor: number }>,
): AffinityEdge[] {
  const combined = new Map<string, AffinityEdge>();
  for (const source of sources) {
    const max = Math.max(0, ...source.edges.map((edge) => edge.weight));
    if (max === 0) {
      continue;
    }
    for (const edge of source.edges) {
      const key = pairKey(edge.a, edge.b);
      const value = source.factor * edge.weight / max;
      const existing = combined.get(key);
      if (existing) {
        existing.weight += value;
      } else {
        combined.set(key, { a: edge.a, b: edge.b, weight: value });
      }
    }
  }
  return [...combined.values()].filter((edge) => edge.weight > 0).sort(compareAffinity);
}

/**
 * Deterministic modularity optimization. A local-move pass can reassign individual nodes, then a
 * positive-delta merge pass performs the aggregate-community phase. At this graph size an exact
 * O(VE + V^2) pass is comfortably client-side and avoids a random seed/dependency entirely.
 */
function deterministicModularityPartition(
  ids: readonly string[],
  inputEdges: readonly AffinityEdge[],
  resolution: number,
): string[][] {
  const adjacency = adjacencyFor(ids, inputEdges);
  const totalWeight = inputEdges.reduce((sum, edge) => sum + edge.weight, 0);
  if (totalWeight <= EPSILON) {
    return ids.map((id) => [id]);
  }
  const degree = new Map(ids.map((id) => [
    id,
    [...(adjacency.get(id)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0),
  ]));
  const assignment = new Map(ids.map((id) => [id, id]));
  const totalDegree = new Map(ids.map((id) => [id, degree.get(id) ?? 0]));
  const internalWeight = new Map(ids.map((id) => [id, 0]));

  for (let pass = 0; pass < 50; pass += 1) {
    let moved = false;
    for (const node of ids) {
      if (moveNodeIfBetter(
        node,
        adjacency,
        degree,
        assignment,
        totalDegree,
        internalWeight,
        totalWeight,
        resolution,
      )) {
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  mergeCommunities(
    ids,
    adjacency,
    assignment,
    totalDegree,
    internalWeight,
    totalWeight,
    resolution,
  );
  return connectedCommunityMembers(ids, adjacency, assignment);
}

function moveNodeIfBetter(
  node: string,
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  degree: ReadonlyMap<string, number>,
  assignment: Map<string, string>,
  totalDegree: Map<string, number>,
  internalWeight: Map<string, number>,
  totalWeight: number,
  resolution: number,
): boolean {
  const current = assignment.get(node)!;
  const nodeDegree = degree.get(node) ?? 0;
  const weightsByCommunity = neighbourCommunityWeights(node, adjacency, assignment);
  const currentWeight = weightsByCommunity.get(current) ?? 0;
  const candidates = [...new Set([
    ...weightsByCommunity.keys(),
    ...(communitySize(current, assignment) > 1 ? [`singleton:${node}`] : []),
  ])].filter((candidate) => candidate !== current).sort();
  let best: { community: string; delta: number } | null = null;
  for (const candidate of candidates) {
    const delta = moveDelta(
      current,
      candidate,
      nodeDegree,
      currentWeight,
      weightsByCommunity.get(candidate) ?? 0,
      totalDegree,
      internalWeight,
      totalWeight,
      resolution,
    );
    if (delta > EPSILON && (!best || delta > best.delta + EPSILON
      || (Math.abs(delta - best.delta) <= EPSILON && compareCodeUnit(candidate, best.community) < 0))) {
      best = { community: candidate, delta };
    }
  }
  if (!best) {
    return false;
  }
  totalDegree.set(current, (totalDegree.get(current) ?? 0) - nodeDegree);
  internalWeight.set(current, (internalWeight.get(current) ?? 0) - currentWeight);
  totalDegree.set(best.community, (totalDegree.get(best.community) ?? 0) + nodeDegree);
  internalWeight.set(
    best.community,
    (internalWeight.get(best.community) ?? 0) + (weightsByCommunity.get(best.community) ?? 0),
  );
  assignment.set(node, best.community);
  return true;
}

function moveDelta(
  from: string,
  to: string,
  nodeDegree: number,
  fromEdgeWeight: number,
  toEdgeWeight: number,
  totalDegree: ReadonlyMap<string, number>,
  internalWeight: ReadonlyMap<string, number>,
  totalWeight: number,
  resolution: number,
): number {
  const before = communityQuality(
    internalWeight.get(from) ?? 0,
    totalDegree.get(from) ?? 0,
    totalWeight,
    resolution,
  ) + communityQuality(
    internalWeight.get(to) ?? 0,
    totalDegree.get(to) ?? 0,
    totalWeight,
    resolution,
  );
  const after = communityQuality(
    (internalWeight.get(from) ?? 0) - fromEdgeWeight,
    (totalDegree.get(from) ?? 0) - nodeDegree,
    totalWeight,
    resolution,
  ) + communityQuality(
    (internalWeight.get(to) ?? 0) + toEdgeWeight,
    (totalDegree.get(to) ?? 0) + nodeDegree,
    totalWeight,
    resolution,
  );
  return after - before;
}

function communityQuality(
  internal: number,
  totalDegree: number,
  graphWeight: number,
  resolution: number,
): number {
  return internal / graphWeight - resolution * (totalDegree / (2 * graphWeight)) ** 2;
}

function mergeCommunities(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  assignment: Map<string, string>,
  totalDegree: Map<string, number>,
  internalWeight: Map<string, number>,
  totalWeight: number,
  resolution: number,
): void {
  while (true) {
    const between = new Map<string, { a: string; b: string; weight: number }>();
    for (const source of ids) {
      for (const [target, weight] of adjacency.get(source) ?? []) {
        if (compareCodeUnit(source, target) >= 0) {
          continue;
        }
        const sourceCommunity = assignment.get(source)!;
        const targetCommunity = assignment.get(target)!;
        if (sourceCommunity === targetCommunity) {
          continue;
        }
        const [a, b] = orderedPair(sourceCommunity, targetCommunity);
        const key = pairKey(a, b);
        const existing = between.get(key);
        if (existing) {
          existing.weight += weight;
        } else {
          between.set(key, { a, b, weight });
        }
      }
    }
    let best: { a: string; b: string; weight: number; delta: number } | null = null;
    for (const edge of between.values()) {
      const delta = edge.weight / totalWeight
        - resolution * (totalDegree.get(edge.a) ?? 0) * (totalDegree.get(edge.b) ?? 0)
          / (2 * totalWeight * totalWeight);
      if (delta > EPSILON && (!best || delta > best.delta + EPSILON
        || (Math.abs(delta - best.delta) <= EPSILON
          && compareCodeUnit(pairKey(edge.a, edge.b), pairKey(best.a, best.b)) < 0))) {
        best = { ...edge, delta };
      }
    }
    if (!best) {
      return;
    }
    const keep = best.a;
    const drop = best.b;
    for (const id of ids) {
      if (assignment.get(id) === drop) {
        assignment.set(id, keep);
      }
    }
    totalDegree.set(keep, (totalDegree.get(keep) ?? 0) + (totalDegree.get(drop) ?? 0));
    internalWeight.set(
      keep,
      (internalWeight.get(keep) ?? 0) + (internalWeight.get(drop) ?? 0) + best.weight,
    );
    totalDegree.delete(drop);
    internalWeight.delete(drop);
  }
}

/** Split a rare disconnected community caused by a bridge node moving away in a later pass. */
function connectedCommunityMembers(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  assignment: ReadonlyMap<string, string>,
): string[][] {
  const byCommunity = new Map<string, string[]>();
  for (const id of ids) {
    const community = assignment.get(id)!;
    (byCommunity.get(community) ?? byCommunity.set(community, []).get(community)!).push(id);
  }
  const result: string[][] = [];
  for (const members of byCommunity.values()) {
    const remaining = new Set(members);
    while (remaining.size > 0) {
      const start = [...remaining].sort()[0];
      const component: string[] = [];
      const queue = [start];
      remaining.delete(start);
      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        for (const neighbour of adjacency.get(current)?.keys() ?? []) {
          if (remaining.has(neighbour) && assignment.get(neighbour) === assignment.get(current)) {
            remaining.delete(neighbour);
            queue.push(neighbour);
          }
        }
      }
      result.push(component.sort());
    }
  }
  return result.sort(compareMemberSets);
}

function adjacencyFor(
  ids: readonly string[],
  inputEdges: readonly AffinityEdge[],
): Map<string, Map<string, number>> {
  const adjacency = new Map(ids.map((id) => [id, new Map<string, number>()]));
  for (const edge of inputEdges) {
    if (edge.a === edge.b || edge.weight <= 0 || !adjacency.has(edge.a) || !adjacency.has(edge.b)) {
      continue;
    }
    adjacency.get(edge.a)!.set(edge.b, (adjacency.get(edge.a)!.get(edge.b) ?? 0) + edge.weight);
    adjacency.get(edge.b)!.set(edge.a, (adjacency.get(edge.b)!.get(edge.a) ?? 0) + edge.weight);
  }
  return adjacency;
}

function neighbourCommunityWeights(
  node: string,
  adjacency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  assignment: ReadonlyMap<string, string>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [neighbour, weight] of adjacency.get(node) ?? []) {
    const community = assignment.get(neighbour)!;
    result.set(community, (result.get(community) ?? 0) + weight);
  }
  return result;
}

function communitySize(community: string, assignment: ReadonlyMap<string, string>): number {
  let count = 0;
  for (const assigned of assignment.values()) {
    if (assigned === community) {
      count += 1;
    }
  }
  return count;
}

function materializeGroups(
  mode: ServiceGroupingMode,
  memberSets: readonly string[][],
  clustering: ServiceClustering,
  vocabulary: ReadonlyMap<string, FeatureVector>,
  labelMode: ServiceGroupingLabelMode,
): ServiceNodeGroup[] {
  const documentFrequency = vocabularyDocumentFrequency(vocabulary);
  return memberSets
    .map((members) => group(
      mode,
      labelFor(members, clustering, vocabulary, documentFrequency, labelMode),
      members,
    ))
    .sort((a, b) => compareCodeUnit(a.label, b.label) || compareMemberSets(a.leadIds, b.leadIds));
}

function labelFor(
  members: readonly string[],
  clustering: ServiceClustering,
  vocabulary: ReadonlyMap<string, FeatureVector>,
  documentFrequency: ReadonlyMap<string, number>,
  labelMode: ServiceGroupingLabelMode,
): string {
  if (members.length === 1) {
    return clustering.metrics.get(members[0])?.displayName ?? members[0];
  }
  const scores = new Map<string, number>();
  const coverage = new Map<string, number>();
  for (const id of members) {
    for (const [term, weight] of vocabulary.get(id) ?? []) {
      const rarity = Math.log((vocabulary.size + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
      scores.set(term, (scores.get(term) ?? 0) + weight * rarity);
      coverage.set(term, (coverage.get(term) ?? 0) + 1);
    }
  }
  // A rare word from one class is a poor cluster name. Require a concept to appear across a
  // meaningful slice of the group, then reward coverage explicitly; this keeps generated labels
  // semantic instead of promoting one member's incidental identifier.
  const minimumCoverage = Math.max(2, Math.ceil(members.length * 0.2));
  const rankedTerms = [...scores]
    .filter(([term]) => (coverage.get(term) ?? 0) >= minimumCoverage)
    .sort((a, b) => {
      const aScore = a[1] * ((coverage.get(a[0]) ?? 0) / members.length) ** 2;
      const bScore = b[1] * ((coverage.get(b[0]) ?? 0) / members.length) ** 2;
      return bScore - aScore || compareCodeUnit(a[0], b[0]);
    });
  const terms: string[] = [];
  const stems = new Set<string>();
  const maximumTerms = labelMode === "pair" ? 2 : 1;
  for (const [term] of rankedTerms) {
    const stem = labelStem(term);
    if (stems.has(stem)) {
      continue;
    }
    stems.add(stem);
    terms.push(titleCase(term));
    if (terms.length === maximumTerms) {
      break;
    }
  }
  if (terms.length > 0) {
    return terms.join(" / ");
  }
  const commonFolder = commonFolderLabel(members, clustering);
  if (commonFolder) {
    return commonFolder;
  }
  return representativeLabel(members, clustering);
}

function representativeLabel(members: readonly string[], clustering: ServiceClustering): string {
  const memberSet = new Set(members);
  const degree = new Map(members.map((id) => [id, 0]));
  for (const coupling of clustering.couplings) {
    const source = clustering.leadOf.get(coupling.source);
    const target = clustering.leadOf.get(coupling.target);
    if (!source || !target || source === target || !memberSet.has(source) || !memberSet.has(target)) {
      continue;
    }
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  const representative = [...members].sort((a, b) =>
    (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || compareCodeUnit(a, b))[0];
  return clustering.metrics.get(representative)?.displayName ?? representative;
}

function vocabularyDocumentFrequency(
  vocabulary: ReadonlyMap<string, FeatureVector>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const vector of vocabulary.values()) {
    for (const term of vector.keys()) {
      result.set(term, (result.get(term) ?? 0) + 1);
    }
  }
  return result;
}

function commonFolderLabel(members: readonly string[], clustering: ServiceClustering): string | null {
  const domains = groupByPathDomain(members.map((id) => ({
    id,
    file: clustering.metrics.get(id)?.moduleFile,
  })));
  return domains.length === 1 ? domains[0].label : null;
}

function group(mode: ServiceGroupingMode, label: string, leadIds: readonly string[]): ServiceNodeGroup {
  const members = [...leadIds].sort();
  return {
    id: `service-group:${mode}:${stableHash(`${mode}\0${members.join("\0")}`)}`,
    mode,
    label,
    leadIds: members,
  };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sortedLeads(clusters: readonly ServiceCluster[]): string[] {
  return [...new Set(clusters.map((cluster) => cluster.leadId))].sort();
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "abstract", "add", "an", "and", "app", "application", "aria", "as", "async", "at", "backend",
  "base", "be", "boolean", "by", "class",
  "can", "cjs", "components", "const", "could", "create", "ctx", "default", "delete", "function", "get", "go",
  "handle", "id", "impl", "implementation", "index", "init", "initialize", "interface", "is", "java",
  "js", "jsx", "lib", "manager", "managers", "method", "mjs", "number", "object", "on", "package",
  "packages", "private", "promise", "props", "public", "py", "readonly", "remove", "return", "rs",
  "run", "service", "services", "set", "should", "src", "start", "static", "stop", "string", "that", "the",
  "this", "to", "for", "from", "in", "into", "of", "or", "with", "without", "ts", "tsx", "type",
  "typescript", "unknown", "update", "use", "void", "will", "would",
]);

function tokens(value: string): string[] {
  const separated = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return (separated.match(/[a-z][a-z\d]*/g) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function addWords(vector: FeatureVector, value: string): void {
  for (const token of tokens(value)) {
    addFeature(vector, token);
  }
}

function addFeature(vector: FeatureVector, feature: string, amount = 1): void {
  vector.set(feature, (vector.get(feature) ?? 0) + amount);
}

function bucket(value: number, boundaries: readonly number[]): number {
  return boundaries.findIndex((boundary) => value <= boundary) + 1 || boundaries.length + 1;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

/** Enough morphology to keep `Tool / Tools` and `Skill / Skills` from consuming both label slots. */
function labelStem(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) {
    return value.slice(0, -1);
  }
  return value;
}

function orderedPair(a: string, b: string): [string, string] {
  return compareCodeUnit(a, b) <= 0 ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  return `${a.length}:${a}${b}`;
}

function compareAffinity(a: AffinityEdge, b: AffinityEdge): number {
  return compareCodeUnit(a.a, b.a) || compareCodeUnit(a.b, b.b);
}

function compareMemberSets(a: readonly string[], b: readonly string[]): number {
  return compareCodeUnit(a[0] ?? "", b[0] ?? "") || compareCodeUnit(a.join("\0"), b.join("\0"));
}

/** Algorithm and id ordering must not depend on the browser's locale/ICU build. */
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
