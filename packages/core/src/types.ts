/**
 * The GraphArtifact contract, as TypeScript types.
 *
 * These mirror the zod schema in `schema.ts` one-to-one. They are hand-authored (rather
 * than `z.infer`-derived) so that the OPEN vocabularies — node kinds, edge kinds, language
 * tags — keep their well-known literals for editor autocomplete via `(string & {})` while
 * still accepting any string a future language adapter needs.
 */

export const SCHEMA_VERSION = "1.1.0" as const;

export type LanguageTag =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "csharp"
  | "mixed"
  | (string & {});

export type NodeKind =
  | "package"
  | "module"
  | "namespace"
  | "class"
  | "interface"
  | "enum"
  | "typeAlias"
  | "function"
  | "method"
  | "promise"
  | (string & {});

export type EdgeKind =
  | "registers"
  | "binds"
  | "provides"
  | "injects"
  | "owns"
  | "aliases"
  | "calls"
  | "references"
  | "imports"
  | "extends"
  | "implements"
  | "implementedBy"
  | "instantiates"
  | "createsPromise"
  | "returnsPromise"
  | "awaitsPromise"
  | "resolvesPromise"
  | "rejectsPromise"
  | (string & {});

/** A complete, language-independent classification of how confidently an edge was resolved. */
export type EdgeResolution = "resolved" | "external" | "unresolved";

export type NodeId = string;

export interface Generator {
  name: string;
  version: string;
}

export interface VcsInfo {
  repository?: string;
  commit?: string;
  branch?: string;
  dirty?: boolean;
}

export interface Target {
  name: string;
  version?: string;
  root: string;
  language: LanguageTag;
  vcs?: VcsInfo;
}

/** The org rule, machine-encoded: service/environment never live in the artifact. */
export interface TelemetryContract {
  joinKey: "node.id";
  requiredRuntimeAttributes: string[];
  serviceDefaulting: "forbidden";
  semconvVersion?: string;
}

export interface SourceLocation {
  file: string;
  startLine: number;
  endLine?: number;
  startCol?: number;
}

/** Per-node OTel join coordinates, emitted on function|method nodes only. */
export interface TelemetryKey {
  codeNamespace?: string | null;
  codeFunction: string;
  spanNameHints: string[];
}

export interface GraphNode {
  id: NodeId;
  kind: NodeKind;
  qualifiedName: string;
  displayName: string;
  summary?: string | null;
  parentId?: NodeId | null;
  language?: LanguageTag;
  location: SourceLocation;
  signature?: string;
  tags?: string[];
  telemetry?: TelemetryKey;
}

export interface CallSite {
  file: string;
  /** Inclusive 1-based start line of the syntax occurrence that proves this edge. */
  line: number;
  /** Inclusive start column when the extractor can recover it. */
  col?: number;
  /** Line containing the end of the syntax occurrence. Omitted by point-only extractors. */
  endLine?: number;
  /** Exclusive end column on `endLine`. Requires both `col` and `endLine`. */
  endCol?: number;
}

export interface GraphEdge {
  id: string;
  source: NodeId;
  target: NodeId;
  kind: EdgeKind;
  resolution?: EdgeResolution;
  weight?: number;
  callSites?: CallSite[];
  confidence?: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GraphArtifact {
  schemaVersion: string;
  generatedAt: string;
  generator: Generator;
  target: Target;
  telemetry?: TelemetryContract;
  nodes: GraphNode[];
  edges: GraphEdge[];
  extensions?: Record<string, JsonValue>;
}
