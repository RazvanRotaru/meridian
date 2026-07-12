/**
 * Paint-time parent grouping for the exact ghost cards that survived emphasis/filtering. Canonical
 * derivation keeps every real id and evidence wire. This transform replaces a crowd of four or
 * more immediate siblings with ONE persistent parent anchor, shared by incoming and outgoing
 * lanes. Expanding keeps that parent anchor, restores the exact children, and adds neutral,
 * presentation-only hierarchy spokes for placement.
 */

import type { Edge, Node } from "@xyflow/react";
import type { GraphIndex } from "../graph/graphIndex";
import type { GhostData } from "./ghostDeps";

export const MAX_UNGROUPED_GHOST_SIBLINGS = 3;

export type GhostGroupDirection = "incoming" | "outgoing";

export type GhostGroupData = GhostData & Record<string, unknown> & {
  /** The REAL parent artifact id. It is also the persistent parent card's React Flow id. */
  ghostGroupId: string;
  ghostParentId: string;
  ghostParentLabel: string;
  ghostParentKind: string;
  ghostRole: "parent-anchor";
  /** A real GraphIndex artifact id is always safe to pass through main's promotion path. */
  ghostPromotable: true;
  ghostExpanded: boolean;
  /** Every qualifying lane represented by this one parent card. */
  ghostDirections: GhostGroupDirection[];
  /** Deterministic placement hint: outgoing/right wins when the parent represents both lanes. */
  ghostDirection: GhostGroupDirection;
  groupedGhostIds: string[];
  groupedGhostCount: number;
};

export interface LitGhostGroupingOptions {
  enabled: boolean;
  /** Parent artifact ids whose exact children should be disclosed. */
  expandedGroupIds: ReadonlySet<string>;
  /** Exact ghosts that must remain independently addressable (selection beacons, inspectors, etc.). */
  protectedGhostIds?: ReadonlySet<string>;
}

export interface GroupedLitGhosts {
  nodes: Node[];
  edges: Edge[];
}

interface DirectionBucket {
  parentId: string;
  direction: GhostGroupDirection;
  members: Node[];
}

interface ParentGroup {
  parentId: string;
  buckets: DirectionBucket[];
  members: Map<string, { node: Node; directions: Set<GhostGroupDirection> }>;
  expanded: boolean;
}

interface DirectionalRewrite {
  incoming: Map<string, string>;
  outgoing: Map<string, string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const KEY_SEPARATOR = "\u0000";

/** Kept with the historical two-argument signature for paint/test callers. Parent identity is now
 * deliberately direction-independent, so both calls return the same real artifact id. */
export function ghostGroupId(_direction: GhostGroupDirection, parentId: string): string {
  return parentId;
}

export function groupLitGhosts(
  nodes: Node[],
  edges: Edge[],
  index: GraphIndex,
  options: LitGhostGroupingOptions,
): GroupedLitGhosts {
  if (!options.enabled) return { nodes, edges };

  const exactGhosts = new Map(nodes.filter(isExactGhost).map((node) => [node.id, node] as const));
  if (exactGhosts.size === 0) return { nodes, edges };

  const nonGhostIds = new Set(nodes.filter((node) => node.type !== "ghost").map((node) => node.id));
  const protectedIds = options.protectedGhostIds ?? EMPTY_IDS;
  const buckets = [...directionalCandidates(edges, exactGhosts, index, nonGhostIds, protectedIds).values()]
    .filter((bucket) => bucket.members.length > MAX_UNGROUPED_GHOST_SIBLINGS)
    .sort(compareBuckets);
  if (buckets.length === 0) return { nodes, edges };

  const groups = parentGroups(buckets, options.expandedGroupIds);
  const groupParentIds = new Set(groups.keys());
  const rewrite: DirectionalRewrite = { incoming: new Map(), outgoing: new Map() };
  for (const bucket of buckets) {
    for (const member of bucket.members) rewrite[bucket.direction].set(member.id, bucket.parentId);
  }

  const expandedMemberOf = expandedMembers(groups);
  const evidenceEdges = rewriteAndAggregateEvidence(edges, exactGhosts, rewrite, groupParentIds);
  const hierarchyEdges = expandedHierarchyEdges(groups);
  const existingParents = new Set(nodes.filter((node) => node.type === "ghost" && groupParentIds.has(node.id)).map((node) => node.id));

  const presentedNodes: Node[] = [];
  for (const node of nodes) {
    const group = groups.get(node.id);
    if (node.type === "ghost" && group !== undefined) {
      presentedNodes.push(parentNode(group, index, node));
      continue;
    }
    if (!exactGhosts.has(node.id)) {
      presentedNodes.push(node);
      continue;
    }
    const expandedMember = expandedMemberOf.get(node.id);
    if (expandedMember !== undefined) {
      presentedNodes.push(decorateExpandedMember(node, expandedMember.parentId, expandedMember.directions));
      continue;
    }
    if (exactGhostMustRemain(node.id, edges, exactGhosts, rewrite, groupParentIds)) presentedNodes.push(node);
  }
  for (const group of [...groups.values()].sort((a, b) => a.parentId.localeCompare(b.parentId))) {
    if (!existingParents.has(group.parentId)) presentedNodes.push(parentNode(group, index));
  }

  return { nodes: presentedNodes, edges: [...evidenceEdges, ...hierarchyEdges] };
}

/** One unique candidate per exact child, immediate parent and direction. A parent already drawn as
 * a real core node is a collision, not a ghost context card, so that bucket remains exact. */
function directionalCandidates(
  edges: readonly Edge[],
  ghosts: ReadonlyMap<string, Node>,
  index: GraphIndex,
  nonGhostIds: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
): Map<string, DirectionBucket> {
  const buckets = new Map<string, DirectionBucket>();
  const seenMembers = new Set<string>();
  for (const edge of edges) {
    const sourceGhost = ghosts.get(edge.source);
    const targetGhost = ghosts.get(edge.target);
    if ((sourceGhost === undefined) === (targetGhost === undefined)) continue;
    const ghost = sourceGhost ?? targetGhost!;
    if (protectedIds.has(ghost.id) || ghostDataOf(ghost).beacon === true) continue;
    const parentId = index.parentOf.get(ghost.id) ?? null;
    if (parentId === null || !index.nodesById.has(parentId) || nonGhostIds.has(parentId)) continue;
    const direction: GhostGroupDirection = sourceGhost ? "incoming" : "outgoing";
    const key = bucketKey(direction, parentId);
    const memberKey = `${key}${KEY_SEPARATOR}${ghost.id}`;
    if (seenMembers.has(memberKey)) continue;
    seenMembers.add(memberKey);
    const bucket = buckets.get(key) ?? { parentId, direction, members: [] };
    bucket.members.push(ghost);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.members.sort((a, b) => a.id.localeCompare(b.id));
  return buckets;
}

function parentGroups(
  buckets: readonly DirectionBucket[],
  expandedIds: ReadonlySet<string>,
): Map<string, ParentGroup> {
  const groups = new Map<string, ParentGroup>();
  for (const bucket of buckets) {
    const group: ParentGroup = groups.get(bucket.parentId) ?? {
      parentId: bucket.parentId,
      buckets: [],
      members: new Map(),
      expanded: expandedIds.has(bucket.parentId),
    };
    group.buckets.push(bucket);
    for (const node of bucket.members) {
      const member = group.members.get(node.id) ?? { node, directions: new Set<GhostGroupDirection>() };
      member.directions.add(bucket.direction);
      group.members.set(node.id, member);
    }
    groups.set(bucket.parentId, group);
  }
  return groups;
}

function expandedMembers(groups: ReadonlyMap<string, ParentGroup>): Map<string, { parentId: string; directions: GhostGroupDirection[] }> {
  const members = new Map<string, { parentId: string; directions: GhostGroupDirection[] }>();
  for (const group of groups.values()) {
    if (!group.expanded) continue;
    for (const [id, member] of group.members) {
      members.set(id, { parentId: group.parentId, directions: sortedDirections(member.directions) });
    }
  }
  return members;
}

function parentNode(group: ParentGroup, index: GraphIndex, existing?: Node): Node {
  const parent = index.nodesById.get(group.parentId)!;
  const representative = existing ?? [...group.members.values()].sort((a, b) => a.node.id.localeCompare(b.node.id))[0].node;
  const existingData = existing === undefined ? null : ghostDataOf(existing);
  const parentLabel = existingData?.label || parent.displayName || parent.qualifiedName || parent.id;
  const directions = sortedDirections(new Set(group.buckets.map((bucket) => bucket.direction)));
  const semanticMembers = [...group.members.values()]
    .sort((a, b) => a.node.id.localeCompare(b.node.id))
    .map(({ node }) => ({ id: node.id, data: semanticSummary(node) }));
  const ghostInspectionPath = [...group.members.values()].some(({ node }) =>
    (node.data as { ghostInspectionPath?: unknown }).ghostInspectionPath === true);
  const data: GhostGroupData = {
    ...(existingData ?? { label: parentLabel, context: "", ghostKind: parent.kind }),
    label: parentLabel,
    context: `${semanticMembers.length} related symbols`,
    ghostKind: existingData?.ghostKind ?? parent.kind,
    semanticMembers,
    ghostGroupId: parent.id,
    ghostParentId: parent.id,
    ghostParentLabel: parentLabel,
    ghostParentKind: parent.kind,
    ghostRole: "parent-anchor",
    ghostPromotable: true,
    ghostExpanded: group.expanded,
    ghostDirections: directions,
    ghostDirection: preferredDirection(directions),
    groupedGhostIds: semanticMembers.map((member) => member.id),
    groupedGhostCount: semanticMembers.length,
    ...(ghostInspectionPath ? { ghostInspectionPath: true } : {}),
  };
  return {
    ...representative,
    id: parent.id,
    type: "ghost",
    parentId: undefined,
    data,
    position: { ...representative.position },
    ...(representative.style === undefined ? {} : { style: { ...representative.style } }),
  };
}

function decorateExpandedMember(node: Node, parentId: string, directions: GhostGroupDirection[]): Node {
  return {
    ...node,
    data: {
      ...node.data,
      ghostHierarchyMember: true,
      ghostGroupParentId: parentId,
      ghostHierarchyDirections: directions,
      ghostDirection: preferredDirection(directions),
    },
  };
}

/** An exact child survives when expanded, protected, needed by an ungrouped opposite direction, or
 * itself serving as another persistent parent anchor. */
function exactGhostMustRemain(
  ghostId: string,
  edges: readonly Edge[],
  ghosts: ReadonlyMap<string, Node>,
  rewrite: DirectionalRewrite,
  groupParentIds: ReadonlySet<string>,
): boolean {
  if (groupParentIds.has(ghostId)) return true;
  let incident = false;
  for (const edge of edges) {
    const sourceGhost = ghosts.has(edge.source);
    const targetGhost = ghosts.has(edge.target);
    if (edge.source !== ghostId && edge.target !== ghostId) continue;
    incident = true;
    if (sourceGhost === targetGhost) return true;
    if (edge.source === ghostId && !rewrite.incoming.has(ghostId)) return true;
    if (edge.target === ghostId && !rewrite.outgoing.has(ghostId)) return true;
  }
  return !incident;
}

/** Original evidence always terminates at the persistent parent in both states. Existing exact
 * parent evidence joins rewritten member evidence under the same (source,target,kind) aggregate. */
function rewriteAndAggregateEvidence(
  edges: readonly Edge[],
  ghosts: ReadonlyMap<string, Node>,
  rewrite: DirectionalRewrite,
  groupParentIds: ReadonlySet<string>,
): Edge[] {
  const output: Edge[] = [];
  const aggregateIndex = new Map<string, number>();
  for (const edge of edges) {
    const sourceGhost = ghosts.has(edge.source);
    const targetGhost = ghosts.has(edge.target);
    const source = sourceGhost && !targetGhost ? (rewrite.incoming.get(edge.source) ?? edge.source) : edge.source;
    const target = targetGhost && !sourceGhost ? (rewrite.outgoing.get(edge.target) ?? edge.target) : edge.target;
    const rewritten = source !== edge.source || target !== edge.target;
    const touchesParent = groupParentIds.has(source) || groupParentIds.has(target);
    if (!rewritten && !touchesParent) {
      output.push(edge);
      continue;
    }
    const kind = relationshipKind(edge);
    const key = [source, target, kind].join(KEY_SEPARATOR);
    const at = aggregateIndex.get(key);
    if (at === undefined) {
      aggregateIndex.set(key, output.length);
      const groupedGhostId = rewritten ? (source !== edge.source ? edge.source : edge.target) : null;
      output.push({
        ...edge,
        id: groupedEvidenceEdgeId(source, target, kind),
        source,
        target,
        data: cloneEdgeData(edge, groupedGhostId),
        ...(edge.style === undefined ? {} : { style: { ...edge.style } }),
      });
    } else {
      const groupedGhostId = rewritten ? (source !== edge.source ? edge.source : edge.target) : null;
      output[at] = mergeEvidenceEdge(output[at], edge, groupedGhostId);
    }
  }
  return output;
}

function mergeEvidenceEdge(existing: Edge, incoming: Edge, incomingGroupedGhostId: string | null): Edge {
  const existingData = dataOf(existing);
  const incomingData = dataOf(incoming);
  const underlyingEdgeIds = uniqueSorted([
    ...stringArray(existingData.underlyingEdgeIds),
    ...stringArray(incomingData.underlyingEdgeIds),
  ]);
  const groupedGhostIds = uniqueSorted([
    ...stringArray(existingData.groupedGhostIds),
    ...(incomingGroupedGhostId === null ? [] : [incomingGroupedGhostId]),
  ]);
  return {
    ...existing,
    data: {
      ...existingData,
      weight: numberOf(existingData.weight, 1) + numberOf(incomingData.weight, 1),
      crossPackage: existingData.crossPackage === true || incomingData.crossPackage === true,
      outsideView: existingData.outsideView === true || incomingData.outsideView === true,
      ...(underlyingEdgeIds.length > 0 ? { underlyingEdgeIds } : {}),
      ...(groupedGhostIds.length > 0
        ? { ghostGroupAggregate: true, groupedGhostIds, groupedGhostCount: groupedGhostIds.length }
        : {}),
      ...(existingData.ghostInspectionPath === true || incomingData.ghostInspectionPath === true
        ? { ghostInspectionPath: true }
        : {}),
    },
    style: existing.style ?? incoming.style,
    markerStart: existing.markerStart ?? incoming.markerStart,
    markerEnd: existing.markerEnd ?? incoming.markerEnd,
    type: existing.type ?? incoming.type,
    animated: existing.animated === true || incoming.animated === true,
  };
}

function expandedHierarchyEdges(groups: ReadonlyMap<string, ParentGroup>): Edge[] {
  const hierarchy: Edge[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.parentId.localeCompare(b.parentId))) {
    if (!group.expanded) continue;
    for (const [memberId, member] of [...group.members].sort(([a], [b]) => a.localeCompare(b))) {
      const directions = sortedDirections(member.directions);
      hierarchy.push(hierarchyEdge(group.parentId, memberId, preferredDirection(directions), directions));
    }
  }
  return hierarchy;
}

function hierarchyEdge(
  parentId: string,
  memberId: string,
  direction: GhostGroupDirection,
  directions: GhostGroupDirection[],
): Edge {
  const source = direction === "outgoing" ? parentId : memberId;
  const target = direction === "outgoing" ? memberId : parentId;
  return {
    id: `ghost-hierarchy:${direction}:${source}->${target}`,
    source,
    target,
    type: "ghostHierarchy",
    animated: false,
    selectable: false,
    focusable: false,
    interactionWidth: 0,
    data: {
      edgeRole: "ghost-hierarchy",
      ghostHierarchy: true,
      presentationOnly: true,
      ghostGroupId: parentId,
      ghostParentId: parentId,
      ghostMemberId: memberId,
      ghostDirection: direction,
      ghostHierarchyDirections: directions,
    },
  };
}

function cloneEdgeData(edge: Edge, groupedGhostId: string | null): Record<string, unknown> {
  const data = dataOf(edge);
  const underlyingEdgeIds = uniqueSorted(stringArray(data.underlyingEdgeIds));
  return {
    ...data,
    weight: numberOf(data.weight, 1),
    ...(underlyingEdgeIds.length > 0 ? { underlyingEdgeIds } : {}),
    ...(groupedGhostId === null
      ? {}
      : { ghostGroupAggregate: true, groupedGhostIds: [groupedGhostId], groupedGhostCount: 1 }),
  };
}

function semanticSummary(node: Node): GhostData {
  const data = ghostDataOf(node);
  return { label: data.label, context: data.context, ghostKind: data.ghostKind };
}

function relationshipKind(edge: Edge): string {
  const data = dataOf(edge);
  if (typeof data.depKind === "string") return data.depKind;
  if (typeof data.category === "string") return data.category;
  return edge.type ?? "relationship";
}

function groupedEvidenceEdgeId(source: string, target: string, kind: string): string {
  return `ghost-group-edge:${kind}:${source}->${target}`;
}

function bucketKey(direction: GhostGroupDirection, parentId: string): string {
  return `${direction}${KEY_SEPARATOR}${parentId}`;
}

function compareBuckets(a: DirectionBucket, b: DirectionBucket): number {
  return a.parentId.localeCompare(b.parentId) || a.direction.localeCompare(b.direction);
}

function sortedDirections(directions: ReadonlySet<GhostGroupDirection>): GhostGroupDirection[] {
  return [...directions].sort();
}

function preferredDirection(directions: readonly GhostGroupDirection[]): GhostGroupDirection {
  return directions.includes("outgoing") ? "outgoing" : "incoming";
}

function isExactGhost(node: Node): boolean {
  return node.type === "ghost" && typeof (node.data as Partial<GhostGroupData>).ghostGroupId !== "string";
}

function ghostDataOf(node: Node): GhostData {
  return node.data as GhostData;
}

function dataOf(edge: Edge): Record<string, unknown> {
  return (edge.data ?? {}) as Record<string, unknown>;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
