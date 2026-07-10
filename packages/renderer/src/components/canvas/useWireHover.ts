/**
 * Wire HOVER: pointing at one strand names it (kind × weight, source → target) and lights it
 * alone — the disambiguator for strands sharing a bus/trunk. A cheap overlay pass: hover never
 * recomputes bundling/routing geometry, it only boosts one edge's paint. Bundle highways keep
 * their own breakdown tooltip, so they opt out of this one. Extracted from ModuleMapView for the
 * shared GraphSurface; a surface that historically had no hover (the minimal overlay) passes
 * `enabled: false` and gets its edges back untouched — no interactionWidth, no handlers.
 */

import { useMemo, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { BUNDLE_EDGE_TYPE } from "../../layout/edgeBundling";
import type { WireHover } from "../WireTooltip";

export interface WireHoverApi {
  /** The input edges, hover-boosted (and hit-widened) when enabled; untouched otherwise. */
  edges: Edge[];
  hover: WireHover | null;
  onEdgeMouseEnter?: (event: React.MouseEvent, edge: Edge) => void;
  onEdgeMouseLeave?: () => void;
}

export function useWireHover(edges: Edge[], nodes: Node[], enabled: boolean): WireHoverApi {
  const [hover, setHover] = useState<WireHover | null>(null);
  // Endpoint labels come from the painted nodes so the tooltip names cards as the reader sees them.
  const labelById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of nodes) {
      labels.set(node.id, ((node.data as { label?: string }).label ?? node.id.split("/").pop()) as string);
    }
    return labels;
  }, [nodes]);
  const hoverableEdges = useMemo(() => {
    if (!enabled) {
      return edges;
    }
    return edges.map((edge) => {
      if (edge.type === BUNDLE_EDGE_TYPE) {
        return edge;
      }
      const hovered = edge.id === hover?.id;
      return {
        ...edge,
        interactionWidth: 14,
        style: hovered ? { ...edge.style, opacity: 1, strokeWidth: ((edge.style?.strokeWidth as number) ?? 1.5) + 1.2 } : edge.style,
      };
    });
  }, [edges, hover?.id, enabled]);
  if (!enabled) {
    return { edges: hoverableEdges, hover: null };
  }
  const onEdgeMouseEnter = (event: React.MouseEvent, edge: Edge) => {
    if (edge.type === BUNDLE_EDGE_TYPE) {
      return;
    }
    const data = edge.data as { depKind?: string; category?: string; weight?: number } | undefined;
    setHover({
      id: edge.id,
      x: event.clientX,
      y: event.clientY,
      kind: data?.depKind ?? data?.category ?? "wire",
      weight: data?.weight ?? 1,
      source: labelById.get(edge.source) ?? edge.source,
      target: labelById.get(edge.target) ?? edge.target,
    });
  };
  return { edges: hoverableEdges, hover, onEdgeMouseEnter, onEdgeMouseLeave: () => setHover(null) };
}
