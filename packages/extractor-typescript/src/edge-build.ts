/**
 * Aggregation + the external/unresolved policy. Resolved edges always materialize; external
 * and unresolved ones are dropped (and counted) by default, or materialized as `ext:` /
 * sentinel targets when the caller opts in. Edges fold by (kind, source, target) so weight
 * stays equal to the call-site count.
 */

import { buildNodeId } from "@meridian/core";
import type { CallSite, EdgeResolution, ExtractOptions, GraphEdge } from "@meridian/core";
import { aggregationKey, edgeId } from "./edge-id";
import type { RawEdge } from "./edge-pass";

// The reserved `unresolved:` pseudo-lang (ADR 0001) so consumers can tell a boundary target
// apart from a real in-graph `ts:` node by its prefix.
const UNRESOLVED_TARGET = buildNodeId({ lang: "unresolved", modulePath: "?" });

interface AggregatedEdge {
  source: string;
  target: string;
  kind: string;
  resolution: EdgeResolution;
  callSites: CallSite[];
}

export interface EdgeBuildResult {
  edges: GraphEdge[];
  externalCallsDropped: number;
  unresolvedCalls: number;
}

export function buildEdges(rawEdges: RawEdge[], options: ExtractOptions): EdgeBuildResult {
  const aggregator = new Map<string, AggregatedEdge>();
  let externalCallsDropped = 0;
  let unresolvedCalls = 0;
  for (const raw of rawEdges) {
    if (raw.resolution.resolution === "unresolved") unresolvedCalls += 1;
    const target = targetFor(raw, options);
    if (target === null) {
      if (raw.resolution.resolution === "external") externalCallsDropped += 1;
      continue;
    }
    accumulate(aggregator, raw, target);
  }
  return { edges: [...aggregator.values()].map(toGraphEdge), externalCallsDropped, unresolvedCalls };
}

function targetFor(raw: RawEdge, options: ExtractOptions): string | null {
  switch (raw.resolution.resolution) {
    case "resolved":
      return raw.resolution.resolvedTarget;
    case "external":
      return options.includeExternal ? externalTarget(raw) : null;
    default:
      return options.includeUnresolved ? UNRESOLVED_TARGET : null;
  }
}

function externalTarget(raw: RawEdge): string {
  return buildNodeId({
    lang: "ext",
    modulePath: raw.resolution.externalModulePath ?? "unknown",
    qualname: raw.resolution.externalQualname ?? undefined,
  });
}

function accumulate(aggregator: Map<string, AggregatedEdge>, raw: RawEdge, target: string): void {
  const key = aggregationKey(raw.kind, raw.source, target);
  const existing = aggregator.get(key);
  if (existing) {
    existing.callSites.push(raw.callSite);
    return;
  }
  aggregator.set(key, {
    source: raw.source,
    target,
    kind: raw.kind,
    resolution: raw.resolution.resolution,
    callSites: [raw.callSite],
  });
}

function toGraphEdge(edge: AggregatedEdge): GraphEdge {
  return {
    id: edgeId(edge.kind, edge.source, edge.target),
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    resolution: edge.resolution,
    weight: edge.callSites.length,
    callSites: edge.callSites,
  };
}
