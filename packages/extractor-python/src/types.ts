/**
 * The JSON wire contract emitted by `python/analyze.py`. The analyzer is the only producer
 * and this adapter the only consumer, so these types ARE the schema for that boundary.
 */

export type AnalyzeNodeKind = "class" | "interface" | "function" | "method";

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
  kind: "call" | "extends" | "implements" | "imports" | "reference";
  confidence?: number;
  sourceModulePath?: string;
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
  flows: AnalyzeFlow[];
}

export interface AnalyzeFlowSource {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface AnalyzeFlowPath {
  label: string;
  role: "then" | "else" | "case" | "default" | "try" | "catch" | "finally";
  pathId: string;
  source?: AnalyzeFlowSource;
  body: AnalyzeFlowStep[];
}

export type AnalyzeFlowStep =
  | (AnalyzeFlowSource & { kind: "call"; label: string; target: AnalyzeTarget; awaited?: boolean })
  | (AnalyzeFlowSource & { kind: "await"; label: string; mode: "single"; inputs: Array<{ label: string }> })
  | (AnalyzeFlowSource & { kind: "loop"; label: string; body: AnalyzeFlowStep[] })
  | (AnalyzeFlowSource & { kind: "callback"; label: string; body: AnalyzeFlowStep[] })
  | (AnalyzeFlowSource & {
      kind: "branch";
      label: string;
      branchKind: "if" | "switch" | "try";
      paths: AnalyzeFlowPath[];
    })
  | (AnalyzeFlowSource & { kind: "exit"; variant: "return" | "throw"; label: string | null });

export interface AnalyzeFlow {
  sourceQualname: string | null;
  sourceLine: number | null;
  steps: AnalyzeFlowStep[];
}

export interface AnalyzeOutput {
  language: string;
  modules: AnalyzeModule[];
  diagnostics: string[];
}
