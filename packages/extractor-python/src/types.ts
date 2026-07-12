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
  startCol: number;
  summary: string | null;
  signature: string | null;
  tags: string[];
}

export type AnalyzeTarget =
  | { resolution: "resolved"; modulePath: string; qualname: string | null; targetLine?: number }
  | { resolution: "external"; module: string; name: string | null }
  | { resolution: "unresolved" };

export interface AnalyzeEdge {
  kind: "call" | "extends" | "imports" | "reference";
  sourceQualname: string | null;
  sourceLine: number | null;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  target: AnalyzeTarget;
}

export interface AnalyzeModule {
  modulePath: string;
  file: string;
  isPackage: boolean;
  endLine: number;
  nodes: AnalyzeNode[];
  edges: AnalyzeEdge[];
}

export interface AnalyzeOutput {
  language: string;
  modules: AnalyzeModule[];
  diagnostics: string[];
}
