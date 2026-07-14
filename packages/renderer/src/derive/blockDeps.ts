/**
 * The module lenses' CODE-BLOCK relationship substrate: the artifact's raw typed edges (service
 * composition, calls, construction, inheritance, references), kept at their real endpoints so a wire can attach to the
 * SPECIFIC code block that uses the dependency — a method, a function, a type definition — not to
 * the class as a whole. Projected onto the visible frontier per level by `liftEdges`: with a
 * method node drawn the wire starts at that method; with only the class card/frame drawn it folds
 * to that unit; the target lands wherever the dependency's DEFINITION currently lives on screen.
 * Built once per artifact (the store caches it beside the import graph). Pure; no React, no ELK.
 */

import type { GraphEdge } from "@meridian/core";
import { parseNodeId } from "@meridian/core";
import { COUPLING_KINDS } from "@meridian/design-metrics";
import type { GraphIndex } from "../graph/graphIndex";
import { liftEdges } from "./liftEdges";

/** The kinds that earn a unit card in the Map (composition's UNIT_KINDS minus `module` — a file is
 * already a card of its own in this lens). */
export const UNIT_CARD_KINDS: ReadonlySet<string> = new Set(["class", "interface", "object"]);

/** The leaf code blocks drawn inside a file or expanded unit frame: callables and type definitions. */
export const BLOCK_KINDS: ReadonlySet<string> = new Set(["function", "method", "typeAlias", "enum"]);

/** The subset of block entities that owns navigation and an in-place Logic expansion. */
export const CALLABLE_BLOCK_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

/** Method-level `implementedBy` is an inverse presentation relationship, not an extra architecture
 * coupling (the owning class→interface `implements` edge already contributes that metric). It still
 * belongs in code-detail dependency wires so an expanded contract can point at each implementation. */
const BLOCK_DEP_KINDS: ReadonlySet<string> = new Set([...COUPLING_KINDS, "implementedBy"]);

export interface BlockDeps {
  /** Every coupling edge at its REAL endpoints, ready for `liftEdges` (built once). */
  edges: GraphEdge[];
}

/** Whether a raw dependency belongs in the current visible-frontier projection. Most relationship
 * kinds may lift from hidden descendants to a visible ancestor. `implementedBy` is intentionally
 * different: it is inverse method-level detail, so it only appears after its contract method is
 * actually drawn (opening the owning interface). This shared gate keeps ordinary wires and both
 * ghost projections from telling the class-level `implements` story twice while collapsed. */
export function isVisibleBlockDepEdge(
  edge: Pick<GraphEdge, "kind" | "source">,
  visible: ReadonlySet<string>,
): boolean {
  return edge.kind !== "implementedBy" || visible.has(edge.source);
}

/** Filter the artifact's coupling edges once (the store caches the result). An `instantiates`
 * edge retargets to the class's own constructor block — `new X()` IS a call to the ctor, so the
 * wire should land on that block when it is drawn (lifting folds it back to the frame otherwise). */
export function buildBlockDeps(index: GraphIndex): BlockDeps {
  const edges = index.edges
    .filter((edge) => BLOCK_DEP_KINDS.has(edge.kind))
    .map((edge) => (edge.kind === "instantiates" ? { ...edge, target: constructionTarget(edge.target, index) } : edge));
  return { edges };
}

/** What each language names its initializer (the open-vocabulary equivalent of `constructor`). */
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["constructor", "__init__"]);

/** Where a CONSTRUCTION really lands: the unit's own constructor block when it has one, else the
 * unit itself. Non-unit targets pass through untouched, so this is safe on any call target. */
export function constructionTarget(targetId: string, index: GraphIndex): string {
  const target = index.nodesById.get(targetId);
  if (!target || !UNIT_CARD_KINDS.has(target.kind)) {
    return targetId;
  }
  const ctor = index.childrenOf(targetId).find((child) => BLOCK_KINDS.has(child.kind) && CONSTRUCTOR_NAMES.has(unitLabel(child.id, index)));
  return ctor?.id ?? targetId;
}

/** A visible-frontier dependency wire, ready for the level's edge set. `kind` is the underlying
 * exact relationship kind so the paint layer can
 * colour and the toggles can filter per relationship type. */
export interface LiftedDepEdge {
  source: string;
  target: string;
  weight: number;
  kind: string;
  /** The artifact edge ids this wire aggregates — the Wire Inspector's trail back to call sites. */
  underlyingEdgeIds: string[];
}

/**
 * Project the coupling edges onto the visible boxes, keeping only wires that TOUCH a drawn code
 * node — a unit card/frame or a block (file↔file pairs are the import graph's story, not this one)
 * — and dropping frame edges (an endpoint that lifted into the other's own containment chain).
 * Aggregates per ordered pair AND kind (so a call and a reference between the same two boxes stay
 * distinct wires — each can wear its own colour and toggle), summing weight within a kind.
 */
export function liftDepEdges(
  blockDeps: BlockDeps,
  visible: ReadonlySet<string>,
  index: GraphIndex,
  isCode: (id: string) => boolean,
): LiftedDepEdge[] {
  const byPair = new Map<string, LiftedDepEdge>();
  // Once the interface opens, the implementation endpoint may still lift to its class until that
  // class is opened too, which keeps progressive disclosure useful.
  const eligible = blockDeps.edges.filter((edge) => isVisibleBlockDepEdge(edge, visible));
  const lifted = liftEdges(eligible, visible, index.parentOf)
    .filter((edge) => isCode(edge.source) || isCode(edge.target))
    .filter((edge) => !index.isWithinFocus(edge.source, edge.target) && !index.isWithinFocus(edge.target, edge.source));
  for (const edge of lifted) {
    const key = `${edge.source} ${edge.target} ${edge.kind}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += edge.weight;
      existing.underlyingEdgeIds.push(...edge.underlyingEdgeIds);
    } else {
      byPair.set(key, { source: edge.source, target: edge.target, weight: edge.weight, kind: edge.kind, underlyingEdgeIds: [...edge.underlyingEdgeIds] });
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
