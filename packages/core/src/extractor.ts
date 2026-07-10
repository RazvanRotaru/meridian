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
  exclude?: string[];
  depth?: ExtractionDepth;
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

  async select(root: string, language?: string): Promise<LanguageExtractor | undefined> {
    if (language) {
      return this.byLanguage(language);
    }
    for (const extractor of this.all()) {
      const detection = await extractor.detect(root);
      if (detection.matches) {
        return extractor;
      }
    }
    return undefined;
  }
}
