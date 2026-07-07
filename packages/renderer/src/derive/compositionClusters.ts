/**
 * Group the composition scorecards into titled CLUSTER FRAMES by their PACKAGE (folder) containment,
 * so the canvas reads as "what's in each package" rather than a flat sea of cards. A unit's cluster
 * is its nearest package ancestor; units with none share a stable "(root)" frame. Pure — no React,
 * no ELK. Consumed by `compositionGraph.ts` to emit one frame node per non-empty cluster.
 */

import type { GraphNode } from "@meridian/core";
import type { CompNodeSpec } from "./compositionGraph";

const PACKAGE_KIND = "package";

/** The frame every package-less unit falls into — a stable id/label safe as a React Flow node id. */
export const ROOT_CLUSTER_ID = "(root)";

export interface ClusterFrame {
  id: string;
  label: string;
  unitIds: string[];
  /** How many of the frame's units carry ≥1 design smell — drives an at-a-glance frame badge. */
  smellyCount: number;
}

/**
 * The cluster a unit belongs to: walk its `parentId` chain to the NEAREST ancestor node of kind
 * "package" and return that package's id; "(root)" when none exists. A unit is never itself a
 * package, so starting the walk at the unit is harmless. Visited-guarded — a malformed parentId
 * cycle (tolerated elsewhere) can't loop forever.
 */
export function clusterIdOf(unitId: string, nodesById: Map<string, GraphNode>): string {
  const visited = new Set<string>();
  let current = nodesById.get(unitId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === PACKAGE_KIND) {
      return current.id;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return ROOT_CLUSTER_ID;
}

/**
 * The group a unit rolls up to for a RECURSIVE aggregated view: the package one level below the
 * current `rootId` on the unit's ancestor chain. With `rootId = null` (the whole-system overview)
 * that's the top-level area (the package just under a `system` frame, or the shallowest package).
 * Drilling one level in re-roots there, so the next aggregation shows the packages one level deeper
 * — area → sub-package → … → units — never rendering more than one level's worth of cards at once.
 * Falls back to the nearest package (then "(root)") when the chain has no package under the root.
 */
export function groupUnderRoot(unitId: string, rootId: string | null, nodesById: Map<string, GraphNode>): string {
  // Ancestor chain root..unit (a package's parent chain up to the system/top), collected then walked
  // downward so "one level below root" is unambiguous even with the deep nesting a big repo has.
  const chain: GraphNode[] = [];
  const seen = new Set<string>();
  let current: GraphNode | undefined = nodesById.get(unitId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  chain.reverse(); // now top (system/package) → … → unit
  const rootIdx = rootId === null ? indexAfterSystem(chain) : chain.findIndex((node) => node.id === rootId) + 1;
  for (let i = Math.max(0, rootIdx); i < chain.length; i += 1) {
    if (chain[i].kind === PACKAGE_KIND) {
      return chain[i].id;
    }
  }
  // No package below the root on this path: fall back to nearest package (or the root itself).
  return clusterIdOf(unitId, nodesById);
}

/** The chain index just past a leading `system` frame (0 when there's no system prefix). */
function indexAfterSystem(chain: GraphNode[]): number {
  return chain.length > 0 && chain[0].kind === "system" ? 1 : 0;
}

/** Where a node lands in a partially-EXPANDED aggregated view: the chain of expanded package frames
 * it nests under (top-down), then the collapsed group card it rolls into — or `card: null` when the
 * innermost expanded frame has no deeper package on this path, meaning the node's own unit scorecard
 * is what shows inside that frame. */
export interface AggregatePlacement {
  frames: string[];
  card: string | null;
}

/**
 * Descend from the current root through every expanded group on `nodeId`'s ancestor path: each
 * expanded group becomes a frame, and `groupUnderRoot` re-runs one level deeper until it reaches a
 * collapsed group (the visible summary card) or bottoms out (no package below the innermost frame —
 * the unit itself is the visible card). The `frames.includes` guard also breaks the fixpoint where
 * `groupUnderRoot`'s nearest-package fallback returns the frame itself.
 */
export function placeUnderExpansion(
  nodeId: string,
  rootId: string | null,
  expanded: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
): AggregatePlacement {
  const frames: string[] = [];
  let group = groupUnderRoot(nodeId, rootId, nodesById);
  while (expanded.has(group) && !frames.includes(group)) {
    frames.push(group);
    const deeper = groupUnderRoot(nodeId, group, nodesById);
    if (deeper === group) {
      return { frames, card: null };
    }
    group = deeper;
  }
  return { frames, card: group };
}

/** Walk a node up its containment chain to the nearest card in `emitted` (itself included);
 * null when nothing on the chain is drawn. Shared by the unit view (functions → their unit
 * scorecard) and the aggregated view (any endpoint → its visible unit/package card). */
export function nearestEmitted(
  nodeId: string,
  emitted: ReadonlySet<string>,
  nodesById: Map<string, GraphNode>,
): string | null {
  const visited = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    if (emitted.has(current.id)) {
      return current.id;
    }
    visited.add(current.id);
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

/** A cluster's title: the package node's display name, or "(root)" for the package-less fallback.
 * In a LINKED artifact the package sits under a `system` frame node; the title then reads
 * `<system> › <package>` so two systems' identical folder names (src, src) stay tellable apart. */
export function clusterLabel(clusterId: string, nodesById: Map<string, GraphNode>): string {
  if (clusterId === ROOT_CLUSTER_ID) {
    return ROOT_CLUSTER_ID;
  }
  const pkg = nodesById.get(clusterId);
  if (!pkg) {
    return ROOT_CLUSTER_ID;
  }
  const system = systemAncestorOf(clusterId, nodesById);
  return system ? `${system.displayName} › ${pkg.displayName}` : pkg.displayName;
}

/** The `system` frame a node sits under (linked artifacts only); null in a single-repo graph. */
function systemAncestorOf(nodeId: string, nodesById: Map<string, GraphNode>): GraphNode | null {
  const visited = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === "system") {
      return current;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

/**
 * Fold the surviving unit specs into cluster frames by `clusterIdOf` — every unit lands in exactly
 * one frame, none dropped. Units keep their given (source) order within a frame; frames sort by
 * label (id tie-break) for a stable left-to-right reading. `smellyCount` tallies the units in each
 * frame that surface at least one smell.
 */
export function buildClusters(unitSpecs: CompNodeSpec[], nodesById: Map<string, GraphNode>): ClusterFrame[] {
  const byId = new Map<string, ClusterFrame>();
  for (const spec of unitSpecs) {
    const clusterId = clusterIdOf(spec.id, nodesById);
    const frame = byId.get(clusterId) ?? newFrame(clusterId, nodesById);
    frame.unitIds.push(spec.id);
    if (isSmelly(spec)) {
      frame.smellyCount += 1;
    }
    byId.set(clusterId, frame);
  }
  return [...byId.values()].sort(byLabel);
}

function newFrame(clusterId: string, nodesById: Map<string, GraphNode>): ClusterFrame {
  return { id: clusterId, label: clusterLabel(clusterId, nodesById), unitIds: [], smellyCount: 0 };
}

function isSmelly(spec: CompNodeSpec): boolean {
  return "metrics" in spec.data && spec.data.metrics.smells.length > 0;
}

function byLabel(a: ClusterFrame, b: ClusterFrame): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}
