/**
 * The Service lens's GHOST TIER — the Map's honest-resolution rule applied to cluster space: a
 * coupling whose far end is NOT representable on this canvas charts as a detached ghost card
 * instead of silently vanishing. Two complementary raw sources, split by what the canvas can
 * anchor, merged BEFORE the shared finishing pass (Tests filter → same-folder folding) so one fact
 * can never draw twice — the tiers' cards dedupe by id and fold into the same folder groups:
 *
 *   - WALK tier: the shared `ghostLevel` projection over the drawn code skeleton (expanded frames'
 *     units/blocks), minus ghosts whose coupling ALREADY draws as a cluster frame wire
 *     (`clusterCouplingEdges`) — the Map's invariant is "ghost only what would otherwise vanish",
 *     never a double-drawn fact, and never a silent hole (see `withoutFrameWireGhosts`).
 *   - CLUSTER tier: couplings DROPPED by the scope filter / the focus zoom, ghosted at the level
 *     they would have drawn — the out-of-view cluster's LEAD unit as the card, wired to the kept
 *     side's collapsed frame. (A kept frame that is EXPANDED anchors the same story through the
 *     walk tier at symbol precision, so the cluster tier skips it; a lead already ON canvas — a
 *     ⌘P-pinned card of a dropped cluster — is its own card and never ghosts.)
 *
 * Ghost ids are real artifact ids (a lead unit — reveal resolves it through the service placement).
 * Pure; no React, no ELK.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { BlockDeps } from "./blockDeps";
import type { CodeWalk, Skeleton } from "./codeWalk";
import { ghostData, type GhostEmission, type GhostWire } from "./ghostDeps";
import { EMPTY_GHOST_TIER, finishGhostTier, rawGhostEmission, type GhostTier } from "./ghostLevel";
import { frameIdOf, leadIdOf } from "./serviceClusterEdges";
import type { ServiceClustering } from "./serviceComposition";
import { crossesPackageBoundary } from "./packageBoundary";

const EMPTY_EMISSION: GhostEmission = { ghosts: new Map(), wires: [] };
/** The wire kind cluster-level coupling ghosts ride through the shared pipeline: it keys their
 * `gdep:couple:` edge ids and per-pair aggregation, then strips back off the painted edge. */
const COUPLE_KIND = "couple";

/** The lens's whole ghost yield: walk + cluster raw emissions, merged, finished ONCE. */
export function serviceGhostTier(
  full: ServiceClustering,
  drawnLeads: ReadonlySet<string>,
  blockDeps: BlockDeps,
  walk: CodeWalk,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
  hiddenIds: ReadonlySet<string>,
): GhostTier {
  const walkEmission = walkGhostEmission(full, drawnLeads, blockDeps, walk, visibleIds, index, kinds);
  const clusterEmission =
    drawnLeads.size === full.clusters.length ? EMPTY_EMISSION : clusterGhostEmission(full, drawnLeads, visibleIds, index);
  const merged = mergeEmissions(walkEmission, clusterEmission);
  if (merged.ghosts.size === 0) {
    return EMPTY_GHOST_TIER;
  }
  return withoutCoupleDepKind(finishGhostTier(merged, index, hiddenIds));
}

/** The shared code-level projection, minus ghosts a drawn cluster frame wire already represents. */
function walkGhostEmission(
  full: ServiceClustering,
  drawnLeads: ReadonlySet<string>,
  blockDeps: BlockDeps,
  walk: CodeWalk,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
): GhostEmission {
  const raw = rawGhostEmission(blockDeps, walk, visibleIds, index, kinds);
  if (raw === null) {
    return EMPTY_EMISSION;
  }
  return withoutFrameWireGhosts(raw, full.leadOf, visibleIds, index, walk, drawnLeads);
}

/**
 * Drop the ghost wires (and then card-less ghosts) the canvas ALREADY charts as a cluster frame
 * wire — and ONLY those. "The ghost's home frame is drawn" alone is not enough: in a scoped/zoomed
 * view `scopedTo` drops every coupling whose OTHER endpoint's cluster left the drawn set, so a
 * wire anchored at a ⌘P-pinned card of a dropped cluster has NO frame wire to read as — suppressing
 * its ghost would silently vanish the fact. A wire is represented iff BOTH sides survived the
 * scope filter: the ghost's home frame is on canvas AND the drawn anchor lifts into a drawn
 * cluster. (A pinned FILE extra can't name which of its units couples out, so it conservatively
 * KEEPS its ghosts — a rare double-draw beats a silent hole.)
 */
function withoutFrameWireGhosts(
  emission: GhostEmission,
  leadOf: ReadonlyMap<string, string>,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  walk: CodeWalk,
  drawnLeads: ReadonlySet<string>,
): GhostEmission {
  const drawnParents = new Map(walk.skeleton.map((entry) => [entry.id, entry.parentId]));
  const representsFrameWire = (wire: GhostWire): boolean => {
    const ghostEnd = emission.ghosts.has(wire.source) ? wire.source : wire.target;
    const anchorEnd = ghostEnd === wire.source ? wire.target : wire.source;
    return hasDrawnFrame(ghostEnd, leadOf, visibleIds, index) && anchorInDrawnCluster(anchorEnd, drawnParents, leadOf, drawnLeads, index);
  };
  const wires = emission.wires.filter((wire) => !representsFrameWire(wire));
  const kept = new Set(wires.flatMap((wire) => [wire.source, wire.target]));
  const ghosts = new Map([...emission.ghosts].filter(([id]) => kept.has(id)));
  return { ghosts, wires };
}

/** Whether any ancestor-or-self of `id` belongs to a cluster whose `svc:` frame is drawn. */
function hasDrawnFrame(id: string, leadOf: ReadonlyMap<string, string>, visibleIds: ReadonlySet<string>, index: GraphIndex): boolean {
  for (const node of index.ancestorsOf(id)) {
    const lead = leadOf.get(node.id);
    if (lead !== undefined && visibleIds.has(frameIdOf(lead))) {
      return true;
    }
  }
  return false;
}

/** Whether the drawn anchor's coupling survived the scope/zoom filter: an anchor INSIDE a cluster
 * frame (member, block, step — its skeleton chain roots at the `svc:` frame) always did; a
 * detached extra card did only when its own cluster is still in the drawn set. */
function anchorInDrawnCluster(
  anchorId: string,
  drawnParents: ReadonlyMap<string, string | null>,
  leadOf: ReadonlyMap<string, string>,
  drawnLeads: ReadonlySet<string>,
  index: GraphIndex,
): boolean {
  if (leadIdOf(skeletonRootOf(anchorId, drawnParents)) !== null) {
    return true;
  }
  const ancestors = index.ancestorsOf(anchorId);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const lead = leadOf.get(ancestors[i].id);
    if (lead !== undefined) {
      return drawnLeads.has(lead);
    }
  }
  return false;
}

/** The drawn skeleton root above `id` (self when detached) — a `svc:` root means "inside a frame". */
function skeletonRootOf(id: string, drawnParents: ReadonlyMap<string, string | null>): string {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const parent = drawnParents.get(current);
    if (parent === null || parent === undefined) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** Ghost the far end of couplings the scope/zoom dropped, anchored at the kept side's COLLAPSED
 * frame (an expanded frame's drawn code tells the same story through the walk tier instead). A
 * raw emission, so both tiers fold through ONE `groupGhostEmission` pass: same-folder leads join
 * the same folder group card, and a lead the walk already ghosted merges by id. A ghost lead
 * already ON canvas (a ⌘P-pinned card of a dropped cluster) is skipped — the pin IS the card, and
 * its couplings chart through the walk tier. */
function clusterGhostEmission(full: ServiceClustering, drawnLeads: ReadonlySet<string>, visibleIds: ReadonlySet<string>, index: GraphIndex): GhostEmission {
  const ghosts: GhostEmission["ghosts"] = new Map();
  const byPair = new Map<string, GhostWire>();
  for (const edge of full.couplings) {
    const sourceLead = full.leadOf.get(edge.source);
    const targetLead = full.leadOf.get(edge.target);
    if (sourceLead === undefined || targetLead === undefined || sourceLead === targetLead) {
      continue;
    }
    const sourceDrawn = drawnLeads.has(sourceLead);
    if (sourceDrawn === drawnLeads.has(targetLead)) {
      continue; // both kept (a real frame wire) or both dropped (no drawn end to anchor).
    }
    const anchor = collapsedFrameAnchor(sourceDrawn ? edge.source : edge.target, full.leadOf, visibleIds);
    const ghostLead = sourceDrawn ? targetLead : sourceLead;
    const ghostNode = index.nodesById.get(ghostLead);
    if (anchor === null || visibleIds.has(ghostLead) || !ghostNode) {
      continue;
    }
    ghosts.set(ghostLead, ghostData(ghostNode));
    const [source, target] = sourceDrawn ? [anchor, ghostLead] : [ghostLead, anchor];
    const key = `${source} ${target}`;
    const crossPackage = crossesPackageBoundary(edge.source, edge.target, index);
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += 1;
      existing.crossPackage ||= crossPackage;
    } else {
      // Cluster couplings are pair-level aggregates (design-metrics' CouplingEdge unions kinds
      // without keeping artifact edge ids), so this tier has no per-site trail — the Wire
      // Inspector shows the wire's section header alone, like flow/IPC wires.
      byPair.set(key, { source, target, weight: 1, kind: COUPLE_KIND, crossPackage, underlyingEdgeIds: [] });
    }
  }
  return { ghosts, wires: [...byPair.values()] };
}

/** The kept endpoint's frame — ONLY while collapsed (its unit off canvas); null defers to the walk. */
function collapsedFrameAnchor(unitId: string, leadOf: ReadonlyMap<string, string>, visibleIds: ReadonlySet<string>): string | null {
  if (visibleIds.has(unitId)) {
    return null;
  }
  const frame = frameIdOf(leadOf.get(unitId)!);
  return visibleIds.has(frame) ? frame : null;
}

/** Union the raw tiers: ghost CARDS merge by id (both may name the same lead); wires concatenate. */
function mergeEmissions(walkTier: GhostEmission, clusterTier: GhostEmission): GhostEmission {
  if (clusterTier.ghosts.size === 0) {
    return walkTier;
  }
  return { ghosts: new Map([...walkTier.ghosts, ...clusterTier.ghosts]), wires: [...walkTier.wires, ...clusterTier.wires] };
}

/** The paint layer's relationship vocabulary must not learn the `couple` pseudo-kind: stripping
 * `depKind` keeps cluster-coupling ghost wires on the exact default read the old cluster tier had
 * (gold stroke, toggled with Calls). */
function withoutCoupleDepKind(tier: GhostTier): GhostTier {
  return {
    nodes: tier.nodes,
    edges: tier.edges.map((edge) => (edge.depKind === COUPLE_KIND ? { ...edge, depKind: undefined } : edge)),
  };
}
