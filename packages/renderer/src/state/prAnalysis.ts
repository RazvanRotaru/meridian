/**
 * The client half of PR-head preparation. `streamPrAnalysis` POSTs the analyze request and reads
 * the server's NDJSON progress stream line-by-line, reporting each clone→checkout→extract stage
 * and resolving with the freshly-extracted graph id (retrievable via `/api/graph?id=`) plus the
 * head commit the server actually analyzed. Pure I/O — no React, no store; the store action
 * orchestrates this behind its stale-seq guard.
 */

export type PrAnalyzeStage = "clone" | "checkout" | "extract";

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

/** The "done" line's payload: the prepared graph id and the analyzed head commit (provenance —
 * a branch name can drift under a force-push, this SHA cannot; null from an older server). */
export interface PrAnalysisResult {
  graphId: string;
  headSha: string | null;
}

/** POST the analyze request and drain its NDJSON stream, returning the "done" line's payload. */
export async function streamPrAnalysis(
  analyzeUrl: string,
  request: PrAnalyzeRequest,
  onStage: (stage: PrAnalyzeStage) => void,
): Promise<PrAnalysisResult> {
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

/** Read the response body as NDJSON, applying each complete line; return the "done" payload. */
async function drainAnalysisStream(response: Response, onStage: (stage: PrAnalyzeStage) => void): Promise<PrAnalysisResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: PrAnalysisResult | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      result = drainCompleteLines(buffer, onStage) ?? result;
      buffer = trailingPartial(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  result = applyLine(buffer.trim(), onStage) ?? result;
  if (result === null) {
    throw new Error("PR analysis ended without a graph.");
  }
  return result;
}

/** Apply every newline-terminated line in the buffer; return the last done payload one carried (if any). */
function drainCompleteLines(buffer: string, onStage: (stage: PrAnalyzeStage) => void): PrAnalysisResult | null {
  let result: PrAnalysisResult | null = null;
  const lines = buffer.split("\n");
  for (const line of lines.slice(0, -1)) {
    result = applyLine(line.trim(), onStage) ?? result;
  }
  return result;
}

/** The still-incomplete tail after the last newline — carried into the next chunk. */
function trailingPartial(buffer: string): string {
  const lastNewline = buffer.lastIndexOf("\n");
  return lastNewline === -1 ? buffer : buffer.slice(lastNewline + 1);
}

/** Route one NDJSON line: a stage updates progress, "done" yields its payload, "error" throws. */
function applyLine(line: string, onStage: (stage: PrAnalyzeStage) => void): PrAnalysisResult | null {
  const parsed = parseLine(line);
  if (parsed === null) {
    return null;
  }
  if (parsed.stage === "done") {
    return typeof parsed.graphId === "string"
      ? { graphId: parsed.graphId, headSha: typeof parsed.headSha === "string" && parsed.headSha.length > 0 ? parsed.headSha : null }
      : null;
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
  headSha?: string;
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
