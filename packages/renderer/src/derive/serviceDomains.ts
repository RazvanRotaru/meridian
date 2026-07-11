/** Artificial parent frames for the dense Service overview, assigned by the active strategy. */

import type { ServiceCluster, ServiceClustering } from "./serviceComposition";
import {
  deriveServiceNodeGroups,
  SERVICE_GROUPING_OPTIONS,
  type ServiceGroupingMode,
  type ServiceNodeGroup,
} from "./serviceClusteringModes";
import { groupByPathDomain } from "./pathDomains";
import { DEFAULT_SERVICE_GROUPING_TARGET_SIZE } from "../state/serviceGroupingTargetSize";

export const SERVICE_DOMAIN_PREFIX = "service-domain:";
/** Preserve the already-good small/scoped view; grouping solves the large-overview problem. */
export const SERVICE_DOMAIN_MIN_CLUSTERS = 12;
export const DEFAULT_SERVICE_GROUPING_MODE: ServiceGroupingMode = "folder";

export interface ServiceDomain {
  id: string;
  key: string;
  label: string;
  leadIds: string[];
  /** Distinct architectural domains importing / imported by this one. */
  ca: number;
  ce: number;
}

export interface ServiceDomainModel {
  domains: ServiceDomain[];
  domainByLead: ReadonlyMap<string, ServiceDomain>;
  domainById: ReadonlyMap<string, ServiceDomain>;
}

const modelCache = new WeakMap<ServiceClustering, Map<string, ServiceDomainModel>>();

/** Assignment comes from the FULL cached clustering, so scope/focus never changes a lead's home. */
export function deriveServiceDomains(
  clustering: ServiceClustering,
  mode: ServiceGroupingMode = DEFAULT_SERVICE_GROUPING_MODE,
  targetSize: number = DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
): ServiceDomainModel {
  const cacheKey = `${mode}:${targetSize}`;
  const cached = modelCache.get(clustering)?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const domains = domainSeeds(clustering, mode, targetSize).map((domain) => ({
    ...domain,
    ca: 0,
    ce: 0,
  }));
  const domainByLead = new Map<string, ServiceDomain>();
  const domainById = new Map<string, ServiceDomain>();
  for (const domain of domains) {
    domainById.set(domain.id, domain);
    if (isStableSemanticDomainId(domain.id)) {
      domainById.set(`${domain.id}:${encodeURIComponent(domain.label)}`, domain);
    }
    for (const leadId of domain.leadIds) {
      domainByLead.set(leadId, domain);
    }
  }
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of clustering.couplings) {
    const source = domainByLead.get(clustering.leadOf.get(edge.source) ?? "");
    const target = domainByLead.get(clustering.leadOf.get(edge.target) ?? "");
    if (!source || !target || source.id === target.id) {
      continue;
    }
    addNeighbour(outgoing, source.id, target.id);
    addNeighbour(incoming, target.id, source.id);
  }
  for (const domain of domains) {
    domain.ce = outgoing.get(domain.id)?.size ?? 0;
    domain.ca = incoming.get(domain.id)?.size ?? 0;
  }
  const model = { domains, domainByLead, domainById };
  const byMode = modelCache.get(clustering) ?? new Map<string, ServiceDomainModel>();
  byMode.set(cacheKey, model);
  modelCache.set(clustering, byMode);
  return model;
}

/** Restrict stable full-system assignments to what the current scope actually draws. */
export function visibleServiceDomains(
  clusters: readonly ServiceCluster[],
  model: ServiceDomainModel,
): ServiceDomain[] {
  const visibleLeads = new Set(clusters.map((cluster) => cluster.leadId));
  return model.domains
    .map((domain) => ({ ...domain, leadIds: domain.leadIds.filter((leadId) => visibleLeads.has(leadId)) }))
    .filter((domain) => domain.leadIds.length > 0);
}

export function isServiceDomainId(id: string): boolean {
  return id.startsWith(SERVICE_DOMAIN_PREFIX);
}

/** Human label for a stable synthetic id, usable even where only selection state is available. */
export function serviceDomainLabel(id: string): string | null {
  if (!isServiceDomainId(id)) {
    return null;
  }
  try {
    const raw = id.slice(SERVICE_DOMAIN_PREFIX.length);
    // Compatibility for links produced by the first semantic-grouping prototype, which appended
    // the label after the stable member hash. Current ids stop at the hash; their live label comes
    // from the active model so wording changes never invalidate a bookmark.
    const semantic = semanticDomainParts(raw);
    if (semantic !== null) {
      return semantic.legacyLabel === null ? null : decodeURIComponent(semantic.legacyLabel);
    }
    const key = decodeURIComponent(raw);
    return key.split("/").filter(Boolean).at(-1) ?? key;
  } catch {
    return id.slice(SERVICE_DOMAIN_PREFIX.length);
  }
}

function domainSeeds(
  clustering: ServiceClustering,
  mode: ServiceGroupingMode,
  targetSize: number,
): Array<Pick<ServiceDomain, "id" | "key" | "label" | "leadIds">> {
  if (mode === "folder") {
    return groupByPathDomain(clustering.clusters.map((cluster) => ({
      id: cluster.leadId,
      file: clustering.metrics.get(cluster.leadId)?.moduleFile,
    }))).map((domain) => ({
      id: `${SERVICE_DOMAIN_PREFIX}${encodeURIComponent(domain.key)}`,
      key: domain.key,
      label: domain.label,
      leadIds: domain.ids,
    }));
  }
  return mergeSingletonGroups(deriveServiceNodeGroups(clustering, mode, targetSize), mode).map((group) => {
    const hash = group.id.split(":").at(-1) ?? group.id;
    return {
      id: `${SERVICE_DOMAIN_PREFIX}${mode}:${hash}`,
      key: group.id,
      label: group.label,
      leadIds: group.leadIds,
    };
  });
}

function isStableSemanticDomainId(id: string): boolean {
  if (!isServiceDomainId(id)) {
    return false;
  }
  const parts = semanticDomainParts(id.slice(SERVICE_DOMAIN_PREFIX.length));
  return parts !== null && parts.legacyLabel === null;
}

function semanticDomainParts(raw: string): { mode: ServiceGroupingMode; legacyLabel: string | null } | null {
  const match = raw.match(/^([^:]+):([0-9a-f]+)(?::(.*))?$/);
  if (!match || match[1] === "folder" || !SERVICE_GROUPING_OPTIONS.some((option) => option.id === match[1])) {
    return null;
  }
  return {
    mode: match[1] as ServiceGroupingMode,
    legacyLabel: match[3] ?? null,
  };
}

/** Similarity/community modes otherwise turn every isolate into another top-level box — exactly
 * the clutter these parents are meant to remove. Keep the partition complete while folding those
 * no-evidence singletons into one honest catch-all container. */
function mergeSingletonGroups(groups: readonly ServiceNodeGroup[], mode: Exclude<ServiceGroupingMode, "folder">): ServiceNodeGroup[] {
  // Balanced cut modes already place isolates into bounded groups. Folding their rare singles into
  // a catch-all would violate the target-size contract that makes edge minimization meaningful.
  if (mode === "edge-cut" || mode === "coupling-cut") {
    return [...groups];
  }
  const singles = groups.filter((group) => group.leadIds.length === 1);
  if (singles.length < 2) {
    return [...groups];
  }
  const label = mode === "dependency"
    ? "Other dependencies"
    : mode === "leiden"
      ? "Other CPM communities"
      : mode === "bunch"
        ? "Other modules"
        : mode === "api"
          ? "Other API shapes"
          : mode === "vocabulary"
            ? "Other vocabulary"
            : "Other domains";
  const leadIds = singles.flatMap((group) => group.leadIds).sort();
  return [
    ...groups.filter((group) => group.leadIds.length > 1),
    {
      id: `service-group:${mode}:${stableGroupHash(`${mode}\0${leadIds.join("\0")}`)}`,
      mode,
      label,
      leadIds,
    },
  ].sort((a, b) => compareCodeUnit(a.label, b.label) || compareCodeUnit(a.id, b.id));
}

function stableGroupHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addNeighbour(map: Map<string, Set<string>>, source: string, target: string): void {
  const neighbours = map.get(source);
  if (neighbours) {
    neighbours.add(target);
  } else {
    map.set(source, new Set([target]));
  }
}
