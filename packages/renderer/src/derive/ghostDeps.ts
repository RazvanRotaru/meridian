/**
 * GHOST relationships for the Map lens: a code-dependency wire whose OTHER end lives outside the
 * drawn level would silently vanish (lifting walks off the canvas) — instead, the off-screen
 * definition (or off-screen caller) appears as a detached dashed GHOST pseudo-card wired to the
 * drawn code, mirroring the Logic tab's caller-ghost satellites. The ghost's node id IS the real
 * artifact id (never a parallel id), so selection and the directed emphasis walk work unchanged.
 * Only endpoints the artifact actually knows (`ext:`/`unresolved:` targets have no definition to
 * chart — honest resolution) become ghosts. Pure; no React, no ELK.
 */

import type { GraphNode } from "@meridian/core";
import type { GraphIndex } from "../graph/graphIndex";
import type { BlockDeps } from "./blockDeps";

/** What a ghost card shows: the symbol's qualified name, its home file, and its kind (glyph tint).
 * A type alias (not an interface) so it satisfies React Flow's Record-typed node-data constraint. */
export type GhostData = {
  label: string;
  context: string;
  ghostKind: string;
};

/** A wire between a drawn code node (or step) and a ghost; endpoints are REAL artifact/step ids. */
export interface GhostWire {
  source: string;
  target: string;
  weight: number;
}

export interface GhostEmission {
  /** Ghost cards keyed by their real artifact id (one per off-screen endpoint). */
  ghosts: Map<string, GhostData>;
  wires: GhostWire[];
}

/**
 * Project every coupling edge that LEAVES the drawn level onto ghosts: an edge whose source lifts
 * to a drawn code node but whose target lifts to nothing ghosts the target (an off-screen
 * dependency); the mirror case ghosts the source (an off-screen dependent). A resolved flow step
 * whose call target is off-screen wires its ghost from the step itself. An expanded block's own
 * frame-level edges are skipped — its steps carry that story, exactly like the lifted dep wires.
 */
export function ghostDepWires(
  blockDeps: BlockDeps,
  calls: ReadonlyArray<{ stepId: string; target: string }>,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  isCode: (id: string) => boolean,
  expandedBlocks: ReadonlySet<string>,
): GhostEmission {
  const ghosts = new Map<string, GhostData>();
  const byPair = new Map<string, GhostWire>();
  const add = (source: string, target: string, ghostId: string, weight: number): void => {
    const node = index.nodesById.get(ghostId);
    if (!node) {
      return; // ext:/unresolved: pseudo-ids have no definition to chart.
    }
    ghosts.set(ghostId, ghostData(node));
    const key = `${source} ${target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += weight;
    } else {
      byPair.set(key, { source, target, weight });
    }
  };
  for (const edge of blockDeps.edges) {
    const sourceVisible = nearestVisible(edge.source, visibleIds, index);
    const targetVisible = nearestVisible(edge.target, visibleIds, index);
    const weight = edge.weight ?? 1;
    if (sourceVisible !== null && targetVisible === null && isCode(sourceVisible) && !expandedBlocks.has(sourceVisible)) {
      add(sourceVisible, edge.target, edge.target, weight);
    }
    if (targetVisible !== null && sourceVisible === null && isCode(targetVisible)) {
      add(edge.source, targetVisible, edge.source, weight);
    }
  }
  // Step-call targets arrive already resolved (constructions point at the constructor block).
  for (const call of calls) {
    if (nearestVisible(call.target, visibleIds, index) === null) {
      add(call.stepId, call.target, call.target, 1);
    }
  }
  return { ghosts, wires: [...byPair.values()] };
}

/** Walk parentId up to the nearest drawn ancestor-or-self; null when the chain leaves the canvas. */
export function nearestVisible(startId: string, visibleIds: ReadonlySet<string>, index: GraphIndex): string | null {
  const seen = new Set<string>();
  let current: string | null | undefined = startId;
  while (current && !seen.has(current)) {
    if (visibleIds.has(current)) {
      return current;
    }
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return null;
}

function ghostData(node: GraphNode): GhostData {
  return {
    label: node.qualifiedName ?? node.displayName ?? node.id,
    context: node.location?.file ?? "",
    ghostKind: node.kind,
  };
}
