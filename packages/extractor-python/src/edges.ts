/**
 * Pass 2 — edges. Each analyzer edge is mapped to a node-id source/target, the
 * external/unresolved drop-or-materialize policy is applied, a `call` to a class becomes
 * `instantiates`, then core folds duplicates (`aggregateEdges`) and collapses to depth.
 */

import { aggregateEdges, buildNodeId, collapseToDepth } from "@meridian/core";
import type { CallSite, EdgeKind, EdgeResolution, ExtractOptions, GraphEdge, GraphNode, RawGraphEdge } from "@meridian/core";
import type { NodeIndex } from "./nodes";
import type { AnalyzeEdge, AnalyzeModule, AnalyzeOutput } from "./types";

const LANG = "py";
const UNRESOLVED_TARGET = buildNodeId({ lang: "unresolved", modulePath: "?" });

interface Counters {
  externalCallsDropped: number;
  unresolvedCalls: number;
}

interface TargetVerdict {
  target: string;
  kind: EdgeKind;
  resolution: EdgeResolution;
}

export interface EdgeResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  externalCallsDropped: number;
  unresolvedCalls: number;
}

export function buildEdges(output: AnalyzeOutput, index: NodeIndex, options: ExtractOptions): EdgeResult {
  const counters: Counters = { externalCallsDropped: 0, unresolvedCalls: 0 };
  const raw: RawGraphEdge[] = [];
  for (const module of output.modules) {
    for (const edge of module.edges) {
      const built = buildRawEdge(module, edge, index, options, counters);
      if (built) raw.push(built);
    }
  }
  const collapsed = collapseToDepth(index.nodes, aggregateEdges(raw), options.depth ?? "function");
  return { nodes: collapsed.nodes, edges: collapsed.edges, ...counters };
}

function buildRawEdge(
  module: AnalyzeModule,
  edge: AnalyzeEdge,
  index: NodeIndex,
  options: ExtractOptions,
  counters: Counters,
): RawGraphEdge | null {
  const source = sourceId(module, edge);
  if (!index.ids.has(source)) return null; // source scope was not emitted (e.g. nested fn)
  const verdict = resolveTarget(edge, index, options, counters);
  if (!verdict) return null;
  return { source, target: verdict.target, kind: verdict.kind, resolution: verdict.resolution, callSite: callSiteOf(module, edge) };
}

function resolveTarget(edge: AnalyzeEdge, index: NodeIndex, options: ExtractOptions, counters: Counters): TargetVerdict | null {
  const target = edge.target;
  if (target.resolution === "resolved") {
    const candidate = buildNodeId({ lang: LANG, modulePath: target.modulePath, qualname: target.qualname });
    if (index.ids.has(candidate)) {
      return { target: candidate, kind: resolvedKind(edge, index.kindById.get(candidate)), resolution: "resolved" };
    }
    return externalVerdict(edge, target.modulePath, target.qualname, options, counters);
  }
  if (target.resolution === "external") {
    return externalVerdict(edge, target.module, target.name, options, counters);
  }
  counters.unresolvedCalls += 1;
  return options.includeUnresolved ? { target: UNRESOLVED_TARGET, kind: kindOf(edge), resolution: "unresolved" } : null;
}

/** A resolved call whose target is a class is really an instantiation; bases stay `extends`. */
function resolvedKind(edge: AnalyzeEdge, targetKind: string | undefined): EdgeKind {
  if (edge.kind === "extends") return "extends";
  return targetKind === "class" ? "instantiates" : "calls";
}

function externalVerdict(
  edge: AnalyzeEdge,
  module: string,
  name: string,
  options: ExtractOptions,
  counters: Counters,
): TargetVerdict | null {
  counters.externalCallsDropped += 1;
  if (!options.includeExternal) return null;
  return { target: buildNodeId({ lang: "ext", modulePath: module, qualname: name }), kind: kindOf(edge), resolution: "external" };
}

function kindOf(edge: AnalyzeEdge): EdgeKind {
  return edge.kind === "extends" ? "extends" : "calls";
}

function sourceId(module: AnalyzeModule, edge: AnalyzeEdge): string {
  return edge.sourceQualname
    ? buildNodeId({ lang: LANG, modulePath: module.modulePath, qualname: edge.sourceQualname })
    : buildNodeId({ lang: LANG, modulePath: module.modulePath });
}

function callSiteOf(module: AnalyzeModule, edge: AnalyzeEdge): CallSite {
  return { file: module.file, line: edge.line };
}
