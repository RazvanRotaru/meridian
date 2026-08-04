/**
 * The client half of PR-head preparation. `streamPrAnalysis` POSTs the analyze request and reads
 * the server's NDJSON progress stream line-by-line, reporting each clone→checkout→extract stage
 * and resolving with the freshly-extracted graph-source ids plus the head commit the server
 * actually analyzed. Progressive consumers project those sources; only the explicit complete
 * benchmark control retrieves artifacts through `/api/graph`. Pure I/O — no React, no store.
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
  progressive?: boolean;
}

/** The "done" payload: immutable graph-source ids and commit provenance for HEAD and its exact
 * merge base. Production accepts only `completeness: "provisional"`; the unmarked legacy shape is
 * parsed so the store can reject/ignore it without following its ids. */
export interface PrAnalysisResult {
  graphId: string;
  comparisonGraphId: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  /** A verified immutable-pair cache result; null when paired with an older server. */
  cache: "hit" | "miss" | null;
  /** The bounded pair can itself be the authoritative terminal for progressive preparation. */
  completeness?: "provisional";
  pairId?: string;
}

/** The immutable bounded pair. `pairId` binds both revision artifacts to one preparation session;
 * the same pair may arrive first as `ready` and then as the authoritative `done` terminal. */
export interface PrAnalysisReadyResult extends Omit<
  PrAnalysisResult,
  "comparisonGraphId" | "headSha" | "mergeBaseSha"
> {
  comparisonGraphId: string;
  headSha: string;
  mergeBaseSha: string;
  pairId: string;
  completeness: "provisional";
}

/** POST the analyze request and drain its NDJSON stream, returning its authoritative terminal. */
export async function streamPrAnalysis(
  analyzeUrl: string,
  request: PrAnalyzeRequest,
  onStage: (stage: PrAnalyzeStage, progress: unknown) => void,
  onLaneComplete: (lane: PrReviewProgressRevisionId) => void = () => undefined,
  /** A progressive analysis publishes its immutable, bounded review pair at `ready` and repeats
   * that same pair in the authoritative terminal. The callback makes the pair actionable while the
   * short stream drains its terminal bookkeeping; no complete graph follows it. */
  onReady: (ready: PrAnalysisReadyResult) => void = () => undefined,
): Promise<PrAnalysisResult> {
  const response = await postAnalyze(analyzeUrl, request);
  return drainAnalysisStream(response, onStage, onLaneComplete, onReady);
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
  onReady: (ready: PrAnalysisReadyResult) => void,
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
      result = drainCompleteLines(buffer, onStage, onLaneComplete, onReady) ?? result;
      buffer = trailingPartial(buffer);
      assertBoundedAnalysisLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  assertBoundedAnalysisLine(buffer);
  result = applyLine(buffer.trim(), onStage, onLaneComplete, onReady) ?? result;
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
  onReady: (ready: PrAnalysisReadyResult) => void,
): PrAnalysisResult | null {
  let result: PrAnalysisResult | null = null;
  const lines = buffer.split("\n");
  for (const line of lines.slice(0, -1)) {
    assertBoundedAnalysisLine(line);
    result = applyLine(line.trim(), onStage, onLaneComplete, onReady) ?? result;
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
  onReady: (ready: PrAnalysisReadyResult) => void,
): PrAnalysisResult | null {
  const parsed = parseLine(line);
  if (parsed === null) {
    return null;
  }
  if (parsed.stage === "done") {
    return analysisResult(parsed);
  }
  if (parsed.stage === "ready") {
    const result = analysisResult(parsed);
    const pairId = nonEmptyString(parsed.pairId);
    const comparisonGraphId = result?.comparisonGraphId ?? null;
    const headSha = result?.headSha ?? null;
    const mergeBaseSha = result?.mergeBaseSha ?? null;
    const ready: PrAnalysisReadyResult | null = result !== null
      && pairId !== null
      && /^[a-f0-9]{20}$/.test(pairId)
      && comparisonGraphId !== null
      && comparisonGraphId !== result.graphId
      && isFullObjectId(headSha)
      && isFullObjectId(mergeBaseSha)
      && parsed.completeness === "provisional"
      ? {
          ...result,
          comparisonGraphId,
          headSha,
          mergeBaseSha,
          pairId,
          completeness: "provisional",
        }
      : null;
    if (ready !== null) onReady(ready);
    return null;
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

function analysisResult(parsed: AnalyzeLine): PrAnalysisResult | null {
  if (typeof parsed.graphId !== "string" || parsed.graphId.length === 0) return null;
  const comparisonGraphId = nonEmptyString(parsed.comparisonGraphId);
  if (comparisonGraphId === parsed.graphId) return null;
  const provisional = parsed.completeness === "provisional";
  const pairId = nonEmptyString(parsed.pairId);
  if (
    parsed.completeness !== undefined
    && (!provisional || pairId === null || !/^[a-f0-9]{20}$/.test(pairId))
  ) {
    return null;
  }
  return {
    graphId: parsed.graphId,
    comparisonGraphId,
    headSha: nonEmptyString(parsed.headSha),
    mergeBaseSha: nonEmptyString(parsed.mergeBaseSha),
    cache: analysisCache(parsed.cache),
    ...(provisional ? { completeness: "provisional" as const, pairId: pairId! } : {}),
  };
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
  pairId?: unknown;
  completeness?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isFullObjectId(value: string | null): value is string {
  return value !== null && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
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
