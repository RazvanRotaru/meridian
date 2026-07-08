/**
 * Service-centric composition clustering: each cluster is LED by a domain service and holds the
 * helper sub-services it is composed of (its efferent dependencies — repositories/stores/mappers/…).
 * Clusters collapse to just the lead card by default; expanding reveals the sub-services it owns.
 * Inter-cluster wires read as "service A depends on service B". This replaces the by-folder tree
 * that produced a single god-service composed of everything.
 *
 * Pure: (nodes, edges, expanded) → {nodes, edges}. No React, no ELK. Emits the same spec shape as
 * compositionGraph so the ELK/React-Flow layout is unchanged.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { buildUnitIndex, computeCompositionMetrics, couplingEdges, groupMembersByUnit, type UnitMetrics } from "@meridian/design-metrics";
import { sizeFor, type ClusterNodeData, type CompEdgeSpec, type CompNodeData, type CompNodeSpec, type CompositionGraphSpec } from "./compositionGraph";

const NONE_EXPANDED: ReadonlySet<string> = new Set();

// A SERVICE lead is a class/object/module whose name reads as a domain service. Controllers/handlers
// are deliberately excluded so leads stay true services, not transport entry-points.
const SERVICE_KINDS: ReadonlySet<string> = new Set(["class", "object", "module"]);
const SERVICE_RE = /(?:service|manager|facade|orchestrator|coordinator|engine|usecase|interactor|workflow|application|app)s?$/i;
// Helper names only refine role metadata / seed selection — they never gate the clustering itself.
const HELPER_RE = /(?:store|repository|repo|dao|client|provider|adapter|mapper|model|entity|dto|cache|factory|builder|validator|serializer|parser|formatter|config|options|settings|utils?|helper|logger|queue|emitter|middleware|guard|policy|strategy)s?$/i;

export interface ServiceCluster {
  leadId: string;
  memberIds: string[];
}

/** The shared intermediate service-cluster derive: scorecard specs and the Module-map service lens
 * both read this so the ownership algorithm cannot drift between the two surfaces. */
export interface ServiceClustering {
  clusters: ServiceCluster[];
  leadOf: Map<string, string>;
  metrics: Map<string, UnitMetrics>;
  membersByUnit: Map<string, GraphNode[]>;
  couplings: ReturnType<typeof couplingEdges>;
}

export function deriveServiceCompositionGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  expanded: ReadonlySet<string> = NONE_EXPANDED,
  showMetrics = true,
): CompositionGraphSpec {
  const { clusters, leadOf, metrics, membersByUnit, couplings } = deriveServiceClusters(nodes, edges);
  if (clusters.length === 0) {
    return { nodes: [], edges: [] };
  }

  return emitSpecs(clusters, leadOf, metrics, membersByUnit, couplings, expanded, showMetrics);
}

export function deriveServiceClusters(nodes: GraphNode[], edges: GraphEdge[]): ServiceClustering {
  const metrics = computeCompositionMetrics(nodes, edges);
  const couplings = couplingEdges(nodes, edges);
  const membersByUnit = groupMembersByUnit(nodes, buildUnitIndex(nodes));
  const survivors = survivingUnits(metrics, couplings);
  if (survivors.size === 0) {
    return { clusters: [], leadOf: new Map(), metrics, membersByUnit, couplings };
  }

  const adjacency = efferentAdjacency(couplings);
  const efferentDegree = (id: string) => adjacency.get(id)?.length ?? 0;
  const seeds = selectSeeds(survivors, metrics, efferentDegree);
  const clusterOf = assignOwnership(seeds, adjacency, survivors, metrics);
  const clusters = buildClusters(seeds, clusterOf, survivors, metrics, efferentDegree);
  const leadOf = leadIndex(clusters);
  return { clusters, leadOf, metrics, membersByUnit, couplings };
}

/** Units carrying weight: ≥1 member OR sitting on ≥1 coupling wire — the only units we cluster. */
function survivingUnits(metrics: Map<string, UnitMetrics>, couplings: ReturnType<typeof couplingEdges>): Set<string> {
  const coupled = new Set<string>();
  for (const edge of couplings) {
    coupled.add(edge.source);
    coupled.add(edge.target);
  }
  const survivors = new Set<string>();
  for (const metric of metrics.values()) {
    if (metric.members > 0 || coupled.has(metric.id)) {
      survivors.add(metric.id);
    }
  }
  return survivors;
}

/** source → its efferent (depends-on) targets, skipping inheritance-only wires — the BFS graph. */
function efferentAdjacency(couplings: ReturnType<typeof couplingEdges>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of couplings) {
    if (edge.inheritanceOnly) {
      continue;
    }
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  return adjacency;
}

const isService = (metric: UnitMetrics) => SERVICE_KINDS.has(metric.kind) && SERVICE_RE.test(metric.displayName);
const isHelper = (metric: UnitMetrics) => HELPER_RE.test(metric.displayName);

/**
 * The cluster leads. Every service-named survivor seeds a cluster; if fewer than three exist we fall
 * back to the highest-fan-out non-helpers (a service by behaviour if not by name), and, failing even
 * that, the single busiest unit — so a nameless codebase still clusters around SOMETHING.
 */
function selectSeeds(survivors: Set<string>, metrics: Map<string, UnitMetrics>, degree: (id: string) => number): Set<string> {
  const seeds = new Set<string>();
  for (const id of survivors) {
    if (isService(metrics.get(id)!)) {
      seeds.add(id);
    }
  }
  if (seeds.size < 3) {
    const target = Math.min(12, Math.max(3, Math.ceil(survivors.size / 8)));
    const score = (id: string) => degree(id) * (1 + metrics.get(id)!.ca);
    const candidates = [...survivors]
      .filter((id) => !seeds.has(id) && !isHelper(metrics.get(id)!) && degree(id) >= 2)
      .sort((a, b) => score(b) - score(a) || a.localeCompare(b));
    for (const id of candidates) {
      if (seeds.size >= target) {
        break;
      }
      seeds.add(id);
    }
  }
  if (seeds.size === 0) {
    const busiest = [...survivors].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))[0];
    if (busiest) {
      seeds.add(busiest);
    }
  }
  return seeds;
}

/**
 * Multi-source BFS from all seeds at once: each non-seed survivor is claimed by the seed that reaches
 * it in the fewest hops. Seeds are terminal (we never traverse INTO another seed), so a cluster stops
 * at the next service. A tie at equal depth goes to the seed in the same folder, else the smallest id.
 * The per-node claim map doubles as the visited guard, so a coupling cycle can't loop forever.
 */
function assignOwnership(seeds: Set<string>, adjacency: Map<string, string[]>, survivors: Set<string>, metrics: Map<string, UnitMetrics>): Map<string, string> {
  const clusterOf = new Map<string, string>();
  for (const seed of seeds) {
    clusterOf.set(seed, seed);
  }
  let level = [...seeds].sort();
  while (level.length > 0) {
    const proposals = new Map<string, string[]>();
    for (const node of level) {
      const owner = clusterOf.get(node)!;
      for (const next of adjacency.get(node) ?? []) {
        if (seeds.has(next) || clusterOf.has(next) || !survivors.has(next)) {
          continue;
        }
        (proposals.get(next) ?? proposals.set(next, []).get(next)!).push(owner);
      }
    }
    const claimed: string[] = [];
    for (const [node, owners] of proposals) {
      clusterOf.set(node, pickOwner(node, owners, metrics));
      claimed.push(node);
    }
    level = claimed.sort();
  }
  return clusterOf;
}

/** Break a same-depth ownership tie: prefer a seed in the node's own folder, then the smallest id. */
function pickOwner(node: string, owners: string[], metrics: Map<string, UnitMetrics>): string {
  const nodeFolder = folderOf(metrics.get(node)!);
  return [...new Set(owners)].sort((a, b) => {
    const near = (id: string) => (folderOf(metrics.get(id)!) === nodeFolder ? 0 : 1);
    return near(a) - near(b) || a.localeCompare(b);
  })[0];
}

/** Seed clusters (lead + everything it owns) plus synthetic per-folder clusters for the survivors no
 * seed ever reached — each led by the folder's busiest member. All clusters are sorted by lead id. */
function buildClusters(seeds: Set<string>, clusterOf: Map<string, string>, survivors: Set<string>, metrics: Map<string, UnitMetrics>, degree: (id: string) => number): ServiceCluster[] {
  const bySeed = new Map<string, string[]>();
  for (const seed of seeds) {
    bySeed.set(seed, [seed]);
  }
  for (const [id, seed] of clusterOf) {
    if (id !== seed) {
      bySeed.get(seed)!.push(id);
    }
  }
  const clusters: ServiceCluster[] = [...bySeed.entries()].map(([leadId, members]) => ({ leadId, memberIds: members.slice().sort() }));

  const unreachable = [...survivors].filter((id) => !clusterOf.has(id));
  const byFolder = new Map<string, string[]>();
  for (const id of unreachable) {
    const folder = folderOf(metrics.get(id)!);
    (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(id);
  }
  for (const members of byFolder.values()) {
    const leadId = members.slice().sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))[0];
    clusters.push({ leadId, memberIds: members.slice().sort() });
  }
  return clusters.sort((a, b) => a.leadId.localeCompare(b.leadId));
}

/** Every member id → its cluster's lead id, the key the wire pass reuses for cross-boundary + rep. */
function leadIndex(clusters: ServiceCluster[]): Map<string, string> {
  const leadOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) {
      leadOf.set(id, cluster.leadId);
    }
  }
  return leadOf;
}

function emitSpecs(
  clusters: ServiceCluster[],
  leadOf: Map<string, string>,
  metrics: Map<string, UnitMetrics>,
  membersByUnit: Map<string, GraphNode[]>,
  couplings: ReturnType<typeof couplingEdges>,
  expanded: ReadonlySet<string>,
  showMetrics: boolean,
): CompositionGraphSpec {
  const frames: CompNodeSpec[] = [];
  const units: CompNodeSpec[] = [];
  for (const cluster of clusters) {
    const frameId = `svc-cluster:${cluster.leadId}`;
    const isExpanded = expanded.has(frameId);
    frames.push(frameSpec(cluster, frameId, isExpanded, metrics));
    const shown = isExpanded ? cluster.memberIds : [cluster.leadId];
    for (const id of shown) {
      units.push(unitSpec(metrics.get(id)!, membersByUnit.get(id) ?? [], showMetrics, frameId));
    }
  }
  // Frames precede units so React Flow always sees a parent ahead of its children.
  return { nodes: [...frames, ...units], edges: wireSpecs(couplings, leadOf, expanded) };
}

function frameSpec(cluster: ServiceCluster, frameId: string, isExpanded: boolean, metrics: Map<string, UnitMetrics>): CompNodeSpec {
  const smellyCount = cluster.memberIds.filter((id) => metrics.get(id)!.smells.length > 0).length;
  const data: ClusterNodeData = {
    clusterId: frameId,
    label: metrics.get(cluster.leadId)!.displayName,
    unitCount: cluster.memberIds.length,
    smellyCount,
    expanded: isExpanded,
    collapsedCount: isExpanded ? 0 : cluster.memberIds.length - 1,
    collapsible: cluster.memberIds.length > 1,
  };
  // No width/height, no parentId: ELK sizes a container from its children, and a frame is a root.
  return { id: frameId, type: "cluster", data };
}

/** A unit scorecard, shaped exactly like compositionGraph's unitNode (never a boundary ghost here). */
function unitSpec(metric: UnitMetrics, members: GraphNode[], showMetrics: boolean, frameId: string): CompNodeSpec {
  const memberList = members
    .map((member) => ({ id: member.id, name: member.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const data: CompNodeData = { unitId: metric.id, kind: metric.kind, label: metric.displayName, metrics: metric, members: memberList, boundary: false };
  const { width, height } = sizeFor(data, showMetrics);
  return { id: metric.id, type: "unit", width, height, parentId: frameId, data };
}

/**
 * One wire per visible pair. Each endpoint is lifted to its VISIBLE representative — its own card
 * when its cluster is expanded, else the cluster's lead card (the only thing painted when collapsed).
 * Self-loops (both ends land on the same card) drop out; the pair dedupes, staying inheritance-only
 * only while no concrete coupling has been seen for it. Cross-boundary tracks the true cluster of the
 * underlying units, not their reps, so it stays honest under collapse.
 */
function wireSpecs(couplings: ReturnType<typeof couplingEdges>, leadOf: Map<string, string>, expanded: ReadonlySet<string>): CompEdgeSpec[] {
  const repOf = (id: string): string | null => {
    const lead = leadOf.get(id);
    if (lead === undefined) {
      return null;
    }
    return expanded.has(`svc-cluster:${lead}`) ? id : lead;
  };
  const byPair = new Map<string, CompEdgeSpec>();
  for (const edge of couplings) {
    const source = repOf(edge.source);
    const target = repOf(edge.target);
    if (source === null || target === null || source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.inheritanceOnly = existing.inheritanceOnly && edge.inheritanceOnly;
      continue;
    }
    byPair.set(key, {
      id: `couple:${key}`,
      source,
      target,
      inheritanceOnly: edge.inheritanceOnly,
      crossBoundary: leadOf.get(edge.source) !== leadOf.get(edge.target),
    });
  }
  return [...byPair.values()];
}

/** The directory a unit lives in, from its module file — the folder-affinity tie-break + synthetic key. */
function folderOf(metric: UnitMetrics): string {
  const file = metric.moduleFile ?? "";
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
}
