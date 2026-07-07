/**
 * Group the composition scorecards into titled CLUSTER FRAMES by their PACKAGE (folder) containment,
 * so the canvas reads as "what's in each package" rather than a flat sea of cards. A unit's cluster
 * is its nearest package ancestor; units with none share a stable "(root)" frame. Pure — no React,
 * no ELK. Consumed by `compositionGraph.ts` to emit one frame node per non-empty cluster.
 */

import type { GraphNode } from "@meridian/core";
import type { CompNodeSpec } from "./compositionGraph";

const PACKAGE_KIND = "package";

/** Tag the extractor puts on a `package` node whose directory owns a package.json (an npm package). */
const NPM_PACKAGE_TAG = "npm-package";

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
 * The nearest ancestor `package` node tagged `npm-package` (the file's owning npm package), or null
 * when the file sits outside any npm package. Same visited-guarded parentId walk as `clusterIdOf`.
 */
export function npmPackageIdOf(nodeId: string, nodesById: Map<string, GraphNode>): string | null {
  const visited = new Set<string>();
  let current = nodesById.get(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind === PACKAGE_KIND && (current.tags?.includes(NPM_PACKAGE_TAG) ?? false)) {
      return current.id;
    }
    current = current.parentId ? nodesById.get(current.parentId) : undefined;
  }
  return null;
}

/** The owning npm package's cluster id, falling back to the directory cluster for untagged trees. */
export function npmPackageClusterId(nodeId: string, nodesById: Map<string, GraphNode>): string {
  return npmPackageIdOf(nodeId, nodesById) ?? clusterIdOf(nodeId, nodesById);
}

/** A cluster's title: the package node's display name, or "(root)" for the package-less fallback. */
export function clusterLabel(clusterId: string, nodesById: Map<string, GraphNode>): string {
  if (clusterId === ROOT_CLUSTER_ID) {
    return ROOT_CLUSTER_ID;
  }
  return nodesById.get(clusterId)?.displayName ?? ROOT_CLUSTER_ID;
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
