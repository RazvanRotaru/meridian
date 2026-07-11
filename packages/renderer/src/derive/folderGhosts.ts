/**
 * Same-tier ghosts for filesystem folders. A collapsed package card represents every
 * file/symbol below it, so relationships that leave the drawn containment frontier should not
 * explode back into those leaves. Instead, the far endpoint rises to a REAL package at the same
 * absolute package-containment depth as the drawn anchor (or the deepest available package when
 * that tree is shallower).
 *
 * Candidates aggregate by peer package and relationship kind, but every peer survives derivation.
 * Stable artifact-id ordering keeps the output deterministic and each wire carries every
 * underlying edge.
 */

import type { GraphEdge } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import { ghostData, nearestVisible, type GhostEmission, type GhostWire } from "./ghostDeps";
import { graphEdgeCrossesPackage } from "./packageBoundary";

const PACKAGE_KIND = "package";
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const KEY_SEPARATOR = "\u0000";

type FolderWire = GhostWire;

/**
 * Project raw relationships onto visible package anchors and off-level package peers. Edges whose
 * endpoints both reach the visible frontier are deliberately ignored: their ordinary lifted wire
 * already tells the complete story, and neither endpoint is a ghost.
 */
export function folderGhostEmission(
  edges: readonly GraphEdge[],
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  hiddenIds: ReadonlySet<string> = EMPTY_IDS,
): GhostEmission {
  const anchors = new Set(
    [...visibleIds].filter((id) => index.nodesById.get(id)?.kind === PACKAGE_KIND),
  );
  if (anchors.size === 0) {
    return { ghosts: new Map(), wires: [] };
  }

  const byWire = new Map<string, FolderWire>();
  const membersByPeer = new Map<string, Set<string>>();
  for (const edge of edges) {
    // Hidden descendant endpoints must not reappear as a visible ancestor's folder ghost.
    if (hiddenIds.has(edge.source) || hiddenIds.has(edge.target)) {
      continue;
    }
    const sourceVisible = nearestVisible(edge.source, visibleIds, index);
    const targetVisible = nearestVisible(edge.target, visibleIds, index);
    if (sourceVisible !== null && targetVisible !== null) {
      continue;
    }
    if (sourceVisible !== null && targetVisible === null && anchors.has(sourceVisible)) {
      const peer = comparablePackage(edge.target, sourceVisible, index);
      if (peer !== null && peer !== sourceVisible && !visibleIds.has(peer)) {
        addWire(byWire, sourceVisible, peer, edge, index);
        rememberPeerMember(membersByPeer, peer, edge.target, index);
      }
    }
    if (targetVisible !== null && sourceVisible === null && anchors.has(targetVisible)) {
      const peer = comparablePackage(edge.source, targetVisible, index);
      if (peer !== null && peer !== targetVisible && !visibleIds.has(peer)) {
        addWire(byWire, peer, targetVisible, edge, index);
        rememberPeerMember(membersByPeer, peer, edge.source, index);
      }
    }
  }

  const wires = [...byWire.values()]
    .sort(compareWires)
    .map((wire) => ({
      ...wire,
      underlyingEdgeIds: [...wire.underlyingEdgeIds].sort(),
    }));
  const ghostIds = new Set<string>();
  for (const wire of wires) {
    if (!visibleIds.has(wire.source)) ghostIds.add(wire.source);
    if (!visibleIds.has(wire.target)) ghostIds.add(wire.target);
  }
  const ghosts = new Map(
    [...ghostIds]
      .sort()
      .flatMap((id) => {
        const node = index.nodesById.get(id);
        if (node?.kind !== PACKAGE_KIND) return [];
        const members = [...(membersByPeer.get(id) ?? [])].sort();
        return [[id, { ...ghostData(node), ...(members.length > 0 ? { members } : {}) }]] as const;
      }),
  );
  return { ghosts, wires };
}

/** Union independently-derived semantic/folder emissions before the shared finishing pass. */
export function mergeGhostEmissions(...emissions: ReadonlyArray<GhostEmission | null>): GhostEmission {
  const ghosts = new Map<string, ReturnType<typeof ghostData>>();
  const wires: GhostWire[] = [];
  for (const emission of emissions) {
    if (emission === null) continue;
    for (const [id, data] of emission.ghosts) ghosts.set(id, data);
    wires.push(...emission.wires);
  }
  return { ghosts, wires };
}

function addWire(
  byWire: Map<string, FolderWire>,
  source: string,
  target: string,
  edge: GraphEdge,
  index: GraphIndex,
): void {
  const key = [source, target, edge.kind].join(KEY_SEPARATOR);
  const existing = byWire.get(key);
  if (existing) {
    existing.weight += edge.weight ?? 1;
    existing.crossPackage ||= graphEdgeCrossesPackage(edge, index);
    existing.underlyingEdgeIds.push(edge.id);
    return;
  }
  byWire.set(key, {
    source,
    target,
    weight: edge.weight ?? 1,
    kind: edge.kind,
    crossPackage: graphEdgeCrossesPackage(edge, index),
    underlyingEdgeIds: [edge.id],
  });
}

/** Remember the concrete far-end files represented by a folder ghost so its "+" pin has a useful
 * payload even when the comparable peer is above a nested directory and owns no direct modules. */
function rememberPeerMember(membersByPeer: Map<string, Set<string>>, peer: string, endpointId: string, index: GraphIndex): void {
  const moduleId = homeModule(endpointId, index);
  if (moduleId === null) return;
  const members = membersByPeer.get(peer) ?? new Set<string>();
  members.add(moduleId);
  membersByPeer.set(peer, members);
}

function homeModule(id: string, index: GraphIndex): string | null {
  const ancestors = index.ancestorsOf(id);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    if (ancestors[i].kind === "module") return ancestors[i].id;
  }
  return null;
}

/** Pick the package ancestor occupying the anchor's package-containment tier. */
function comparablePackage(endpointId: string, anchorId: string, index: GraphIndex): string | null {
  const desiredDepth = packageAncestors(anchorId, index).length;
  const candidates = packageAncestors(endpointId, index);
  if (desiredDepth === 0 || candidates.length === 0) {
    return null;
  }
  return candidates[Math.min(desiredDepth, candidates.length) - 1]?.id ?? null;
}

function packageAncestors(id: string, index: GraphIndex) {
  return index.ancestorsOf(id).filter((node) => node.kind === PACKAGE_KIND);
}

function compareWires(a: FolderWire, b: FolderWire): number {
  return a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind);
}
