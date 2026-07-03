/**
 * The JSON wire contract emitted by `python/analyze.py`. The analyzer is the only producer
 * and this adapter the only consumer, so these types ARE the schema for that boundary.
 */

export type AnalyzeNodeKind = "class" | "function" | "method";

export interface AnalyzeNode {
  kind: AnalyzeNodeKind;
  qualname: string;
  name: string;
  parentQualname: string | null;
  startLine: number;
  endLine: number;
  summary: string | null;
  signature: string | null;
  tags: string[];
}

export type AnalyzeTarget =
  | { resolution: "resolved"; modulePath: string; qualname: string }
  | { resolution: "external"; module: string; name: string }
  | { resolution: "unresolved" };

export interface AnalyzeEdge {
  kind: "call" | "extends";
  sourceQualname: string | null;
  line: number;
  target: AnalyzeTarget;
}

export interface AnalyzeModule {
  modulePath: string;
  file: string;
  nodes: AnalyzeNode[];
  edges: AnalyzeEdge[];
}

export interface AnalyzeOutput {
  language: string;
  modules: AnalyzeModule[];
  diagnostics: string[];
}
