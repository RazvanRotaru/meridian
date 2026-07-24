import type {
  CallSite,
  ExtractionDiagnostic,
  ExtractionResult,
  ExtractionStats,
  GraphEdge,
  GraphNode,
  LogicFlows,
  Port,
} from "@meridian/core";
import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";

/**
 * The semantic extraction surface used by the differential oracle.
 *
 * Set-like collections have a canonical order, while arrays whose order carries
 * execution meaning (notably flow steps, branch paths, and callback bodies) are
 * preserved exactly. `null` distinguishes an absent optional channel from a
 * present-but-empty one.
 */
export interface SemanticExtractionSnapshot {
  language: ExtractionResult["language"];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: ExtractionStats;
  diagnostics: ExtractionDiagnostic[];
  flows: LogicFlows | null;
  ports: Port[] | null;
}

/** Return a detached, canonically ordered snapshot without mutating the extraction result. */
export function semanticExtractionSnapshot(result: ExtractionResult): SemanticExtractionSnapshot {
  return {
    language: result.language,
    nodes: result.nodes.map(cloneNode).sort((left, right) => compareText(left.id, right.id)),
    edges: result.edges.map(cloneEdge).sort((left, right) => compareText(left.id, right.id)),
    stats: normalizeStats(result.stats),
    diagnostics: result.diagnostics.map(cloneSemanticValue).sort(compareDiagnostic),
    flows: result.flows === undefined ? null : normalizeFlows(result.flows),
    ports: result.ports === undefined ? null : normalizePorts(result.ports),
  };
}

/** Canonical JSON for diagnostics, fixtures, or byte-for-byte differential assertions. */
export function semanticExtractionJson(result: ExtractionResult): string {
  return canonicalJson(semanticExtractionSnapshot(result));
}

/** SHA-256 of the complete semantic snapshot. */
export function semanticExtractionDigest(result: ExtractionResult): string {
  return canonicalJsonSha256(semanticExtractionSnapshot(result));
}

function cloneNode(node: GraphNode): GraphNode {
  return cloneSemanticValue(node);
}

function cloneEdge(edge: GraphEdge): GraphEdge {
  const cloned = cloneSemanticValue(edge);
  cloned.callSites?.sort(compareCallSite);
  return cloned;
}

function compareCallSite(left: CallSite, right: CallSite): number {
  return compareText(left.file, right.file)
    || left.line - right.line
    || compareOptionalNumber(left.col, right.col)
    || compareOptionalNumber(left.endLine, right.endLine)
    || compareOptionalNumber(left.endCol, right.endCol);
}

function compareDiagnostic(left: ExtractionDiagnostic, right: ExtractionDiagnostic): number {
  return compareText(left.severity, right.severity)
    || compareText(left.nodeId ?? "", right.nodeId ?? "")
    || compareText(left.message, right.message);
}

function normalizePorts(ports: readonly Port[]): Port[] {
  return ports
    .map((port) => {
      const value = cloneSemanticValue(port);
      return { key: canonicalJson(value), value };
    })
    .sort((left, right) => compareText(left.key, right.key))
    .map(({ value }) => value);
}

function normalizeFlows(flows: LogicFlows): LogicFlows {
  const normalized: LogicFlows = {};
  for (const nodeId of Object.keys(flows).sort(compareText)) {
    normalized[nodeId] = cloneSemanticValue(flows[nodeId] ?? []);
  }
  return normalized;
}

/**
 * Flow objects contain nested arrays whose order is semantic. Recursively clone
 * them without sorting; object keys are canonicalized at every depth. Optional
 * properties whose value is `undefined` are absent from serialized artifacts
 * and therefore normalize to absence.
 */
function cloneSemanticValue<Value>(value: Value): Value {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSemanticValue(entry)) as Value;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    if (entry === undefined) continue;
    cloned[key] = cloneSemanticValue(entry);
  }
  return cloned as Value;
}

function normalizeStats(stats: ExtractionStats): ExtractionStats {
  return {
    ...stats,
    nodeCountByKind: sortedNumberRecord(stats.nodeCountByKind),
    edgeCountByResolution: sortedNumberRecord(stats.edgeCountByResolution),
    summaryCoverage: { ...stats.summaryCoverage },
  };
}

function sortedNumberRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => compareText(left, right)),
  );
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left - right;
}

/** Locale-independent UTF-16 ordering, matching ordinary JavaScript key ordering. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
