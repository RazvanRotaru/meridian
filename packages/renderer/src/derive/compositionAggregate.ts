/**
 * Whole-system AGGREGATION for the composition view: on a big repo, laying out one card per unit
 * (Autopilot: ~12.5k) overwhelms in-browser ELK. Instead, roll every unit up to its PACKAGE and
 * draw one summary card per package — hundreds, not thousands — with couplings and IPC hops lifted
 * to package level. Double-clicking a package roots the view there, back to unit scorecards; the
 * card's ▸ control instead EXPANDS the package INLINE — it becomes a titled frame holding the next
 * level (sub-package cards, and unit scorecards where no deeper package exists), recursively, while
 * the rest of the overview stays put. Edges always attach to the finest VISIBLE card.
 *
 * Pure: (nodes, edges, metrics, couplings, expanded) → {nodes, edges}. No React, no ELK. Only the
 * aggregated whole-system view uses this; a rooted (drilled-in) view stays at unit granularity.
 */

import type { GraphEdge, GraphNode } from "@meridian/core";
import type { CouplingEdge, UnitMetrics } from "@meridian/design-metrics";
import { clusterLabel, nearestEmitted, placeUnderExpansion } from "./compositionClusters";
import { channelDetailFromId, channelSidesOf, type ClusterNodeData, type CompEdgeSpec, type CompNodeSpec, type IpcChannelDetail } from "./compositionGraph";

/** The roll-up a package summary card shows: how many units, how many smell, the worst health. */
export type PackageSummaryData = {
  packageId: string;
  label: string;
  unitCount: number;
  memberCount: number;
  smellyCount: number;
  /** Worst (max) distance-from-main-sequence across the package's units — drives the health rail. */
  worstDistance: number;
};

const PKG_CARD_WIDTH = 232;
const PKG_CARD_HEIGHT = 92;

/** An inline-expanded package frame while it accumulates: its nesting plus the header tallies. */
interface FrameAccum {
  id: string;
  parent: string | undefined;
  depth: number;
  unitCount: number;
  smellyCount: number;
}

/**
 * Build the aggregated graph: one `package` card per package that holds ≥1 surviving unit, the
 * couplings between packages (unit couplings lifted to their packages, self-loops dropped), and the
 * IPC channel cards + wires lifted the same way. `survivors` is the whole-system unit set the
 * unaggregated path already computed, so both views agree on which units count. A package in
 * `expanded` renders as a cluster FRAME instead, holding the next level inline; `unitCard` builds
 * the scorecard for a unit that bottoms out inside such a frame.
 */
export function aggregateByPackage(
  edges: GraphEdge[],
  metrics: Map<string, UnitMetrics>,
  couplings: CouplingEdge[],
  survivors: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
  rootId: string | null,
  expanded: ReadonlySet<string>,
  unitCard: (unitId: string) => CompNodeSpec,
): { nodes: CompNodeSpec[]; edges: CompEdgeSpec[] } {
  const cardOfUnit = new Map<string, string>(); // unit → the visible card that represents it
  const frameOfCard = new Map<string, string | undefined>(); // visible card → its containing frame
  const frames = new Map<string, FrameAccum>();
  const rollup = new Map<string, PackageSummaryData>();
  const inlineUnits: string[] = []; // units shown as their own scorecards inside an expanded frame
  for (const metric of metrics.values()) {
    if (!survivors.has(metric.id)) {
      continue;
    }
    const placement = placeUnderExpansion(metric.id, rootId, expanded, nodesById);
    tallyFrames(placement.frames, metric, frames);
    const card = placement.card ?? metric.id;
    cardOfUnit.set(metric.id, card);
    frameOfCard.set(card, placement.frames[placement.frames.length - 1]);
    if (placement.card === null) {
      inlineUnits.push(metric.id);
      continue;
    }
    const summary = rollup.get(card) ?? emptySummary(card, nodesById);
    summary.unitCount += 1;
    summary.memberCount += metric.members;
    summary.worstDistance = Math.max(summary.worstDistance, metric.distance);
    if (metric.smells.length > 0) {
      summary.smellyCount += 1;
    }
    rollup.set(card, summary);
  }

  // Frames sort parent-before-child (by depth) so every consumer sees a container ahead of its
  // contents; the collapsed cards and inline scorecards then pin to their frame via parentId.
  const nodeSpecs: CompNodeSpec[] = [
    ...[...frames.values()].sort((a, b) => a.depth - b.depth).map((frame) => frameNode(frame, nodesById)),
    ...[...rollup.values()].map((data) => packageCard(data, frameOfCard.get(data.packageId))),
    ...inlineUnits.map((unitId) => inlineUnitCard(unitId, unitCard, frameOfCard)),
  ];
  const emittedCards = new Set<string>([...rollup.keys(), ...inlineUnits]);

  // Lift each unit coupling to its visible card pair; drop same-card and dropped-endpoint edges.
  // Any edge touching a PACKAGE card crosses a package boundary by construction (the cards ARE the
  // packages); only two unit scorecards inside the SAME opened frame are intra-package again.
  const inlineSet = new Set(inlineUnits);
  const intraPackage = (a: string, b: string) => inlineSet.has(a) && inlineSet.has(b) && frameOfCard.get(a) === frameOfCard.get(b);
  const edgeSpecs = new Map<string, CompEdgeSpec>();
  for (const edge of couplings) {
    const from = cardOfUnit.get(edge.source);
    const to = cardOfUnit.get(edge.target);
    if (!from || !to || from === to) {
      continue;
    }
    const id = `couple:${from}->${to}`;
    const existing = edgeSpecs.get(id);
    if (!existing) {
      edgeSpecs.set(id, { id, source: from, target: to, inheritanceOnly: edge.inheritanceOnly, crossBoundary: !intraPackage(from, to) });
    } else if (!edge.inheritanceOnly) {
      existing.inheritanceOnly = false; // a real use anywhere in the pair de-flags it
    }
  }

  // IPC at the overview altitude COLLAPSES to card→card wires: 400+ channel cards would both freeze
  // the canvas and drown the signal. Each channel's sender cards × handler cards become one wire per
  // pair; the individual channel cards return when you drill into a package.
  const resolve = (nodeId: string) => resolveCard(nodeId, rootId, expanded, emittedCards, nodesById);
  for (const edge of ipcCardEdges(edges, resolve, intraPackage)) {
    edgeSpecs.set(edge.id, edge);
  }
  return { nodes: nodeSpecs, edges: [...edgeSpecs.values()] };
}

/** Resolve ANY graph node (a unit, or an IPC port's function) to the visible card representing it:
 * descend the expanded frames to a collapsed group card, or — when it bottoms out inside a fully
 * opened frame — walk containment up to the unit scorecard that owns it. Null when its card was
 * dropped (its units didn't survive). */
function resolveCard(
  nodeId: string,
  rootId: string | null,
  expanded: ReadonlySet<string>,
  emittedCards: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
): string | null {
  const placement = placeUnderExpansion(nodeId, rootId, expanded, nodesById);
  if (placement.card !== null) {
    return emittedCards.has(placement.card) ? placement.card : null;
  }
  return nearestEmitted(nodeId, emittedCards, nodesById);
}

/** Collapse every channel into direct sender-card → handler-card IPC edges (deduped per pair). */
function ipcCardEdges(
  edges: GraphEdge[],
  resolve: (nodeId: string) => string | null,
  intraPackage: (a: string, b: string) => boolean,
): CompEdgeSpec[] {
  const sides = channelSidesOf(edges);
  const sendersByChannel = new Map<string, Set<string>>();
  const handlersByChannel = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "sends" && edge.kind !== "handles") {
      continue;
    }
    const channelId = edge.kind === "sends" ? edge.target : edge.source;
    const card = resolve(edge.kind === "sends" ? edge.source : edge.target);
    if (!card) {
      continue;
    }
    const map = edge.kind === "sends" ? sendersByChannel : handlersByChannel;
    (map.get(channelId) ?? map.set(channelId, new Set()).get(channelId)!).add(card);
  }
  // Accumulate, per card pair, every channel that flows between them — the wire's inspector list.
  const byPair = new Map<string, { from: string; to: string; channels: Map<string, IpcChannelDetail> }>();
  for (const [channelId, senders] of sendersByChannel) {
    for (const from of senders) {
      for (const to of handlersByChannel.get(channelId) ?? []) {
        if (from === to) {
          continue; // an intra-card channel is drill-down detail, not an overview wire.
        }
        const id = `ipc:${from}->${to}`;
        const pair = byPair.get(id) ?? { from, to, channels: new Map<string, IpcChannelDetail>() };
        pair.channels.set(channelId, channelDetailFromId(channelId, sides));
        byPair.set(id, pair);
      }
    }
  }
  return [...byPair.entries()].map(([id, pair]) => ({
    id,
    source: pair.from,
    target: pair.to,
    inheritanceOnly: false,
    crossBoundary: !intraPackage(pair.from, pair.to),
    ipc: true,
    ipcChannels: [...pair.channels.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
  }));
}

/** Fold one unit into every expanded frame on its placement path, creating frames on first sight. */
function tallyFrames(path: string[], metric: UnitMetrics, frames: Map<string, FrameAccum>): void {
  for (let i = 0; i < path.length; i += 1) {
    const accum = frames.get(path[i]) ?? { id: path[i], parent: path[i - 1], depth: i, unitCount: 0, smellyCount: 0 };
    accum.unitCount += 1;
    if (metric.smells.length > 0) {
      accum.smellyCount += 1;
    }
    frames.set(path[i], accum);
  }
}

function frameNode(frame: FrameAccum, nodesById: Map<string, GraphNode>): CompNodeSpec {
  const data: ClusterNodeData = {
    clusterId: frame.id,
    label: clusterLabel(frame.id, nodesById),
    unitCount: frame.unitCount,
    smellyCount: frame.smellyCount,
    expanded: true,
  };
  // No width/height: ELK sizes the frame from the cards inside it, exactly like the unit view's.
  return { id: frame.id, type: "cluster", parentId: frame.parent, data };
}

function inlineUnitCard(unitId: string, unitCard: (unitId: string) => CompNodeSpec, frameOfCard: ReadonlyMap<string, string | undefined>): CompNodeSpec {
  const spec = unitCard(unitId);
  spec.parentId = frameOfCard.get(unitId);
  return spec;
}

function emptySummary(pkgId: string, nodesById: Map<string, GraphNode>): PackageSummaryData {
  return { packageId: pkgId, label: clusterLabel(pkgId, nodesById), unitCount: 0, memberCount: 0, smellyCount: 0, worstDistance: 0 };
}

function packageCard(data: PackageSummaryData, parentId: string | undefined): CompNodeSpec {
  return { id: data.packageId, type: "package", width: PKG_CARD_WIDTH, height: PKG_CARD_HEIGHT, parentId, data };
}
