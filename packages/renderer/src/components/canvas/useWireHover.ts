/**
 * WIRE INTERACTION for the shared canvas — hover naming, the pinned Wire INSPECTOR, and the
 * z-order/visibility dressing every drawn wire wears:
 *
 *   - HOVER: pointing at one strand names it (kind × weight, source → target) and lights it alone —
 *     the disambiguator for strands sharing a bus/trunk. A cheap overlay pass: hover never
 *     recomputes bundling/routing geometry, it only boosts one edge's paint. Bundle highways keep
 *     their own breakdown tooltip, so they opt out; a fused CYCLE names both directions at once and
 *     a RIBBON names its whole cable (the per-kind breakdown IS the tooltip text).
 *   - INSPECTOR: clicking a strand PINS its evidence panel (`WireInspector` — the aggregate's real
 *     links + call sites). The pinned wire stays force-lit like a hover; pane click / Esc unpin —
 *     and so does any change that can remove or reshape the wire. The input `edges` are re-derived
 *     by pure passes over every such change (relayout, focus, a filter/highways toggle, the
 *     SELECTION moving), so unpinning on the array's identity covers them all: a panel attributing
 *     a strand no longer drawn would be a claim the canvas contradicts.
 *   - WIRES GO BEHIND CARDS (every surface): React Flow's default z-mode elevates any edge touching
 *     a NESTED node above every top-level card (basic mode ADDS the child node's z to the edge's
 *     own) — a lit fan into a frame member covered unrelated cards' text. The canvas runs
 *     zIndexMode="manual" (GraphSurface) and this hook sets the rule the eye expects: a wire
 *     CROSSING the canvas travels under everything (z 0); a wire living INSIDE one frame sits at
 *     its nesting depth — above its frame's translucent background, below that frame's own cards.
 *   - HIDDEN wires (an unlit commons strand, opacity 0) render NOTHING — no path, no marker, no hit
 *     area (opacity 0 alone still hit-tests the stroke, so hovering the exact line would flash it
 *     back). They return only when the emphasis pass lights them.
 *
 * A surface that historically had no wire chrome (the minimal overlay) passes `enabled: false` and
 * gets ONLY the z-order dressing back — no hover, no inspector, no pulse, no retype — exactly its
 * pre-unification wires, just correctly under the cards.
 */

import { useEffect, useMemo, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import { pairOf, RIBBON_EDGE_TYPE, type RibbonEdgeData } from "../../layout/parallelWires";
import { CYCLE_EDGE_TYPE, type CycleEdgeData } from "../../layout/cycleFusion";
import { WIRE_EDGE_TYPE } from "../edges/WireEdge";
import type { WireHover } from "../WireTooltip";
import { isGhostHierarchyEdge, isInteractiveSemanticEdge } from "./presentationEdges";
import { relationKindOf } from "../../graph/relationEdge";

export interface WireInteractionApi {
  /** The input edges, z-ordered always; hover/inspector-boosted (and hit-widened) when enabled. */
  edges: Edge[];
  hover: WireHover | null;
  /** The pinned wire's WHOLE ordered pair (a ribbon's members, or a strand + its same-pair
   * siblings) for the inspector — no strand can hide another. Null == no panel pinned. */
  inspectedPair: Edge[] | null;
  /** The drawn label for an on-canvas node id (tooltip + inspector name cards as the reader sees them). */
  labelOf: (id: string) => string | undefined;
  /** Pin a wire's evidence panel (the edge-click gesture; the inspector's drill rows reuse it). */
  inspect: (edge: Edge) => void;
  /** Unpin the inspector (pane clicks compose this with the surface's own pane handler). */
  clearInspected: () => void;
  onEdgeMouseEnter?: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeMouseLeave?: () => void;
  onEdgeClick?: (event: React.MouseEvent, edge: Edge) => void;
}

export function useWireHover(edges: Edge[], nodes: Node[], enabled: boolean): WireInteractionApi {
  const [hover, setHover] = useState<WireHover | null>(null);
  const [inspected, setInspected] = useState<Edge | null>(null);
  // Unpin whenever the wires re-derive (see the header): the pinned strand may no longer be drawn.
  useEffect(() => {
    setInspected(null);
  }, [edges]);

  // Endpoint labels come from the painted nodes so panels name cards as the reader sees them.
  const labelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of nodes) {
      labels.set(node.id, ((node.data as { label?: string }).label ?? node.id.split("/").pop()) as string);
    }
    return labels;
  }, [nodes]);

  const inspectedPair = useMemo(
    () => (inspected === null || isGhostHierarchyEdge(inspected) ? null : pairOf(inspected, edges.filter(isInteractiveSemanticEdge))),
    [inspected, edges],
  );
  const inspectedIds = useMemo(
    () => new Set(inspectedPair === null || inspected === null ? [] : [inspected.id, ...inspectedPair.map((edge) => edge.id)]),
    [inspected, inspectedPair],
  );

  // Each node's top-level ancestor + nesting depth, for the manual wire z-order (see the header).
  const nestingById = useMemo(() => nestingOf(nodes), [nodes]);

  const dressedEdges = useMemo(() => {
    return edges.map((edge) => {
      // GraphSurface normally partitions these before the hook. Keep this guard so another caller
      // cannot accidentally add semantic chrome or interaction state to a disclosure spoke.
      if (isGhostHierarchyEdge(edge)) {
        return edge;
      }
      const zIndex = wireZ(edge, nestingById);
      if (!enabled) {
        return { ...edge, zIndex };
      }
      if (edge.type === BUNDLE_EDGE_TYPE) {
        // A drilled constituent lives INSIDE the highway — boost the owning bundle so the panel's
        // subject still has a visual anchor on canvas.
        const holdsInspected =
          inspectedIds.size > 0 && (edge.data as { constituents?: Edge[] }).constituents?.some((member) => inspectedIds.has(member.id)) === true;
        return holdsInspected ? { ...edge, zIndex, style: { ...edge.style, opacity: 1 } } : { ...edge, zIndex };
      }
      const boosted = edge.id === hover?.id || inspectedIds.has(edge.id);
      if (edge.type === RIBBON_EDGE_TYPE) {
        // The cable boosts as a WHOLE (every stripe lights); its stripes carry their own paint.
        // A fully invisible cable (all stripes opacity 0 — a commons pair at rest) renders NOTHING
        // (data.hidden → RibbonEdge returns null): an opacity-0 SVG path still hit-tests, so a
        // pixel-precise hover would resurrect a wire only a SELECTION may light.
        const anyVisible =
          boosted || ((edge.data as RibbonEdgeData).members ?? []).some((member) => (member.style as { opacity?: number } | undefined)?.opacity !== 0);
        return { ...edge, zIndex, interactionWidth: anyVisible ? 16 : 0, data: { ...edge.data, pulse: true, boosted, hidden: !anyVisible } };
      }
      // An INVISIBLE wire (an unlit commons strand, opacity 0) renders NOTHING (see the header).
      const invisible = (edge.style as { opacity?: number } | undefined)?.opacity === 0 && !boosted;
      return {
        ...edge,
        zIndex,
        // Untyped edges retype to the canvas's own plain curve AFTER the highway passes have
        // claimed theirs — same geometry as the default edge, plus the lit direction pulse.
        // `pulse` is this surface's opt-in: shared edge components draw streaks/chips ONLY where
        // the surface asked for them (the module lenses; never the mostly-lit minimal overlay).
        type: edge.type ?? WIRE_EDGE_TYPE,
        interactionWidth: invisible ? 0 : 14,
        data: { ...edge.data, pulse: true, hidden: invisible },
        style: boosted ? { ...edge.style, opacity: 1, strokeWidth: ((edge.style?.strokeWidth as number) ?? 1.5) + 1.2 } : edge.style,
      };
    });
  }, [edges, hover?.id, inspectedIds, nestingById, enabled]);

  const labelOf = (id: string) => labelById.get(id);
  if (!enabled) {
    return { edges: dressedEdges, hover: null, inspectedPair: null, labelOf, inspect: () => {}, clearInspected: () => {} };
  }

  const onEdgeMouseEnter = (event: React.MouseEvent, edge: Edge) => {
    if (!isInteractiveSemanticEdge(edge) || edge.type === BUNDLE_EDGE_TYPE) {
      setHover(null);
      return;
    }
    setHover({
      id: edge.id,
      x: event.clientX,
      y: event.clientY,
      ...hoverText(edge),
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
    });
  };
  return {
    edges: dressedEdges,
    hover,
    inspectedPair,
    labelOf,
    inspect: (edge) => {
      if (isInteractiveSemanticEdge(edge)) setInspected(edge);
    },
    clearInspected: () => setInspected(null),
    onEdgeMouseEnter,
    onEdgeMouseLeave: () => setHover(null),
    onEdgeClick: (_event, edge) => {
      if (isInteractiveSemanticEdge(edge)) setInspected(edge);
    },
  };
}

/** The tooltip's kind line: a fused cycle names both directions at once; a ribbon breaks its whole
 * cable down per kind; a plain strand is its kind × weight. */
function hoverText(edge: Edge): { kind: string; weight: number } {
  if (edge.type === CYCLE_EDGE_TYPE) {
    const cycle = edge.data as CycleEdgeData;
    return { kind: `⇄ ${cycle.relationKind ?? cycle.depKind ?? "wire"} ×${cycle.forwardWeight}/×${cycle.backwardWeight}`, weight: 1 };
  }
  if (edge.type === RIBBON_EDGE_TYPE) {
    const members = (edge.data as RibbonEdgeData).members ?? [];
    const breakdown = [...members]
      .sort((a, b) => ((b.data as { weight?: number })?.weight ?? 1) - ((a.data as { weight?: number })?.weight ?? 1))
      .map((member) => {
        const data = member.data as { weight?: number } | undefined;
        const weight = data?.weight ?? 1;
        return `${relationKindOf(member.data) ?? "wire"}${weight > 1 ? ` ×${weight}` : ""}`;
      })
      .join(" · ");
    return { kind: breakdown, weight: 1 };
  }
  const data = edge.data as { weight?: number } | undefined;
  return { kind: relationKindOf(edge.data) ?? "wire", weight: data?.weight ?? 1 };
}

/** Each node's top-level ancestor + nesting depth (cycle-guarded — the lenient viewer tolerates
 * parentId cycles, so the climb must not spin). */
function nestingOf(nodes: Node[]): Map<string, { top: string; depth: number }> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId]));
  const info = new Map<string, { top: string; depth: number }>();
  for (const node of nodes) {
    let current = node.id;
    let depth = 0;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentOf.get(current);
      if (parent === null || parent === undefined || !parentOf.has(parent)) {
        break;
      }
      current = parent;
      depth += 1;
    }
    info.set(node.id, { top: current, depth });
  }
  return info;
}

/** Manual z for one wire: cross-canvas travels under everything; intra-frame sits at its depth. */
function wireZ(edge: Edge, nestingById: Map<string, { top: string; depth: number }>): number {
  const source = nestingById.get(edge.source);
  const target = nestingById.get(edge.target);
  if (!source || !target || source.top !== target.top) {
    return 0; // cross-canvas: under everything
  }
  return Math.max(source.depth, target.depth); // intra-frame: above the frame, below its cards
}
