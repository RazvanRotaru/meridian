/**
 * The client half of PR-impact analysis. `streamPrAnalysis` POSTs the analyze request and reads the
 * server's NDJSON progress stream line-by-line, reporting each clone→checkout→extract stage and
 * returning the freshly-extracted graph id. `buildPrAnalysis` then loads that graph and derives the
 * minimal subgraph of modified modules plus the directly-affected logic flows. Pure I/O + derives;
 * no React, no store — the store action orchestrates these behind its stale-seq guard.
 */

import type { GraphArtifact, LogicFlows } from "@meridian/core";
import type { Edge, Node } from "@xyflow/react";
import { buildGraphIndex } from "../graph/graphIndex";
import { derivePrMinimalGraph } from "../derive/prMinimalGraph";
import { computeAffectedFlows, type AffectedFlow } from "../derive/affectedFlows";

export type PrAnalyzeStage = "clone" | "checkout" | "extract";

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

export interface PrAnalysis {
  nodes: Node[];
  edges: Edge[];
  flows: AffectedFlow[];
}

/** POST the analyze request and drain its NDJSON stream, returning the "done" line's graph id. */
export async function streamPrAnalysis(
  analyzeUrl: string,
  request: PrAnalyzeRequest,
  onStage: (stage: PrAnalyzeStage) => void,
): Promise<string> {
  const response = await postAnalyze(analyzeUrl, request);
  return drainAnalysisStream(response, onStage);
}

/** Load the extracted PR graph and derive its minimal-graph + affected-flow view. */
export async function buildPrAnalysis(graphUrl: string, graphId: string): Promise<PrAnalysis> {
  const artifact = await fetchPrGraph(graphUrl, graphId);
  const index = buildGraphIndex(artifact);
  const flows = (artifact.extensions?.logicFlow ?? {}) as unknown as LogicFlows;
  const graph = await derivePrMinimalGraph(index, artifact);
  const affected = computeAffectedFlows(artifact.nodes, flows, index.changedIds);
  return { nodes: graph.nodes, edges: graph.edges, flows: affected };
}

async function postAnalyze(analyzeUrl: string, request: PrAnalyzeRequest): Promise<Response> {
  const response = await fetch(new URL(analyzeUrl, requestOrigin()), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) {
    throw new Error(await requestErrorMessage(response));
  }
  return response;
}

async function fetchPrGraph(graphUrl: string, graphId: string): Promise<GraphArtifact> {
  const url = new URL(graphUrl, requestOrigin());
  url.searchParams.set("id", graphId);
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Could not load the analyzed PR graph (${response.status}).`);
  }
  return (await response.json()) as GraphArtifact;
}

/** Read the response body as NDJSON, applying each complete line; return the "done" graph id. */
async function drainAnalysisStream(response: Response, onStage: (stage: PrAnalyzeStage) => void): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let graphId: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      graphId = drainCompleteLines(buffer, onStage) ?? graphId;
      buffer = trailingPartial(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  graphId = applyLine(buffer.trim(), onStage) ?? graphId;
  if (graphId === null) {
    throw new Error("PR analysis ended without a graph.");
  }
  return graphId;
}

/** Apply every newline-terminated line in the buffer; return the last graph id one carried (if any). */
function drainCompleteLines(buffer: string, onStage: (stage: PrAnalyzeStage) => void): string | null {
  let graphId: string | null = null;
  const lines = buffer.split("\n");
  for (const line of lines.slice(0, -1)) {
    graphId = applyLine(line.trim(), onStage) ?? graphId;
  }
  return graphId;
}

/** The still-incomplete tail after the last newline — carried into the next chunk. */
function trailingPartial(buffer: string): string {
  const lastNewline = buffer.lastIndexOf("\n");
  return lastNewline === -1 ? buffer : buffer.slice(lastNewline + 1);
}

/** Route one NDJSON line: a stage updates progress, "done" yields the graph id, "error" throws. */
function applyLine(line: string, onStage: (stage: PrAnalyzeStage) => void): string | null {
  const parsed = parseLine(line);
  if (parsed === null) {
    return null;
  }
  if (parsed.stage === "done") {
    return typeof parsed.graphId === "string" ? parsed.graphId : null;
  }
  if (parsed.stage === "error") {
    throw new Error(parsed.message ?? "PR analysis failed.");
  }
  onStage(parsed.stage);
  return null;
}

interface AnalyzeLine {
  stage: PrAnalyzeStage | "done" | "error";
  message?: string;
  graphId?: string;
}

function parseLine(line: string): AnalyzeLine | null {
  if (line.length === 0) {
    return null;
  }
  try {
    const value = JSON.parse(line) as AnalyzeLine;
    return typeof value.stage === "string" ? value : null;
  } catch {
    return null;
  }
}

/** A pre-stream failure comes back as a normal JSON error body; fall back to the status line. */
async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.length > 0) {
      return data.error;
    }
  } catch {
    // Non-JSON body — fall through to the generic message.
  }
  return `PR analysis request failed (${response.status}).`;
}

function requestOrigin(): string {
  return typeof window === "undefined" ? "http://meridian.local" : window.location.origin;
}
