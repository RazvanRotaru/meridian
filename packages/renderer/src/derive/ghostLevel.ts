/**
 * The shared GHOST TIER over a walked module surface (extracted from moduleTree so the Map and the
 * Service lens emit the SAME projection): every coupling wire whose far end left the drawn skeleton
 * charts as a detached dashed ghost card instead of silently vanishing. The pipeline is fixed —
 * raw emission (`ghostDepWires`) → Tests-toggle filter (`withoutHidden`) → same-folder folding
 * (`groupGhostEmission`) → materialized nodes/edges — with a seam after the raw step so a surface
 * can drop ghosts it represents some OTHER way (the Service lens's drawn cluster frames).
 * Ghost ids are always REAL artifact ids. Pure; no React, no ELK.
 */

import type { GraphIndex } from "../graph/graphIndex";
import type { BlockDeps } from "./blockDeps";
import type { CodeWalk, Skeleton } from "./codeWalk";
import { ghostDepWires, withoutHidden, type GhostData, type GhostEmission } from "./ghostDeps";
import { groupGhostEmission } from "./groupGhosts";
import type { ModuleTreeEdge, VisibleModuleNode } from "./moduleTreeTypes";

/** The ghost tier's yield, ready to append to a derived module tree. */
export interface GhostTier {
  nodes: VisibleModuleNode[];
  edges: ModuleTreeEdge[];
}

export const EMPTY_GHOST_TIER: GhostTier = { nodes: [], edges: [] };

/** A drawn box a dependency wire may anchor to: code nodes and file cards — package groups use
 * the package-level dep path, which lifts deps cleanly without code-level restrictions. */
export function isDepAnchorKind(kind: Skeleton["kind"] | undefined): boolean {
  return kind === "unit" || kind === "block" || kind === "file";
}

/** The one-call path (the Map): raw → hidden filter → grouping → materialize. */
export function ghostLevel(
  blockDeps: BlockDeps,
  walked: CodeWalk,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
  hiddenIds: ReadonlySet<string>,
): GhostTier {
  const raw = rawGhostEmission(blockDeps, walked, visibleIds, index, kinds);
  return raw === null ? EMPTY_GHOST_TIER : finishGhostTier(raw, index, hiddenIds);
}

/** The raw off-level projection, before any filtering/folding; null when no dep anchor is drawn
 * (the common code-less level skips the whole pass). */
export function rawGhostEmission(
  blockDeps: BlockDeps,
  walked: CodeWalk,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  kinds: Map<string, Skeleton["kind"]>,
): GhostEmission | null {
  if (![...kinds.values()].some(isDepAnchorKind)) {
    return null;
  }
  const isDepAnchor = (id: string) => isDepAnchorKind(kinds.get(id));
  return ghostDepWires(blockDeps, walked.calls, visibleIds, index, isDepAnchor, walked.expandedBlocks);
}

/** Hidden (test) ghosts drop BEFORE grouping so group counts stay honest, then same-folder ghosts
 * fold into one group card (the Highways treatment for the ghost tier — see groupGhosts.ts). */
export function finishGhostTier(emission: GhostEmission, index: GraphIndex, hiddenIds: ReadonlySet<string>): GhostTier {
  const grouped = groupGhostEmission(withoutHidden(emission, hiddenIds), index);
  const nodes = [...grouped.ghosts.entries()].map(([id, data]) => ghostNodeOf(id, data));
  const edges: ModuleTreeEdge[] = grouped.wires.map((wire) => ({
    id: `gdep:${wire.kind}:${wire.source}->${wire.target}`,
    source: wire.source,
    target: wire.target,
    weight: wire.weight,
    crossFrame: false,
    crossPackage: wire.crossPackage,
    outsideView: true,
    category: "dep",
    depKind: wire.kind,
    ghost: true,
    // The artifact edges behind this wire — the Wire Inspector's evidence trail (every surface's
    // ghost tier funnels through here, so ghost wires are attributable on Map, Service, and UI).
    underlyingEdgeIds: wire.underlyingEdgeIds,
  }));
  return { nodes, edges };
}

/** A detached ghost card as a tree node — always root-level, never a container. */
export function ghostNodeOf(id: string, data: GhostData): VisibleModuleNode {
  return { id, parentId: null, kind: "ghost", isContainer: false, isExpanded: false, depth: 0, childCount: 0, data };
}
