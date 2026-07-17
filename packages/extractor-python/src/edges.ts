/** Apply graph policy to analyzer relationships, then aggregate and collapse them. */

import { aggregateEdges, collapseToDepth, externalTargetId, unresolvedTargetId } from "@meridian/core";
import type { CallSite, EdgeKind, EdgeResolution, ExtractOptions, GraphEdge, GraphNode, RawGraphEdge } from "@meridian/core";
import type { NodeIndex } from "./nodes";
import type { AnalyzeEdge, AnalyzeModule, AnalyzeOutput } from "./types";

const PYTHON_BOUNDARY_ECOSYSTEM = "python";
const UNRESOLVED_TARGET = unresolvedTargetId(PYTHON_BOUNDARY_ECOSYSTEM);

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
  const source = edge.sourceModulePath
    ? index.targetId(edge.sourceModulePath, edge.sourceQualname, edge.sourceLine ?? undefined)
    : index.sourceId(module, edge.sourceQualname, edge.sourceLine);
  if (!source) return null;
  const verdict = resolveTarget(edge, index, options, counters);
  if (!verdict) return null;
  return {
    source,
    target: verdict.target,
    kind: verdict.kind,
    resolution: verdict.resolution,
    callSite: callSiteOf(module, edge),
    confidence: edge.confidence,
  };
}

function resolveTarget(
  edge: AnalyzeEdge,
  index: NodeIndex,
  options: ExtractOptions,
  counters: Counters,
): TargetVerdict | null {
  const target = edge.target;
  if (target.resolution === "resolved") {
    const candidate = index.targetId(target.modulePath, target.qualname, target.targetLine);
    if (candidate) {
      return {
        target: candidate,
        kind: resolvedKind(edge, index.kindById.get(candidate)),
        resolution: "resolved",
      };
    }
    if (index.modulePaths.has(target.modulePath)) return unresolvedVerdict(edge, options, counters);
    return externalVerdict(edge, target.modulePath, target.qualname, options, counters);
  }
  if (target.resolution === "external") {
    return externalVerdict(edge, target.module, target.name, options, counters);
  }
  return unresolvedVerdict(edge, options, counters);
}

function unresolvedVerdict(
  edge: AnalyzeEdge,
  options: ExtractOptions,
  counters: Counters,
): TargetVerdict | null {
  counters.unresolvedCalls += 1;
  return options.includeUnresolved
    ? { target: UNRESOLVED_TARGET, kind: kindOf(edge), resolution: "unresolved" }
    : null;
}

function externalVerdict(
  edge: AnalyzeEdge,
  module: string,
  name: string | null,
  options: ExtractOptions,
  counters: Counters,
): TargetVerdict | null {
  if (!options.includeExternal) {
    counters.externalCallsDropped += 1;
    return null;
  }
  return {
    target: externalTargetId(PYTHON_BOUNDARY_ECOSYSTEM, module, name ?? undefined),
    kind: kindOf(edge),
    resolution: "external",
  };
}

function resolvedKind(edge: AnalyzeEdge, targetKind: string | undefined): EdgeKind {
  if (edge.kind === "call" && targetKind === "class") return "instantiates";
  return kindOf(edge);
}

function kindOf(edge: AnalyzeEdge): EdgeKind {
  if (edge.kind === "extends") return "extends";
  if (edge.kind === "implements") return "implements";
  if (edge.kind === "imports") return "imports";
  if (edge.kind === "reference") return "references";
  return "calls";
}

function callSiteOf(module: AnalyzeModule, edge: AnalyzeEdge): CallSite {
  return {
    file: module.file,
    line: edge.line,
    col: edge.col,
    endLine: edge.endLine,
    endCol: edge.endCol,
  };
}
