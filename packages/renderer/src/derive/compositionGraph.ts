/**
 * Derive the graph's composition units into a pre-layout spec — the SOLID health scorecards the
 * Service-composition tab renders, wired by coupling edges. Each unit (class/interface/object body
 * or a whole module) becomes a scorecard sized to its metrics; each cross-unit coupling becomes one
 * peer wire. Colour tracks distance-from-the-main-sequence (green → amber → red).
 *
 * Pure: (nodes, edges) → {nodes, edges}. No React, no ELK. Mirrors `logicGraph.ts`.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import { buildUnitIndex, computeCompositionMetrics, couplingEdges, groupMembersByUnit, type UnitMetrics } from "@meridian/design-metrics";
import { computeRootedView } from "./compositionRoot";
import { buildClusters, nearestEmitted, npmPackageIdOf, type ClusterFrame } from "./compositionClusters";
import { aggregateByPackage, type PackageSummaryData } from "./compositionAggregate";
import type { ModuleGrouping } from "./moduleGrouping";

// A `type` (not an interface) so it satisfies React Flow's `Node<T extends Record<string, unknown>>`
// constraint — an interface lacks the implicit index signature (mirrors logic's LogicNodeData).
export type CompNodeData = {
  unitId: string;
  kind: string;
  label: string;
  metrics: UnitMetrics;
  /** The unit's callable members (its methods/functions), sorted by name — surfaced on the card so a
   * service shows WHAT it holds, each a click-through into that member's logic flow. */
  members: { id: string; name: string }[];
  /** A 1-hop coupling neighbour of the rooted subtree — drawn faded + click-to-re-root. Absent/false
   * for the root's own units and for the whole-system (rootless) view. */
  boundary?: boolean;
};

/** How many member rows a card shows before collapsing the rest into a "+N more" line. Shared with
 * CompositionNode so the rendered rows and the laid-out card height can't drift. */
export const MEMBERS_SHOWN = 5;

// A cluster FRAME's data: presentation only — the package/folder label plus the tallies that drive
// its header badges. A `type` for the same index-signature reason as CompNodeData.
export type ClusterNodeData = {
  clusterId: string;
  label: string;
  unitCount: number;
  smellyCount: number;
  /** True on a package the AGGREGATED view has inline-expanded — the frame header then offers the
   * collapse (▾) control. Absent on the unit view's passive frames. */
  expanded?: boolean;
};

// An IPC channel card's data: the channel key two processes meet on, plus its honesty flag —
// `dangling` says one whole side is missing ("out-only": someone sends, nobody answers).
export type ChannelCompData = {
  channelId: string;
  label: string;
  protocol: string;
  dangling: "out-only" | "in-only" | null;
};

export type CompNodeType = "unit" | "cluster" | "channel" | "package";

// A single spec type spans both node kinds (mirrors logic's LogicNodeSpec): a "unit" carries its
// scorecard size and a cluster `parentId`; a "cluster" frame is a container ELK sizes, so it omits
// width/height and parentId. `data` narrows on `type`.
export interface CompNodeSpec {
  id: string;
  type: CompNodeType;
  width?: number;
  height?: number;
  /** The cluster frame this node nests in (undefined for a top-level node; the aggregated view
   * nests frames inside frames, so an expanded sub-package frame carries one too). */
  parentId?: string;
  data: CompNodeData | ClusterNodeData | ChannelCompData | PackageSummaryData;
}

/** One channel an IPC wire carries — shown in the inspector when the wire is clicked. */
export interface IpcChannelDetail {
  channel: string;
  protocol: string;
  dangling: "out-only" | "in-only" | null;
}

export interface CompEdgeSpec {
  id: string;
  source: string;
  target: string;
  inheritanceOnly: boolean;
  /** True when the pair sits in DIFFERENT clusters — the packaging / Common-Closure signal. */
  crossBoundary: boolean;
  /** An IPC hop (a `sends`/`handles` half through a channel card) — drawn as the magenta wire. */
  ipc?: boolean;
  /** The channel(s) this IPC wire represents — one in the unit view, many on an aggregated wire. */
  ipcChannels?: IpcChannelDetail[];
}

/** Recover a channel's display key + protocol from its `ipc:<protocol>/<slug>` id (core's grammar). */
export function channelInfoFromId(id: string): { channel: string; protocol: string } {
  const body = id.startsWith("ipc:") ? id.slice(4) : id;
  const slash = body.indexOf("/");
  const protocol = slash === -1 ? "ipc" : body.slice(0, slash);
  const channel = (slash === -1 ? body : body.slice(slash + 1)).replace(/\+/g, " ").replace(/%23/g, "#");
  return { channel, protocol };
}

/** A channel's full inspector detail from its id + which sides it has anywhere in the artifact. */
export function channelDetailFromId(id: string, sides: Map<string, { out: boolean; in: boolean }>): IpcChannelDetail {
  const side = sides.get(id);
  return {
    ...channelInfoFromId(id),
    dangling: side && !side.in ? "out-only" : side && !side.out ? "in-only" : null,
  };
}

export interface CompositionGraphSpec {
  nodes: CompNodeSpec[];
  edges: CompEdgeSpec[];
}

export interface CompositionOverviewOptions {
  grouping?: ModuleGrouping;
  entryIds?: readonly string[];
}

/**
 * Every unit that carries weight — has ≥1 member OR sits on ≥1 coupling wire — as a sized
 * scorecard, plus the peer wires between them. An empty, uncoupled unit is dropped so the canvas
 * isn't cluttered with dead frames; a coupling endpoint is always kept even if it has no members.
 *
 * A non-null `root` (a module/package node id) narrows the graph to a ROOTED view: only the units
 * the root contains plus their 1-hop coupling neighbours (the latter flagged `boundary` and drawn
 * faded so a click can re-root there). `root === null` is the unchanged whole-system view.
 *
 * `aggregate` (whole-system only) rolls every unit up to its PACKAGE — one summary card each,
 * hundreds not thousands — so a giant repo lays out and reads. Double-clicking a package roots
 * there, dropping back to unit scorecards; a package in `expanded` instead opens INLINE as a frame
 * holding the next level (see compositionAggregate).
 */
export function deriveCompositionGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  root: string | null = null,
  showMetrics = true,
  expanded: ReadonlySet<string> = NONE_EXPANDED,
  overview: CompositionOverviewOptions = {},
): CompositionGraphSpec {
  const metrics = computeCompositionMetrics(nodes, edges);
  const couplings = couplingEdges(nodes, edges);
  const coupled = couplingEndpoints(couplings);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const survivors = survivingUnits(metrics, coupled);

  // Recursive progressive disclosure: if the units in view (whole-system, or the rooted subtree)
  // still exceed what the canvas can paint interactively, aggregate to the package cards ONE LEVEL
  // below the current root. Each drill re-roots a level deeper until a package is small enough to
  // show its unit scorecards. This is what keeps a giant repo interactive in a slower engine.
  const inView = unitsInView(survivors, root, nodesById);
  if (inView.size > AGGREGATE_UNIT_THRESHOLD) {
    // Only an inline-expanded frame ever shows real scorecards at this altitude, so the member
    // partition (needed to size + fill them) is computed only when something is expanded.
    const membersByUnit = expanded.size > 0 ? groupMembersByUnit(nodes, buildUnitIndex(nodes)) : new Map<string, GraphNode[]>();
    const unitCard = (unitId: string) => unitNode(metrics.get(unitId)!, false, showMetrics, membersByUnit.get(unitId) ?? []);
    const spec = aggregateByPackage(edges, metrics, couplings, inView, nodesById, root, expanded, unitCard);
    return root === null ? applyApplicationsOverview(spec, nodesById, overview) : spec;
  }

  // The unit → members partition, reused per card so a scorecard can list the methods it holds.
  const membersByUnit = groupMembersByUnit(nodes, buildUnitIndex(nodes));

  // The whole-system survivor set drives both views; a root then restricts it to its subtree + the
  // 1-hop neighbours, keeping the root's own unit even if it would otherwise be dropped.
  const view = computeRootedView(root, survivors, root !== null && metrics.has(root), couplings, nodesById);

  const unitSpecs: CompNodeSpec[] = [];
  const emitted = new Set<string>();
  for (const metric of metrics.values()) {
    if (!view.visible.has(metric.id)) {
      continue;
    }
    unitSpecs.push(unitNode(metric, view.boundary.has(metric.id), showMetrics, membersByUnit.get(metric.id) ?? []));
    emitted.add(metric.id);
  }

  // Group the surviving units into package frames and pin each unit to its frame. A frame node is
  // emitted BEFORE its child units so React Flow always sees a parent ahead of its children.
  const clusters = buildClusters(unitSpecs, nodesById);
  const clusterOf = assignClusters(clusters, unitSpecs);
  const nodeSpecs = [...clusters.map(clusterNode), ...unitSpecs];

  // A coupling endpoint is always a unit with a metrics entry, so both ends are emitted; the guard
  // is defensive against a pair that somehow references a dropped unit. A pair spanning two frames
  // is the packaging signal the layout emphasizes.
  const edgeSpecs: CompEdgeSpec[] = couplings
    .filter((edge) => emitted.has(edge.source) && emitted.has(edge.target))
    .map((edge) => ({
      id: `couple:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      inheritanceOnly: edge.inheritanceOnly,
      crossBoundary: clusterOf.get(edge.source) !== clusterOf.get(edge.target),
    }));

  // The IPC layer: channel cards wired by the artifact's sends/handles edges, each function
  // endpoint lifted to its nearest emitted UNIT (the scorecard that holds it).
  const ipc = ipcLayerFor(edges, (id) => nearestEmitted(id, emitted, nodesById), channelSidesOf(edges));

  const spec = { nodes: [...nodeSpecs, ...ipc.nodes], edges: [...edgeSpecs, ...ipc.edges] };
  return root === null ? applyApplicationsOverview(spec, nodesById, overview) : spec;
}

function applyApplicationsOverview(
  spec: CompositionGraphSpec,
  nodesById: Map<string, GraphNode>,
  overview: CompositionOverviewOptions,
): CompositionGraphSpec {
  if (overview.grouping !== "applications") {
    return spec;
  }
  const packageCards = new Set(
    spec.nodes
      .filter((node) => node.type === "package" || node.type === "cluster")
      .map((node) => node.id),
  );
  const keepPackages = applicationRootPackages(nodesById, packageCards, overview.entryIds ?? []);
  if (keepPackages.size === 0) {
    return spec;
  }
  const nodeType = new Map(spec.nodes.map((node) => [node.id, node.type]));
  const keep = new Set<string>(keepPackages);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of spec.nodes) {
      if (node.parentId && keep.has(node.parentId) && !keep.has(node.id)) {
        keep.add(node.id);
        grew = true;
      }
    }
  }
  for (const edge of spec.edges) {
    if (keep.has(edge.source) && nodeType.get(edge.target) === "channel") {
      keep.add(edge.target);
    }
    if (keep.has(edge.target) && nodeType.get(edge.source) === "channel") {
      keep.add(edge.source);
    }
  }
  const nodes = spec.nodes.filter((node) => keep.has(node.id));
  const kept = new Set(nodes.map((node) => node.id));
  const edges = spec.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  return { nodes, edges };
}

function applicationRootPackages(
  nodesById: Map<string, GraphNode>,
  packageIds: ReadonlySet<string>,
  entryIds: readonly string[],
): Set<string> {
  const anchors = [...new Set(entryIds.map((id) => packageAnchor(id, nodesById)).filter((id): id is string => id !== null && packageIds.has(id)))];
  if (anchors.length === 0) {
    return new Set<string>();
  }
  const anchorSet = new Set(anchors);
  return new Set(anchors.filter((id) => !hasAnchorAncestor(id, anchorSet, nodesById)));
}

function packageAnchor(id: string, nodesById: Map<string, GraphNode>): string | null {
  if (nodesById.get(id)?.kind === "package") {
    return id;
  }
  return npmPackageIdOf(id, nodesById);
}

function hasAnchorAncestor(id: string, anchors: ReadonlySet<string>, nodesById: Map<string, GraphNode>): boolean {
  const seen = new Set<string>();
  let current = nodesById.get(id)?.parentId ?? null;
  while (current && !seen.has(current)) {
    if (anchors.has(current)) {
      return true;
    }
    seen.add(current);
    current = nodesById.get(current)?.parentId ?? null;
  }
  return false;
}

// The channel card geometry: a compact pill — wide enough for "GET /api/orders/:id" plus tags.
const CHANNEL_WIDTH = 220;
const CHANNEL_HEIGHT = 46;

/**
 * Project the artifact's IPC hops onto the composition canvas: each `sends`/`handles` edge has a
 * function endpoint and a channel endpoint — `resolve` lifts the function endpoint to the visible
 * card that owns it (a UNIT in the drilled-in view, a PACKAGE in the aggregated view), the channel
 * becomes a top-level card, and each hop becomes a gold wire. A channel missing a whole side keeps
 * an honest `dangling` flag. Shared by the unit view and the package aggregation so both agree.
 */
export function ipcLayerFor(
  edges: GraphEdge[],
  resolve: (nodeId: string) => string | null,
  sides: Map<string, { out: boolean; in: boolean }>,
): { nodes: CompNodeSpec[]; edges: CompEdgeSpec[] } {
  const channelSpecs = new Map<string, CompNodeSpec>();
  const edgeSpecs = new Map<string, CompEdgeSpec>();
  const channelById = channelNodesById(edges, sides);
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const outbound = edge.kind === "sends";
    const channelNode = channelById.get(outbound ? edge.target : edge.source);
    const owner = resolve(outbound ? edge.source : edge.target);
    if (!channelNode || !owner) {
      continue;
    }
    if (!channelSpecs.has(channelNode.id)) {
      channelSpecs.set(channelNode.id, channelNode.spec);
    }
    const source = outbound ? owner : channelNode.id;
    const target = outbound ? channelNode.id : owner;
    const channelData = channelNode.spec.data as ChannelCompData;
    edgeSpecs.set(`ipc:${source}->${target}`, {
      id: `ipc:${source}->${target}`,
      source,
      target,
      inheritanceOnly: false,
      crossBoundary: false,
      ipc: true,
      ipcChannels: [{ channel: channelData.label, protocol: channelData.protocol, dangling: channelData.dangling }],
    });
  }
  return { nodes: [...channelSpecs.values()], edges: [...edgeSpecs.values()] };
}

/** The channel-node id → its card spec, derived once. A channel node isn't in nodesById in the
 * aggregate path's world (it reads only edges), so its id + protocol come off the edge's channel id. */
function channelNodesById(edges: GraphEdge[], sides: Map<string, { out: boolean; in: boolean }>): Map<string, { id: string; spec: CompNodeSpec }> {
  const byId = new Map<string, { id: string; spec: CompNodeSpec }>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const id = edge.kind === "sends" ? edge.target : edge.source;
    if (!byId.has(id)) {
      byId.set(id, { id, spec: channelSpecFromId(id, sides.get(id)) });
    }
  }
  return byId;
}

// A channel id is `ipc:<protocol>/<slug>` — recover the protocol and display label from it, so the
// aggregate path needn't carry the channel GraphNodes. Matches core's channelNodeId grammar.
function channelSpecFromId(id: string, sides: { out: boolean; in: boolean } | undefined): CompNodeSpec {
  const { channel, protocol } = channelInfoFromId(id);
  const data: ChannelCompData = {
    channelId: id,
    label: channel,
    protocol,
    dangling: sides && !sides.in ? "out-only" : sides && !sides.out ? "in-only" : null,
  };
  return { id, type: "channel", width: CHANNEL_WIDTH, height: CHANNEL_HEIGHT, data };
}

/** Which sides each channel has ANYWHERE in the artifact (not just the visible subset). */
export function channelSidesOf(edges: GraphEdge[]): Map<string, { out: boolean; in: boolean }> {
  const sides = new Map<string, { out: boolean; in: boolean }>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const channelId = edge.kind === "sends" ? edge.target : edge.source;
    const entry = sides.get(channelId) ?? { out: false, in: false };
    if (edge.kind === "sends") entry.out = true;
    else entry.in = true;
    sides.set(channelId, entry);
  }
  return sides;
}

/** Set each unit spec's `parentId` to its cluster frame, returning the unit→cluster map the edge
 * pass reuses to flag cross-boundary couplings. */
function assignClusters(clusters: ClusterFrame[], unitSpecs: CompNodeSpec[]): Map<string, string> {
  const clusterOf = new Map<string, string>();
  for (const cluster of clusters) {
    for (const unitId of cluster.unitIds) {
      clusterOf.set(unitId, cluster.id);
    }
  }
  for (const spec of unitSpecs) {
    spec.parentId = clusterOf.get(spec.id);
  }
  return clusterOf;
}

function clusterNode(cluster: ClusterFrame): CompNodeSpec {
  const data: ClusterNodeData = {
    clusterId: cluster.id,
    label: cluster.label,
    unitCount: cluster.unitIds.length,
    smellyCount: cluster.smellyCount,
  };
  // No width/height, no parentId: ELK sizes a container from its children, and a frame is a root.
  return { id: cluster.id, type: "cluster", data };
}

function couplingEndpoints(couplings: ReturnType<typeof couplingEdges>): Set<string> {
  const ids = new Set<string>();
  for (const edge of couplings) {
    ids.add(edge.source);
    ids.add(edge.target);
  }
  return ids;
}

/** Above this many unit cards in view, aggregate to package cards instead. Tuned so even a slower
 * engine (Safari/WebKit) pans/zooms smoothly — a few dozen cards, not hundreds. */
const AGGREGATE_UNIT_THRESHOLD = 120;

/** The default "nothing inline-expanded" set — one shared instance so the default arg is stable. */
const NONE_EXPANDED: ReadonlySet<string> = new Set();

/** The surviving units within the current root's subtree (all survivors when root is null). */
function unitsInView(survivors: Set<string>, root: string | null, nodesById: Map<string, GraphNode>): Set<string> {
  if (root === null) {
    return survivors;
  }
  const inView = new Set<string>();
  for (const id of survivors) {
    if (isWithin(id, root, nodesById)) {
      inView.add(id);
    }
  }
  return inView;
}

/** Whether `nodeId` is `root` or lies in its subtree (walks parentId, cycle-guarded). */
function isWithin(nodeId: string, root: string, nodesById: Map<string, GraphNode>): boolean {
  const seen = new Set<string>();
  let current: GraphNode | undefined = nodesById.get(nodeId);
  while (current && !seen.has(current.id)) {
    if (current.id === root) {
      return true;
    }
    seen.add(current.id);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return false;
}

/** The units carrying weight: ≥1 member OR ≥1 coupling wire — the whole-system scorecard set. */
function survivingUnits(metrics: Map<string, UnitMetrics>, coupled: Set<string>): Set<string> {
  const survivors = new Set<string>();
  for (const metric of metrics.values()) {
    if (metric.members > 0 || coupled.has(metric.id)) {
      survivors.add(metric.id);
    }
  }
  return survivors;
}

function unitNode(metric: UnitMetrics, boundary: boolean, showMetrics: boolean, members: GraphNode[]): CompNodeSpec {
  const memberList = members
    .map((member) => ({ id: member.id, name: member.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const data: CompNodeData = { unitId: metric.id, kind: metric.kind, label: metric.displayName, metrics: metric, members: memberList, boundary };
  const { width, height } = sizeFor(data, showMetrics);
  return { id: metric.id, type: "unit", width, height, data };
}

// The scorecard geometry: a fixed-width card whose height grows only with the smell chips that
// wrap ~2 per row below the metrics. The base clears the header + the members/coupling/distance
// rows; each chip row adds a fixed band so the node component renders without clipping.
const CARD_WIDTH = 240;
const CARD_BASE_HEIGHT = 104;
const CHIP_ROW_HEIGHT = 22;
const CHIPS_PER_ROW = 2;
// The member list geometry: a small header band plus one line per shown member (and a "+N more" line
// when capped). A boundary ghost never lists members, so it stays at the base height.
const MEMBER_HEADER_HEIGHT = 16;
const MEMBER_ROW_HEIGHT = 15;
// A metrics-off card still shows its header (kind + name) and the D (distance) rating row, so it
// collapses only partway — clearing those two rows, not the members/coupling rows or chip band.
const CARD_COMPACT_HEIGHT = 66;

export function sizeFor(data: CompNodeData, showMetrics = true): { width: number; height: number } {
  if (!showMetrics) {
    return { width: CARD_WIDTH, height: CARD_COMPACT_HEIGHT };
  }
  const chipRows = Math.ceil(data.metrics.smells.length / CHIPS_PER_ROW);
  return { width: CARD_WIDTH, height: CARD_BASE_HEIGHT + chipRows * CHIP_ROW_HEIGHT + memberBandHeight(data) };
}

/** The vertical band the member list occupies: nothing for a boundary ghost or a memberless unit,
 * else a header plus a row per shown member and one more for the "+N more" overflow line. */
function memberBandHeight(data: CompNodeData): number {
  if (data.boundary || data.members.length === 0) {
    return 0;
  }
  const shown = Math.min(data.members.length, MEMBERS_SHOWN);
  const overflowRow = data.members.length > MEMBERS_SHOWN ? 1 : 0;
  return MEMBER_HEADER_HEIGHT + (shown + overflowRow) * MEMBER_ROW_HEIGHT;
}

// Distance-from-the-main-sequence health scale, stepwise green → amber → red. The middle band
// collapses to amber (the spec allows a simple stepwise): on the main sequence reads green, a
// unit far off it (D ≥ 0.7 — a zone-of-pain/uselessness corner) reads red.
const DISTANCE_GREEN_MAX = 0.2;
const DISTANCE_RED_MIN = 0.7;
export const HEALTH_GREEN = "#56C271";
export const HEALTH_AMBER = "#E6B84D";
export const HEALTH_RED = "#E5484D";

export function colorForDistance(distance: number): string {
  if (distance <= DISTANCE_GREEN_MAX) {
    return HEALTH_GREEN;
  }
  if (distance >= DISTANCE_RED_MIN) {
    return HEALTH_RED;
  }
  return HEALTH_AMBER;
}
