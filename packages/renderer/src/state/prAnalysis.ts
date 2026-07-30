/**
 * The client half of PR-head preparation. `streamPrAnalysis` POSTs the analyze request and reads
 * the server's NDJSON progress stream line-by-line, reporting each clone→checkout→extract stage
 * and resolving with the freshly-extracted graph id (retrievable via `/api/graph?id=`) plus the
 * head commit the server actually analyzed. Pure I/O — no React, no store; the store action
 * orchestrates this behind its stale-seq guard.
 */

import {
  PR_REVIEW_PROGRESS_STAGE_IDS,
  sanitizePrReviewExtractionProgress,
  type PrReviewProgressRevisionId,
  type PrReviewProgressStage,
} from "@meridian/core";

const MAX_PR_ANALYSIS_LINE_CHARS = 4 * 1024 * 1024;

/** `extract` is the compatibility umbrella emitted before the more precise revision/cache stages. */
export type PrAnalyzeStage = Exclude<
  PrReviewProgressStage,
  "details" | "resolve" | "handoff" | "load-artifacts" | "projection"
>;

/** Renderer-local work before/after the server's streamed immutable-pair stages. */
export type PrPrepareStage = Exclude<PrReviewProgressStage, "details">;

export interface PrAnalyzeRequest {
  id: string;
  prNumber: number;
  baseRef: string;
  headRef: string;
}

/** The "done" payload: immutable graph ids and commit provenance for HEAD and its exact merge base.
 * New comparison fields remain nullable while a browser can still be paired with an older server. */
export interface PrAnalysisResult {
  graphId: string;
  comparisonGraphId: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  /** A verified immutable-pair cache result; null when paired with an older server. */
  cache: "hit" | "miss" | null;
}

/** POST the analyze request and drain its NDJSON stream, returning the "done" line's payload. */
export async function streamPrAnalysis(
  analyzeUrl: string,
  request: PrAnalyzeRequest,
  onStage: (stage: PrAnalyzeStage, progress: unknown) => void,
  onLaneComplete: (lane: PrReviewProgressRevisionId) => void = () => undefined,
): Promise<PrAnalysisResult> {
  const response = await postAnalyze(analyzeUrl, request);
  return drainAnalysisStream(response, onStage, onLaneComplete);
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
async function drainAnalysisStream(
  response: Response,
  onStage: (stage: PrAnalyzeStage, progress: unknown) => void,
  onLaneComplete: (lane: PrReviewProgressRevisionId) => void,
): Promise<PrAnalysisResult> {
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
      result = drainCompleteLines(buffer, onStage, onLaneComplete) ?? result;
      buffer = trailingPartial(buffer);
      assertBoundedAnalysisLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  assertBoundedAnalysisLine(buffer);
  result = applyLine(buffer.trim(), onStage, onLaneComplete) ?? result;
  if (result === null) {
    throw new Error("PR analysis ended without a graph.");
  }
  return result;
}

/** Apply every newline-terminated line in the buffer; return the last done payload one carried (if any). */
function drainCompleteLines(
  buffer: string,
  onStage: (stage: PrAnalyzeStage, progress: unknown) => void,
  onLaneComplete: (lane: PrReviewProgressRevisionId) => void,
): PrAnalysisResult | null {
  let result: PrAnalysisResult | null = null;
  const lines = buffer.split("\n");
  for (const line of lines.slice(0, -1)) {
    assertBoundedAnalysisLine(line);
    result = applyLine(line.trim(), onStage, onLaneComplete) ?? result;
  }
  return result;
}

/** The still-incomplete tail after the last newline — carried into the next chunk. */
function trailingPartial(buffer: string): string {
  const lastNewline = buffer.lastIndexOf("\n");
  return lastNewline === -1 ? buffer : buffer.slice(lastNewline + 1);
}

/** Route one NDJSON line: a stage updates progress, "done" yields its payload, "error" throws. */
function applyLine(
  line: string,
  onStage: (stage: PrAnalyzeStage, progress: unknown) => void,
  onLaneComplete: (lane: PrReviewProgressRevisionId) => void,
): PrAnalysisResult | null {
  const parsed = parseLine(line);
  if (parsed === null) {
    return null;
  }
  if (parsed.stage === "done") {
    return typeof parsed.graphId === "string"
      ? {
          graphId: parsed.graphId,
          comparisonGraphId: nonEmptyString(parsed.comparisonGraphId),
          headSha: nonEmptyString(parsed.headSha),
          mergeBaseSha: nonEmptyString(parsed.mergeBaseSha),
          cache: analysisCache(parsed.cache),
        }
      : null;
  }
  if (parsed.stage === "error") {
    throw new Error(parsed.message ?? "PR analysis failed.");
  }
  if (parsed.stage === "lane-complete") {
    if (isPrReviewProgressRevisionId(parsed.lane)) onLaneComplete(parsed.lane);
    return null;
  }
  if (isPrAnalyzeStage(parsed.stage)) {
    onStage(
      parsed.stage,
      sanitizePrReviewExtractionProgress(parsed.stage, parsed.progress ?? null),
    );
  }
  return null;
}

interface AnalyzeLine {
  stage: string;
  message?: string;
  graphId?: string;
  comparisonGraphId?: string;
  headSha?: string;
  mergeBaseSha?: string;
  cache?: unknown;
  progress?: unknown;
  lane?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function analysisCache(value: unknown): "hit" | "miss" | null {
  return value === "hit" || value === "miss" ? value : null;
}

const PR_ANALYZE_STAGES: readonly PrAnalyzeStage[] = PR_REVIEW_PROGRESS_STAGE_IDS.filter(
  (stage): stage is PrAnalyzeStage =>
    stage !== "details"
    && stage !== "resolve"
    && stage !== "handoff"
    && stage !== "load-artifacts"
    && stage !== "projection",
);

function isPrAnalyzeStage(value: string): value is PrAnalyzeStage {
  return (PR_ANALYZE_STAGES as readonly string[]).includes(value);
}

function isPrReviewProgressRevisionId(value: unknown): value is PrReviewProgressRevisionId {
  return value === "head" || value === "mergeBase";
}

function parseLine(line: string): AnalyzeLine | null {
  if (line.length === 0) {
    return null;
  }
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && typeof (value as AnalyzeLine).stage === "string"
      ? value as AnalyzeLine
      : null;
  } catch {
    return null;
  }
}

function assertBoundedAnalysisLine(line: string): void {
  if (line.length > MAX_PR_ANALYSIS_LINE_CHARS) {
    throw new Error("PR analysis returned an oversized progress line.");
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
