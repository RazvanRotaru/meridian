/**
 * Resolve one painted wire back to the concrete artifact relationships and syntax occurrences that
 * prove it. Paint passes may lift, fuse, ribbon, route, spool, or bundle edges, but they retain
 * either `underlyingEdgeIds` or their full member edges. This module is the single attribution seam
 * shared by the wire inspector and the source-evidence modal.
 */

import type { Edge } from "@xyflow/react";
import type { CallSite, EdgeKind, GraphEdge, NodeId } from "@meridian/core";
import { BUNDLE_EDGE_TYPE, type BundleEdgeData } from "../layout/edgeBundling";
import { CYCLE_EDGE_TYPE, type CycleEdgeData } from "../layout/cycleFusion";
import { RIBBON_EDGE_TYPE, type RibbonEdgeData } from "../layout/parallelWires";

export interface EdgeEvidenceContext {
  edgeId: string;
  source: NodeId;
  target: NodeId;
  kind: EdgeKind;
  site: CallSite;
}

/** Concrete artifact links behind one painted edge, ordered as the visual aggregate stores them. */
export function artifactLinksForWire(
  wire: Edge,
  edgesById: ReadonlyMap<string, GraphEdge>,
): GraphEdge[] {
  const ids: string[] = [];
  collectUnderlyingIds(wire, ids, new Set<string>());
  const seen = new Set<string>();
  const links: GraphEdge[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const link = edgesById.get(id);
    if (link) links.push(link);
  }
  return links;
}

/**
 * Every truthful source occurrence behind the clicked pair. Pair order is significant: pairOf puts
 * the clicked strand first, so the modal opens on the exact story the reader selected.
 */
export function edgeEvidenceForPair(
  pair: readonly Edge[],
  edgesById: ReadonlyMap<string, GraphEdge>,
): EdgeEvidenceContext[] {
  const contexts: EdgeEvidenceContext[] = [];
  const seen = new Set<string>();
  for (const wire of pair) {
    for (const link of artifactLinksForWire(wire, edgesById)) {
      for (const site of link.callSites ?? []) {
        const context: EdgeEvidenceContext = {
          edgeId: link.id,
          source: link.source,
          target: link.target,
          kind: link.kind,
          site,
        };
        const key = edgeEvidenceKey(context);
        if (!seen.has(key)) {
          seen.add(key);
          contexts.push(context);
        }
      }
    }
  }
  return contexts;
}

/** Source occurrences for one concrete inspector row. */
export function edgeEvidenceForLink(link: GraphEdge): EdgeEvidenceContext[] {
  return (link.callSites ?? []).map((site) => ({
    edgeId: link.id,
    source: link.source,
    target: link.target,
    kind: link.kind,
    site,
  }));
}

export function edgeEvidenceKey(context: EdgeEvidenceContext): string {
  const { site } = context;
  return [
    context.edgeId,
    site.file,
    site.line,
    site.col ?? "",
    site.endLine ?? "",
    site.endCol ?? "",
  ].join(":");
}

/** Compact, exact source label used by the inspector and modal header. */
export function formatCallSite(site: CallSite): string {
  const start = `${site.file}:${site.line}${site.col === undefined ? "" : `:${site.col}`}`;
  if (site.endLine === undefined) {
    return start;
  }
  if (site.endLine === site.line) {
    return site.endCol === undefined || site.col === undefined || site.endCol === site.col
      ? start
      : `${start}–${site.endCol}`;
  }
  const end = site.endCol === undefined ? String(site.endLine) : `${site.endLine}:${site.endCol}`;
  return `${start}–${end}`;
}

function collectUnderlyingIds(wire: Edge, into: string[], visited: Set<string>): void {
  if (visited.has(wire.id)) return;
  visited.add(wire.id);

  const members = aggregateMembers(wire);
  if (members.length > 0) {
    for (const member of members) collectUnderlyingIds(member, into, visited);
    return;
  }
  const ids = (wire.data as { underlyingEdgeIds?: unknown } | undefined)?.underlyingEdgeIds;
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id === "string") into.push(id);
    }
  }
}

function aggregateMembers(wire: Edge): readonly Edge[] {
  if (wire.type === BUNDLE_EDGE_TYPE) {
    return (wire.data as BundleEdgeData).constituents ?? [];
  }
  if (wire.type === RIBBON_EDGE_TYPE) {
    return (wire.data as RibbonEdgeData).members ?? [];
  }
  if (wire.type === CYCLE_EDGE_TYPE) {
    return (wire.data as CycleEdgeData).members ?? [];
  }
  return [];
}
