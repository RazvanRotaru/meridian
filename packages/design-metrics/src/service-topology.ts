/**
 * Stable service-composition topology shared by extraction, projection transport, and rendering.
 *
 * The serialized form deliberately contains service abstractions only: cluster ownership, unit
 * metrics, the compact callable features required by grouping, and aggregated typed couplings. It
 * never embeds graph nodes, while cluster identity and coupling semantics remain authoritative for
 * the complete graph revision.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import {
  buildUnitIndex,
  couplingEdges,
  groupMembersByUnit,
  type CouplingEdge,
  type CouplingKindEvidence,
} from "./composition-graph";
import { computeCompositionMetrics, type UnitMetrics } from "./composition";

export const SERIALIZED_SERVICE_TOPOLOGY_VERSION = 1 as const;

export interface ServiceCluster {
  leadId: string;
  memberIds: string[];
  /** `unassigned` is an honest discoverability bucket, never a guessed domain service. */
  provenance: "named-service" | "inferred-service" | "unassigned";
}

export interface ServiceClustering {
  clusters: ServiceCluster[];
  leadOf: Map<string, string>;
  metrics: Map<string, UnitMetrics>;
  /** Immutable, compact grouping inputs. These are deliberately not graph nodes. */
  membersByUnit: Map<string, ServiceMemberFeature[]>;
  couplings: CouplingEdge[];
}

export interface ServiceMemberFeature {
  id: string;
  kind: string;
  displayName: string;
  qualifiedName: string;
  signature?: string;
  summary?: string;
  tags?: string[];
}

export interface SerializedServiceCoupling {
  source: string;
  target: string;
  kinds: string[];
  inheritanceOnly: boolean;
  evidenceByKind: Array<[string, CouplingKindEvidence]>;
}

export interface SerializedServiceCluster {
  leadId: string;
  memberIds: string[];
  provenance: "named-service" | "inferred-service" | "unassigned";
}

export interface SerializedServiceTopologyV1 {
  version: typeof SERIALIZED_SERVICE_TOPOLOGY_VERSION;
  clusters: SerializedServiceCluster[];
  metrics: UnitMetrics[];
  featuresByUnit: Array<[string, ServiceMemberFeature[]]>;
  couplings: SerializedServiceCoupling[];
}

// Controllers/handlers remain transport entry points rather than service leads.
const SERVICE_KINDS: ReadonlySet<string> = new Set(["class", "object", "module"]);
const SERVICE_RE = /(?:service|manager|facade|orchestrator|coordinator|engine|usecase|interactor|workflow|application|app|framework|container|registry)s?$/i;
const HELPER_RE = /(?:store|repository|repo|dao|client|provider|adapter|mapper|model|entity|dto|cache|factory|builder|validator|serializer|parser|formatter|config|options|settings|utils?|helper|logger|queue|emitter|middleware|guard|policy|strategy)s?$/i;

const COMPOSITION_OWNERSHIP_KINDS: ReadonlySet<string> = new Set([
  "registers",
  "binds",
  "provides",
  "injects",
  "owns",
  "aliases",
  "instantiates",
]);

export function isUnassignedServiceCluster(cluster: ServiceCluster): boolean {
  return cluster.provenance === "unassigned";
}

export function serviceClusterCount(clustering: ServiceClustering): number {
  return clustering.clusters.filter((cluster) => !isUnassignedServiceCluster(cluster)).length;
}

/** Derive the complete service abstraction once while the full graph is already available. */
export function deriveServiceClusters(nodes: GraphNode[], edges: GraphEdge[]): ServiceClustering {
  const metrics = computeCompositionMetrics(nodes, edges);
  const couplings = couplingEdges(nodes, edges);
  const membersByUnit = serviceMemberFeatures(nodes);
  const survivors = survivingUnits(metrics, couplings);
  if (survivors.size === 0) {
    return { clusters: [], leadOf: new Map(), metrics, membersByUnit, couplings };
  }

  const adjacency = efferentAdjacency(couplings);
  const efferentDegree = (id: string) => adjacency.get(id)?.length ?? 0;
  const seeds = selectSeeds(survivors, metrics, efferentDegree);
  const clusterOf = assignOwnership(seeds, adjacency, survivors, metrics);
  const clusters = buildClusters(seeds, clusterOf, survivors, metrics, efferentDegree);
  return { clusters, leadOf: leadIndex(clusters), metrics, membersByUnit, couplings };
}

/** Canonical JSON form: every collection is sorted, and Maps/Sets become validated arrays. */
export function serializeServiceTopology(
  clustering: ServiceClustering,
): SerializedServiceTopologyV1 {
  // Units outside every service cluster are not renderable in the Service view. Omitting their
  // metrics/empty feature lists keeps this a view fact rather than a second whole-graph inventory.
  const clusteredUnitIds = new Set(clustering.clusters.flatMap((cluster) => cluster.memberIds));
  const topology: SerializedServiceTopologyV1 = {
    version: SERIALIZED_SERVICE_TOPOLOGY_VERSION,
    clusters: clustering.clusters
      .map((cluster) => ({
        leadId: cluster.leadId,
        memberIds: [...new Set(cluster.memberIds)].sort(compareText),
        provenance: cluster.provenance,
      }))
      .sort((left, right) => compareText(left.leadId, right.leadId)),
    metrics: [...clustering.metrics.values()]
      .filter((metric) => clusteredUnitIds.has(metric.id))
      .map((metric) => ({ ...metric, smells: [...new Set(metric.smells)].sort(compareText) }))
      .sort((left, right) => compareText(left.id, right.id)),
    featuresByUnit: [...clustering.membersByUnit]
      .filter(([unitId]) => clusteredUnitIds.has(unitId))
      .map(([unitId, features]) => [unitId, features
        .map(copyMemberFeature)
        .sort((left, right) => compareText(left.id, right.id))] as [string, ServiceMemberFeature[]])
      .sort(([left], [right]) => compareText(left, right)),
    couplings: clustering.couplings
      .map((coupling) => ({
        source: coupling.source,
        target: coupling.target,
        kinds: [...coupling.kinds].sort(compareText),
        inheritanceOnly: coupling.inheritanceOnly,
        evidenceByKind: [...(coupling.evidenceByKind ?? new Map<string, CouplingKindEvidence>())]
          .map(([kind, evidence]) => [kind, {
            weight: evidence.weight,
            underlyingEdgeIds: [...new Set(evidence.underlyingEdgeIds)].sort(compareText),
          }] as [string, CouplingKindEvidence])
          .sort(([left], [right]) => compareText(left, right)),
      }))
      .sort(compareSerializedCoupling),
  };
  // Serialization is itself a trust boundary: callers cannot accidentally persist a malformed
  // abstraction that the reader would later reject.
  return parseSerializedServiceTopology(topology);
}

export function deriveSerializedServiceTopology(
  nodes: GraphNode[],
  edges: GraphEdge[],
): SerializedServiceTopologyV1 {
  return serializeServiceTopology(deriveServiceClusters(nodes, edges));
}

/** Restore Maps/Sets from the immutable full-revision service abstraction. */
export function hydrateServiceTopology(
  topology: SerializedServiceTopologyV1,
): ServiceClustering {
  const parsed = parseSerializedServiceTopology(topology);
  // Keep the validated compact records as the backing storage. Hydration adds only the lookup
  // indexes and Set/Map views required by grouping; it must not duplicate every member feature.
  const clusters: ServiceCluster[] = parsed.clusters;
  const metrics = new Map(parsed.metrics.map((metric) => [metric.id, metric]));
  const couplings: CouplingEdge[] = parsed.couplings.map((coupling) => ({
    source: coupling.source,
    target: coupling.target,
    kinds: new Set(coupling.kinds),
    inheritanceOnly: coupling.inheritanceOnly,
    evidenceByKind: new Map(coupling.evidenceByKind.map(([kind, evidence]) => [kind, {
      weight: evidence.weight,
      underlyingEdgeIds: evidence.underlyingEdgeIds,
    }])),
  }));
  return {
    clusters,
    leadOf: leadIndex(clusters),
    metrics,
    membersByUnit: new Map(parsed.featuresByUnit),
    couplings,
  };
}

/** Strict parser shared by the disk bundle and browser transport boundary. */
export function parseSerializedServiceTopology(value: unknown): SerializedServiceTopologyV1 {
  if (!isRecord(value) || exactKeys(value, ["version", "clusters", "metrics", "featuresByUnit", "couplings"]) === false
    || value.version !== SERIALIZED_SERVICE_TOPOLOGY_VERSION
    || !Array.isArray(value.clusters) || !value.clusters.every(isSerializedCluster)
    || !Array.isArray(value.metrics) || !value.metrics.every(isUnitMetrics)
    || !Array.isArray(value.featuresByUnit) || !value.featuresByUnit.every(isSerializedFeatureEntry)
    || !Array.isArray(value.couplings) || !value.couplings.every(isSerializedCoupling)) {
    throw new TypeError("invalid serialized service topology");
  }
  const topology = value as unknown as SerializedServiceTopologyV1;
  assertCanonicalTopology(topology);
  return topology;
}

function survivingUnits(metrics: ReadonlyMap<string, UnitMetrics>, couplings: readonly CouplingEdge[]): Set<string> {
  const coupled = new Set<string>();
  for (const edge of couplings) {
    coupled.add(edge.source);
    coupled.add(edge.target);
  }
  return new Set([...metrics.values()]
    .filter((metric) => metric.members > 0 || coupled.has(metric.id))
    .map((metric) => metric.id));
}

function efferentAdjacency(couplings: readonly CouplingEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of couplings) {
    if (![...edge.kinds].some((kind) => COMPOSITION_OWNERSHIP_KINDS.has(kind))) continue;
    const targets = adjacency.get(edge.source) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);
  }
  return adjacency;
}

const isService = (metric: UnitMetrics): boolean => SERVICE_KINDS.has(metric.kind) && SERVICE_RE.test(metric.displayName);
const isHelper = (metric: UnitMetrics): boolean => HELPER_RE.test(metric.displayName);

function selectSeeds(
  survivors: ReadonlySet<string>,
  metrics: ReadonlyMap<string, UnitMetrics>,
  degree: (id: string) => number,
): Set<string> {
  const seeds = new Set([...survivors].filter((id) => isService(metrics.get(id)!)));
  if (seeds.size < 3) {
    const target = Math.min(12, Math.max(3, Math.ceil(survivors.size / 8)));
    const score = (id: string) => degree(id) * (1 + metrics.get(id)!.ca);
    const candidates = [...survivors]
      .filter((id) => !seeds.has(id) && !isHelper(metrics.get(id)!) && degree(id) >= 2)
      .sort((left, right) => score(right) - score(left) || compareText(left, right));
    for (const id of candidates) {
      if (seeds.size >= target) break;
      seeds.add(id);
    }
  }
  if (seeds.size === 0) {
    const busiest = [...survivors].sort((left, right) => degree(right) - degree(left) || compareText(left, right))[0];
    if (busiest !== undefined) seeds.add(busiest);
  }
  return seeds;
}

function assignOwnership(
  seeds: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, string[]>,
  survivors: ReadonlySet<string>,
  metrics: ReadonlyMap<string, UnitMetrics>,
): Map<string, string> {
  const clusterOf = new Map([...seeds].map((seed) => [seed, seed]));
  let level = [...seeds].sort(compareText);
  while (level.length > 0) {
    const proposals = new Map<string, string[]>();
    for (const node of level) {
      const owner = clusterOf.get(node)!;
      for (const next of adjacency.get(node) ?? []) {
        if (seeds.has(next) || clusterOf.has(next) || !survivors.has(next)) continue;
        const owners = proposals.get(next) ?? [];
        owners.push(owner);
        proposals.set(next, owners);
      }
    }
    const claimed: string[] = [];
    for (const [node, owners] of proposals) {
      clusterOf.set(node, pickOwner(node, owners, metrics));
      claimed.push(node);
    }
    level = claimed.sort(compareText);
  }
  return clusterOf;
}

function pickOwner(node: string, owners: string[], metrics: ReadonlyMap<string, UnitMetrics>): string {
  const nodeFolder = folderOf(metrics.get(node)!);
  return [...new Set(owners)].sort((left, right) => {
    const near = (id: string) => folderOf(metrics.get(id)!) === nodeFolder ? 0 : 1;
    return near(left) - near(right) || compareText(left, right);
  })[0]!;
}

function buildClusters(
  seeds: ReadonlySet<string>,
  clusterOf: ReadonlyMap<string, string>,
  survivors: ReadonlySet<string>,
  metrics: ReadonlyMap<string, UnitMetrics>,
  degree: (id: string) => number,
): ServiceCluster[] {
  const bySeed = new Map([...seeds].map((seed) => [seed, [seed]]));
  for (const [id, seed] of clusterOf) {
    if (id !== seed) bySeed.get(seed)!.push(id);
  }
  const clusters: ServiceCluster[] = [...bySeed].map(([leadId, members]) => ({
    leadId,
    memberIds: members.sort(compareText),
    provenance: isService(metrics.get(leadId)!) ? "named-service" : "inferred-service",
  }));
  const byFolder = new Map<string, string[]>();
  for (const id of [...survivors].filter((candidate) => !clusterOf.has(candidate))) {
    const folder = folderOf(metrics.get(id)!);
    const members = byFolder.get(folder) ?? [];
    members.push(id);
    byFolder.set(folder, members);
  }
  for (const members of byFolder.values()) {
    const leadId = [...members].sort((left, right) => degree(right) - degree(left) || compareText(left, right))[0]!;
    clusters.push({ leadId, memberIds: members.sort(compareText), provenance: "unassigned" });
  }
  return clusters.sort((left, right) => compareText(left.leadId, right.leadId));
}

function leadIndex(clusters: readonly ServiceCluster[]): Map<string, string> {
  const leadOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.memberIds) leadOf.set(id, cluster.leadId);
  }
  return leadOf;
}

function folderOf(metric: UnitMetrics): string {
  const slash = metric.moduleFile.lastIndexOf("/");
  return slash === -1 ? "" : metric.moduleFile.slice(0, slash);
}

function compareSerializedCoupling(left: SerializedServiceCoupling, right: SerializedServiceCoupling): number {
  return compareText(left.source, right.source)
    || compareText(left.target, right.target)
    || compareText(left.kinds.join("\0"), right.kinds.join("\0"));
}

function assertCanonicalTopology(topology: SerializedServiceTopologyV1): void {
  const clusterIds = topology.clusters.map((cluster) => cluster.leadId);
  const metricIds = topology.metrics.map((metric) => metric.id);
  const featureUnitIds = topology.featuresByUnit.map(([unitId]) => unitId);
  if (!isStrictlySortedUnique(clusterIds) || !isStrictlySortedUnique(metricIds)
    || !isStrictlySortedUnique(featureUnitIds)) {
    throw new TypeError("serialized service topology collections must be sorted and unique");
  }
  if (!sameStrings(metricIds, featureUnitIds)) {
    throw new TypeError("serialized service topology must provide one feature list per metric unit");
  }
  const metricIdSet = new Set(metricIds);
  const metricById = new Map(topology.metrics.map((metric) => [metric.id, metric]));
  const members = new Set<string>();
  for (const cluster of topology.clusters) {
    if (!isSortedUnique(cluster.memberIds) || !cluster.memberIds.includes(cluster.leadId)) {
      throw new TypeError("serialized service cluster members must be canonical");
    }
    for (const id of cluster.memberIds) {
      if (!metricIdSet.has(id)) throw new TypeError("serialized service cluster references an unknown unit");
      if (members.has(id)) throw new TypeError("serialized service clusters must be disjoint");
      members.add(id);
    }
  }
  for (const metric of topology.metrics) {
    if (!isSortedUnique(metric.smells)) {
      throw new TypeError("serialized service metric smells must be canonical");
    }
  }
  const featureIds = new Set<string>();
  for (const [unitId, features] of topology.featuresByUnit) {
    if (!isSortedUnique(features.map((feature) => feature.id))) {
      throw new TypeError("serialized service member features must be canonical");
    }
    if (features.length !== metricById.get(unitId)!.members) {
      throw new TypeError("serialized service member feature counts must match unit metrics");
    }
    for (const feature of features) {
      if (featureIds.has(feature.id)) {
        throw new TypeError("serialized service member features must belong to one unit");
      }
      featureIds.add(feature.id);
      if (feature.tags !== undefined && !isSortedUnique(feature.tags)) {
        throw new TypeError("serialized service member feature tags must be canonical");
      }
    }
  }
  const couplingKeys = topology.couplings.map((coupling) => `${coupling.source}\0${coupling.target}`);
  if (!isStrictlySortedUnique(couplingKeys)) {
    throw new TypeError("serialized service couplings must be canonical");
  }
  for (const coupling of topology.couplings) {
    if (!metricIdSet.has(coupling.source) || !metricIdSet.has(coupling.target)
      || coupling.source === coupling.target || coupling.kinds.length === 0
      || !isSortedUnique(coupling.kinds)) {
      throw new TypeError("serialized service coupling references must be canonical");
    }
    const inheritanceOnly = coupling.kinds.every((kind) => kind === "extends" || kind === "implements");
    if (coupling.inheritanceOnly !== inheritanceOnly) {
      throw new TypeError("serialized service coupling inheritance classification is inconsistent");
    }
    const kindSet = new Set(coupling.kinds);
    const evidenceKinds = coupling.evidenceByKind.map(([kind]) => kind);
    if (!isSortedUnique(evidenceKinds) || evidenceKinds.some((kind) => !kindSet.has(kind))) {
      throw new TypeError("serialized service coupling evidence must be canonical");
    }
    for (const [, evidence] of coupling.evidenceByKind) {
      if (!isSortedUnique(evidence.underlyingEdgeIds)) {
        throw new TypeError("serialized service coupling evidence ids must be canonical");
      }
    }
  }
}

function isSerializedCluster(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["leadId", "memberIds", "provenance"])) return false;
  return isId(value.leadId)
    && Array.isArray(value.memberIds) && value.memberIds.every(isId)
    && (value.provenance === "named-service" || value.provenance === "inferred-service" || value.provenance === "unassigned");
}

function isUnitMetrics(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "kind", "displayName", "moduleFile", "members", "cohesion", "lcomComponents",
    "ce", "ca", "instability", "abstractness", "distance", "externalFanout", "smells",
  ])) return false;
  return isId(value.id) && isId(value.kind) && isString(value.displayName) && isString(value.moduleFile)
    && ["members", "lcomComponents", "ce", "ca", "externalFanout"].every((key) => isNonNegativeInteger(value[key]))
    && ["cohesion", "instability", "abstractness", "distance"].every((key) => isFiniteNonNegative(value[key]))
    && Array.isArray(value.smells) && value.smells.every((smell) =>
      smell === "god-module" || smell === "zone-of-pain" || smell === "zone-of-uselessness" || smell === "low-cohesion");
}

function isSerializedCoupling(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["source", "target", "kinds", "inheritanceOnly", "evidenceByKind"])) return false;
  if (!isId(value.source) || !isId(value.target) || typeof value.inheritanceOnly !== "boolean"
    || !Array.isArray(value.kinds) || !value.kinds.every(isId)
    || !Array.isArray(value.evidenceByKind)) return false;
  return value.evidenceByKind.every((entry) => Array.isArray(entry) && entry.length === 2
    && isId(entry[0]) && isRecord(entry[1]) && exactKeys(entry[1], ["weight", "underlyingEdgeIds"])
    && typeof entry[1].weight === "number" && Number.isFinite(entry[1].weight) && entry[1].weight >= 0
    && Array.isArray(entry[1].underlyingEdgeIds) && entry[1].underlyingEdgeIds.every(isId));
}

function isSerializedFeatureEntry(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && isId(value[0])
    && Array.isArray(value[1]) && value[1].every(isServiceMemberFeature);
}

function isServiceMemberFeature(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "kind", "displayName", "qualifiedName", "signature", "summary", "tags"]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || !isId(value.id) || !isId(value.kind) || !isString(value.displayName)
    || !isString(value.qualifiedName)
    || (value.signature !== undefined && !isString(value.signature))
    || (value.summary !== undefined && !isString(value.summary))
    || (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every(isString)))) {
    return false;
  }
  return true;
}

function serviceMemberFeatures(nodes: GraphNode[]): Map<string, ServiceMemberFeature[]> {
  const grouped = groupMembersByUnit(nodes, buildUnitIndex(nodes));
  return new Map([...grouped].map(([unitId, members]) => [
    unitId,
    members.map((member) => copyMemberFeature({
      id: member.id,
      kind: member.kind,
      displayName: member.displayName,
      qualifiedName: member.qualifiedName,
      ...(member.signature === undefined ? {} : { signature: member.signature }),
      ...(member.summary == null ? {} : { summary: member.summary }),
      ...(member.tags === undefined ? {} : { tags: member.tags }),
    })),
  ]));
}

function copyMemberFeature(feature: ServiceMemberFeature): ServiceMemberFeature {
  return {
    id: feature.id,
    kind: feature.kind,
    displayName: feature.displayName,
    qualifiedName: feature.qualifiedName,
    ...(feature.signature === undefined ? {} : { signature: feature.signature }),
    ...(feature.summary === undefined ? {} : { summary: feature.summary }),
    ...(feature.tags === undefined ? {} : { tags: [...new Set(feature.tags)].sort(compareText) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isString(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return isSortedUnique(values);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Locale-independent ordering keeps bundle digests stable across hosts. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
