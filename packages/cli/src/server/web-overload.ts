import type { ServerResponse } from "node:http";
import { AnalysisCoordinatorOverloadedError } from "./web-analysis-coordinator";
import { sendJson } from "./http-response";

const OVERLOAD_RETRY_AFTER_SECONDS = 5;

/** Translate the transport-agnostic admission failure before an HTTP response has started. */
export function sendOverloadJson(response: ServerResponse, error: unknown): boolean {
  if (!(error instanceof AnalysisCoordinatorOverloadedError)) return false;
  sendJson(
    response,
    503,
    { error: error.message },
    { "retry-after": String(OVERLOAD_RETRY_AFTER_SECONDS) },
  );
  return true;
}

/** Preserve an already-started NDJSON response while making overload explicitly retryable. */
export function streamedOverloadLine(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof AnalysisCoordinatorOverloadedError)) return undefined;
  return {
    stage: "error",
    message: error.message,
    retryAfterSeconds: OVERLOAD_RETRY_AFTER_SECONDS,
  };
}
