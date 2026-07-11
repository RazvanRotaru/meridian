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
import { UNIT_CARD_KINDS, type BlockDeps } from "./blockDeps";
import { crossesPackageBoundary, graphEdgeCrossesPackage } from "./packageBoundary";

/** What a ghost card shows: the symbol's qualified name, its home file, and its kind (glyph tint).
 * A type alias (not an interface) so it satisfies React Flow's Record-typed node-data constraint. */
export type GhostData = {
  label: string;
  context: string;
  ghostKind: string;
  /** A real folder ghost's contributing home FILES, so main's "+" promotion pins exactly the
   * relationships represented by that folder instead of arbitrary children. */
  members?: string[];
  /** Exact cards represented by a paint-time parent group, used for hover preview and expansion. */
  semanticMembers?: Array<{ id: string; data: GhostData }>;
  /** Stable real-parent expansion key on a paint-time parent anchor; absent on exact child ghosts. */
  ghostGroupId?: string;
  /** Paint-only provenance: the real/synthetic selection seed whose frontier exposed this card.
   * Clicking the ghost keeps these ids as emphasis anchors while selecting the ghost itself. */
  ghostPaintSeedIds?: string[];
  /** Paint-time flag: this ghost IS a selected call step's definition — its border flips to the
   * selection colour (the beacon read). Never set at derive time. */
  beacon?: boolean;
};

/** A wire between a drawn code node (or step) and a ghost; endpoints are REAL artifact/step ids.
 * `kind` is the underlying exact relation kind
 * so an off-level dependency wears the same per-relationship colour as an on-level one. */
export interface GhostWire {
  source: string;
  target: string;
  weight: number;
  kind: string;
  /** True when any original dependency behind the ghost wire crosses package ownership. */
  crossPackage: boolean;
  /** The artifact edge ids behind this wire (empty for step-call ghosts — steps have no edge id). */
  underlyingEdgeIds: string[];
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
  calls: ReadonlyArray<{ stepId: string; blockId: string; target: string }>,
  visibleIds: ReadonlySet<string>,
  index: GraphIndex,
  isCode: (id: string) => boolean,
  expandedBlocks: ReadonlySet<string>,
): GhostEmission {
  const ghosts = new Map<string, GhostData>();
  const byPair = new Map<string, GhostWire>();
  const add = (
    source: string,
    target: string,
    ghostId: string,
    weight: number,
    kind: string,
    edgeId: string | null,
    crossPackage: boolean,
  ): void => {
    const node = index.nodesById.get(ghostId);
    if (!node) {
      return; // ext:/unresolved: pseudo-ids have no definition to chart.
    }
    ghosts.set(ghostId, ghostData(node));
    const key = `${source} ${target} ${kind}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.weight += weight;
      existing.crossPackage ||= crossPackage;
      if (edgeId !== null) {
        existing.underlyingEdgeIds.push(edgeId);
      }
    } else {
      byPair.set(key, { source, target, weight, kind, crossPackage, underlyingEdgeIds: edgeId === null ? [] : [edgeId] });
    }
  };
  for (const edge of blockDeps.edges) {
    const sourceVisible = nearestVisible(edge.source, visibleIds, index);
    const targetVisible = nearestVisible(edge.target, visibleIds, index);
    const weight = edge.weight ?? 1;
    if (sourceVisible !== null && targetVisible === null && isCode(sourceVisible) && !expandedBlocks.has(sourceVisible)) {
      const anchor = semanticAnchor(edge.target, edge.kind, "target", index);
      add(sourceVisible, anchor, anchor, weight, edge.kind, edge.id, graphEdgeCrossesPackage(edge, index));
    }
    if (targetVisible !== null && sourceVisible === null && isCode(targetVisible)) {
      const anchor = semanticAnchor(edge.source, edge.kind, "source", index);
      add(anchor, targetVisible, anchor, weight, edge.kind, edge.id, graphEdgeCrossesPackage(edge, index));
    }
  }
  // Step-call targets arrive already resolved (constructions point at the constructor block).
  for (const call of calls) {
    if (nearestVisible(call.target, visibleIds, index) === null) {
      const anchor = semanticAnchor(call.target, "calls", "target", index);
      add(call.stepId, anchor, anchor, 1, "calls", null, crossesPackageBoundary(call.blockId, call.target, index));
    }
  }
  return { ghosts, wires: [...byPair.values()] };
}

/** Drop hidden ghosts and every wire touching one (a wire into hidden code has nothing to say) —
 * the Tests-toggle filter, applied BEFORE grouping so group counts stay honest. Shared by the Map's
 * ghost level (`moduleTree`) and the minimal-graph overlay's satellite ring. */
export function withoutHidden(emission: GhostEmission, hiddenIds: ReadonlySet<string>, index?: GraphIndex): GhostEmission {
  if (hiddenIds.size === 0) {
    return emission;
  }
  // Production testIds are containment-closed, but accepting an ancestor-only set keeps this helper
  // honest for focused derives/tests and prevents a newly precise method ghost escaping a hidden class.
  const isHidden = (id: string): boolean => hiddenIds.has(id) || (index?.ancestorsOf(id).some((node) => hiddenIds.has(node.id)) ?? false);
  const ghosts = new Map([...emission.ghosts].filter(([id]) => !isHidden(id)));
  const wires = emission.wires.filter((wire) => !isHidden(wire.source) && !isHidden(wire.target));
  return { ghosts, wires };
}

/**
 * Pick the semantic endpoint that best explains this relationship. Execution is callable-specific:
 * a `calls` ghost is the exact called/calling function or method, and the source of `instantiates`
 * remains the exact constructor consumer. Structural relationships read at type granularity:
 * extends/implements endpoints and an instantiated constructor rise to their owning class,
 * interface, or object. References stay exact on both sides; in particular, an incoming reference
 * to a drawn type must identify the function/method using that type rather than its enclosing class.
 * Module targets (the extractor's honest fallback for unemitted symbols/top-level code) have no unit
 * ancestor and therefore pass through unchanged.
 */
function semanticAnchor(id: string, kind: string, role: "source" | "target", index: GraphIndex): string {
  if (kind === "extends" || kind === "implements" || (kind === "instantiates" && role === "target")) {
    return nearestUnit(id, index);
  }
  return id;
}

/** Rise through a constructor/member endpoint to the nearest type definition. If there is no type
 * ancestor (a module fallback, standalone function, or malformed/open-vocabulary endpoint), keep
 * the artifact's exact id rather than inventing a coarser identity. */
function nearestUnit(id: string, index: GraphIndex): string {
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current && !seen.has(current)) {
    if (UNIT_CARD_KINDS.has(index.nodesById.get(current)?.kind ?? "")) {
      return current;
    }
    seen.add(current);
    current = index.parentOf.get(current) ?? null;
  }
  return id;
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

/** What a real artifact node reads as when charted as a ghost card. Exported for the Service
 * lens's cluster-level ghosts (serviceGhosts.ts), which share this one card vocabulary. */
export function ghostData(node: GraphNode): GhostData {
  return {
    label: node.qualifiedName ?? node.displayName ?? node.id,
    context: node.location?.file ?? "",
    ghostKind: node.kind,
  };
}
