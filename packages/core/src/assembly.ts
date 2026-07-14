/**
 * Language-neutral graph assembly shared by every extractor.
 *
 * Extractors discover raw per-call-site edges and a flat node list; these helpers fold those
 * into the deduped, deterministically-identified edges the schema requires and collapse the
 * graph to a requested drill-down depth. Operating on the public GraphNode/GraphEdge types
 * keeps the rules in one place instead of re-implemented per language.
 */

import { DEPTH_RANK, rankOfKind, type ExtractionDepth } from "./extractor";
import type { CallSite, EdgeKind, EdgeResolution, GraphEdge, GraphNode } from "./types";

export interface RawGraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  resolution: EdgeResolution;
  callSite: CallSite;
}

export function edgeId(kind: string, source: string, target: string): string {
  return `${kind}@${source}|${target}`;
}

/** Fold per-call-site edges by (kind, source, target); weight always equals the call-site count. */
export function aggregateEdges(rawEdges: RawGraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const raw of rawEdges) {
    const id = edgeId(raw.kind, raw.source, raw.target);
    const existing = byKey.get(id);
    if (existing) {
      existing.callSites!.push(raw.callSite);
      existing.weight = existing.callSites!.length;
      continue;
    }
    byKey.set(id, {
      id,
      source: raw.source,
      target: raw.target,
      kind: raw.kind,
      resolution: raw.resolution,
      weight: 1,
      callSites: [raw.callSite],
    });
  }
  return [...byKey.values()];
}

export interface CollapsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Drop nodes deeper than `depth`, re-pointing their edges to the nearest surviving ancestor. */
export function collapseToDepth(nodes: GraphNode[], edges: GraphEdge[], depth: ExtractionDepth): CollapsedGraph {
  const maxRank = DEPTH_RANK[depth];
  const surviving = new Set(nodes.filter((node) => rankOfKind(node.kind) <= maxRank).map((node) => node.id));
  if (surviving.size === nodes.length) {
    return { nodes, edges };
  }
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId ?? null]));
  const liftTo = nearestSurviving(surviving, parentOf);
  return {
    nodes: nodes.filter((node) => surviving.has(node.id)),
    edges: relinkEdges(edges, liftTo, parentOf, surviving),
  };
}

function nearestSurviving(
  surviving: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string | null>,
): (id: string) => string | null {
  return (id: string) => {
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current && !seen.has(current)) {
      if (surviving.has(current)) {
        return current;
      }
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
    return null;
  };
}

function relinkEdges(
  edges: GraphEdge[],
  liftTo: (id: string) => string | null,
  parentOf: ReadonlyMap<string, string | null>,
  surviving: ReadonlySet<string>,
): GraphEdge[] {
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    // This relationship is specifically method-to-method. Lifting it creates a reversed,
    // duplicate class/interface relationship beside the ordinary `implements` edge.
    if (edge.kind === "implementedBy" && (!surviving.has(edge.source) || !surviving.has(edge.target))) {
      continue;
    }
    const source = liftTo(edge.source);
    const target = relinkTarget(edge.target, parentOf, liftTo);
    if (!source || !target || source === target) {
      continue;
    }
    mergeRelinked(merged, edge, source, target);
  }
  return [...merged.values()];
}

// An in-graph target lifts to its nearest surviving ancestor; a boundary pseudo-id target
// (ext:/unresolved:, absent from the node tree) passes through so the edge is not dropped.
function relinkTarget(
  id: string,
  parentOf: ReadonlyMap<string, string | null>,
  liftTo: (id: string) => string | null,
): string | null {
  return parentOf.has(id) ? liftTo(id) : id;
}

function mergeRelinked(merged: Map<string, GraphEdge>, edge: GraphEdge, source: string, target: string): void {
  const id = edgeId(edge.kind, source, target);
  const existing = merged.get(id);
  if (!existing) {
    merged.set(id, { ...edge, id, source, target });
    return;
  }
  existing.weight = (existing.weight ?? 1) + (edge.weight ?? 1);
  if (edge.callSites) {
    existing.callSites = [...(existing.callSites ?? []), ...edge.callSites];
  }
}
