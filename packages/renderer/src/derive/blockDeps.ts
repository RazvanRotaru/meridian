/**
 * The Map lens's CODE-BLOCK dependency substrate: the artifact's raw coupling edges (calls /
 * instantiates / extends / implements), kept at their real endpoints so a wire can attach to the
 * SPECIFIC code block that uses the dependency — a method, a function, a type definition — not to
 * the class as a whole. Projected onto the visible frontier per level by `liftEdges`: with a
 * method node drawn the wire starts at that method; with only the class frame drawn it folds to
 * the frame; the target lands wherever the dependency's DEFINITION currently lives on screen.
 * Built once per artifact (the store caches it beside the import graph). Pure; no React, no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import { parseNodeId } from "@meridian/core";
import { COUPLING_KINDS } from "@meridian/design-metrics";
import type { GraphIndex } from "../graph/graphIndex";
import { liftEdges } from "./liftEdges";

/** The kinds that earn a unit frame in the Map (composition's UNIT_KINDS minus `module` — a file is
 * already a card of its own in this lens). */
export const UNIT_CARD_KINDS: ReadonlySet<string> = new Set(["class", "interface", "object"]);

/** The leaf code blocks drawn inside a file or unit frame: callables and type definitions. */
export const BLOCK_KINDS: ReadonlySet<string> = new Set(["function", "method", "typeAlias", "enum"]);

export interface BlockDeps {
  /** Every coupling edge at its REAL endpoints, ready for `liftEdges` (built once). */
  edges: GraphEdge[];
}

/** Filter the artifact's coupling edges once (the store caches the result). */
export function buildBlockDeps(index: GraphIndex): BlockDeps {
  return { edges: index.edges.filter((edge) => COUPLING_KINDS.has(edge.kind)) };
}

/** A visible-frontier dependency wire, ready for the level's edge set. */
export interface LiftedDepEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Project the coupling edges onto the visible boxes, keeping only wires that TOUCH a drawn code
 * node — a unit frame or a block (file↔file pairs are the import graph's story, not this one) —
 * and dropping frame edges (an endpoint that lifted into the other's own containment chain).
 * Aggregates the per-kind lifted edges to one wire per ordered pair, summing weight.
 */
export function liftDepEdges(
  blockDeps: BlockDeps,
  visible: ReadonlySet<string>,
  index: GraphIndex,
  isCode: (id: string) => boolean,
): LiftedDepEdge[] {
  const byPair = new Map<string, LiftedDepEdge>();
  const lifted = liftEdges(blockDeps.edges, visible, index.parentOf)
    .filter((edge) => isCode(edge.source) || isCode(edge.target))
    .filter((edge) => !index.isWithinFocus(edge.source, edge.target) && !index.isWithinFocus(edge.target, edge.source));
  for (const edge of lifted) {
    const key = `${edge.source} ${edge.target}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += edge.weight;
    } else {
      byPair.set(key, { source: edge.source, target: edge.target, weight: edge.weight });
    }
  }
  return [...byPair.values()];
}

/** A unit/member's display label: its declared name, else the qualname tail of its id (parsed
 * through core's grammar — never a hand split, so `~n` ordinals and grammar changes stay handled). */
export function unitLabel(nodeId: string, index: GraphIndex): string {
  const displayName = index.nodesById.get(nodeId)?.displayName;
  if (displayName) {
    return displayName;
  }
  const parts = parseNodeId(nodeId);
  if (!parts.qualname) {
    // A module-unit dependency (file-level functions): label with the file's basename.
    return parts.modulePath.split("/").pop() ?? parts.modulePath;
  }
  return parts.qualname.split(".").pop() ?? parts.qualname;
}
