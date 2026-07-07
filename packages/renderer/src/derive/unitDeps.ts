/**
 * The Map lens's UNIT-dependency substrate: which class/interface/object a unit's code depends on
 * (its "service dependencies"), folded from the artifact's coupling edges (calls / instantiates /
 * extends / implements) via design-metrics' unit attribution. Built once per artifact (the store
 * caches it beside the import graph) and projected onto the visible frontier per level, so a unit
 * card can draw a wire to wherever each dependency's DEFINITION currently lives on screen — the
 * dependency's own card when its file is expanded, else the file/package card containing it.
 * Pure; no React, no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import { parseNodeId } from "@meridian/core";
import { couplingEdges, type CouplingEdge } from "@meridian/design-metrics";
import type { GraphIndex } from "../graph/graphIndex";
import { liftEdges } from "./liftEdges";

/** The kinds that earn a unit card in the Map (composition's UNIT_KINDS minus `module` — a file is
 * already a card of its own in this lens). */
export const UNIT_CARD_KINDS: ReadonlySet<string> = new Set(["class", "interface", "object"]);

/** One dependency a unit uses: the unit whose definition the wire should reach. */
export interface UnitDep {
  id: string;
  label: string;
}

export interface UnitDeps {
  /** Every unit→unit dependency pair, pre-shaped for `liftEdges` (built once — never per relayout). */
  edges: GraphEdge[];
  /** Per class/interface/object unit: the units its code depends on, label-sorted. */
  depsByUnit: Map<string, UnitDep[]>;
}

/** Fold the artifact's coupling edges into the unit-dependency substrate (built once, cached). */
export function buildUnitDeps(index: GraphIndex): UnitDeps {
  const pairs = couplingEdges([...index.nodesById.values()], index.edges);
  return { edges: pairs.map(toLiftableEdge), depsByUnit: groupDepsByUnit(pairs, index) };
}

/** The minimal edge shape `liftEdges` folds; only source/target/kind/id are ever read. */
function toLiftableEdge(pair: CouplingEdge): GraphEdge {
  return { id: `udep:${pair.source}->${pair.target}`, source: pair.source, target: pair.target, kind: "dep", resolution: "resolved" } as GraphEdge;
}

function groupDepsByUnit(pairs: CouplingEdge[], index: GraphIndex): Map<string, UnitDep[]> {
  const byUnit = new Map<string, UnitDep[]>();
  for (const pair of pairs) {
    if (!UNIT_CARD_KINDS.has(index.nodesById.get(pair.source)?.kind ?? "")) {
      continue;
    }
    const deps = byUnit.get(pair.source) ?? [];
    deps.push({ id: pair.target, label: unitLabel(pair.target, index) });
    byUnit.set(pair.source, deps);
  }
  for (const deps of byUnit.values()) {
    deps.sort((a, b) => a.label.localeCompare(b.label));
  }
  return byUnit;
}

/** A visible-frontier dependency wire, ready for the level's edge set. */
export interface LiftedDepEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Project the unit-dependency pairs onto the visible boxes, keeping only wires that TOUCH a drawn
 * unit card (file↔file pairs are the import graph's story, not this one) and dropping frame edges
 * (an endpoint that lifted into the other's own containment chain — a wire into one's own frame).
 */
export function liftDepEdges(
  unitDeps: UnitDeps,
  visible: ReadonlySet<string>,
  index: GraphIndex,
  isUnit: (id: string) => boolean,
): LiftedDepEdge[] {
  return liftEdges(unitDeps.edges, visible, index.parentOf)
    .filter((edge) => isUnit(edge.source) || isUnit(edge.target))
    .filter((edge) => !index.isWithinFocus(edge.source, edge.target) && !index.isWithinFocus(edge.target, edge.source))
    .map((edge) => ({ source: edge.source, target: edge.target, weight: edge.weight }));
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
