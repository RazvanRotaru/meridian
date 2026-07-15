/**
 * The pluggable language-extraction boundary.
 *
 * A `LanguageExtractor` turns a source tree into raw nodes + edges in the graph model. It
 * does NOT write the artifact header (the CLI does). New languages slot in as additional
 * extractors registered with the `ExtractorRegistry`.
 */

import type { LogicFlows } from "./flow";
import type { Port } from "./ports";
import type { GraphEdge, GraphNode, LanguageTag, NodeKind } from "./types";

export interface DetectionResult {
  matches: boolean;
  confidence?: number;
  reason?: string;
}

/** The drill-down level below which structure is collapsed away at extraction time. */
export type ExtractionDepth = "package" | "module" | "class" | "function";

export interface ExtractOptions {
  root: string;
  project?: string;
  include?: string[];
  /** Exact root-relative files that must be admitted in addition to manifest-derived scope.
   * `--changed-since` uses this for changed files outside a solution tsconfig's references. */
  supplementalFiles?: string[];
  exclude?: string[];
  depth?: ExtractionDepth;
  /** Keep library/builtin/package dependency edges as `ext:` boundary targets. */
  includeExternal?: boolean;
  includeUnresolved?: boolean;
  emitImportEdges?: boolean;
  /** Opt-in: emit `references` edges for imported symbols used as plain VALUES (a callback, a
   * const read, a namespace receiver) — the usage the call/new/type/JSX passes don't model. Turns
   * featureless `imports` wires into traceable dependency edges. Off by default (extra type-checker
   * work); the extractor no-ops when unset. */
  valueRefs?: boolean;
}

export interface ExtractionStats {
  files: number;
  nodeCountByKind: Record<string, number>;
  edgeCountByResolution: Record<string, number>;
  summaryCoverage: { withSummary: number; total: number };
  /** Legacy field name; counts all external edges dropped by policy, including imports. */
  externalCallsDropped: number;
  unresolvedCalls: number;
}

export interface ExtractionDiagnostic {
  severity: "warn" | "error";
  message: string;
  nodeId?: string;
}

export interface ExtractionResult {
  language: LanguageTag;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: ExtractionStats;
  diagnostics: ExtractionDiagnostic[];
  /** Per-callable intra-procedural logic flows; the CLI stamps them into `extensions.logicFlow`. */
  flows?: LogicFlows;
  /** Statically detected IPC ports (entries/exits); the CLI stamps them into `extensions.ports`
   * and materializes channel nodes for the literal-channel ones. */
  ports?: Port[];
}

export interface LanguageExtractor {
  readonly language: LanguageTag;
  readonly displayName: string;
  readonly extensions: string[];
  detect(root: string): Promise<DetectionResult>;
  extract(options: ExtractOptions): Promise<ExtractionResult>;
}

/** The rank used by `--depth` to decide which kinds survive a collapse pass. */
export const DEPTH_RANK: Record<ExtractionDepth, number> = {
  package: 0,
  module: 1,
  class: 2,
  function: 3,
};

const KIND_RANK: Record<string, number> = {
  package: 0,
  module: 1,
  namespace: 1,
  class: 2,
  interface: 2,
  enum: 2,
  typeAlias: 2,
  function: 3,
  method: 3,
  promise: 3,
};

export function rankOfKind(kind: NodeKind): number {
  return KIND_RANK[kind] ?? 3;
}

export class ExtractorRegistry {
  private readonly byLang = new Map<string, LanguageExtractor>();

  register(extractor: LanguageExtractor): this {
    this.byLang.set(extractor.language, extractor);
    return this;
  }

  byLanguage(language: string): LanguageExtractor | undefined {
    return this.byLang.get(language);
  }

  all(): LanguageExtractor[] {
    return [...this.byLang.values()];
  }

  async matching(root: string): Promise<LanguageExtractor[]> {
    const extractors = this.all();
    const detections = await Promise.all(extractors.map((extractor) => extractor.detect(root)));
    return extractors.filter((_extractor, index) => detections[index].matches);
  }
}

/** Merge independently extracted languages into one canonical repository graph. */
export function mergeExtractionResults(results: readonly ExtractionResult[]): ExtractionResult {
  if (results.length === 0) throw new Error("cannot merge an empty extraction set");
  const mixed = new Set(results.map((result) => result.language)).size > 1;
  const flows = Object.assign({}, ...results.map((result) => result.flows ?? {}));
  const ports = results.flatMap((result) => result.ports ?? []);
  const merged: ExtractionResult = {
    language: mixed ? "mixed" : results[0].language,
    nodes: results.flatMap((result) => result.nodes.map((node) => (
      mixed && node.language === undefined ? { ...node, language: result.language } : node
    ))),
    edges: results.flatMap((result) => result.edges),
    stats: mergeStats(results.map((result) => result.stats)),
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
  if (Object.keys(flows).length > 0) merged.flows = flows;
  if (ports.length > 0) merged.ports = ports;
  return merged;
}

function mergeStats(stats: readonly ExtractionStats[]): ExtractionStats {
  return {
    files: sum(stats.map((entry) => entry.files)),
    nodeCountByKind: sumRecords(stats.map((entry) => entry.nodeCountByKind)),
    edgeCountByResolution: sumRecords(stats.map((entry) => entry.edgeCountByResolution)),
    summaryCoverage: {
      withSummary: sum(stats.map((entry) => entry.summaryCoverage.withSummary)),
      total: sum(stats.map((entry) => entry.summaryCoverage.total)),
    },
    externalCallsDropped: sum(stats.map((entry) => entry.externalCallsDropped)),
    unresolvedCalls: sum(stats.map((entry) => entry.unresolvedCalls)),
  };
}

function sumRecords(records: readonly Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const record of records) {
    for (const [key, count] of Object.entries(record)) merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
