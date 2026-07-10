/**
 * The client half of PR-head preparation. `streamPrAnalysis` POSTs the analyze request and reads
 * the server's NDJSON progress stream line-by-line, reporting each clone→checkout→extract stage
 * and resolving with the freshly-extracted graph id (retrievable via `/api/graph?id=`). Pure I/O —
 * no React, no store; the store action orchestrates this behind its stale-seq guard.
 */

export type PrAnalyzeStage = "clone" | "checkout" | "extract";

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
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
