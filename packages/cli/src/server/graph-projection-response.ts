/** One bounded HTTP transport for graph projections in both web and standalone servers. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { GRAPH_PROJECTION_MAX_REQUEST_BYTES } from "@meridian/core";
import { boundedJsonChunks } from "./bounded-json";
import {
  canonicalizeGraphProjectionRequest,
  GraphProjectionRequestError,
  type GraphProjectionBundle,
  type GraphProjectionQueryOptions,
  type GraphProjectionResult,
  type GraphProjectionRequest,
} from "./graph-projection-bundle";
import { WebError } from "./web-error";
import { cancelWhenClientLeaves } from "./web-cancellation";
import { readJsonBody } from "./web-request";
import { WeightedAdmission } from "./weighted-admission";

const PROJECTION_RESULT_RESIDENT_MULTIPLIER = 3;
const PROJECTION_STREAM_TRANSIENT_MULTIPLIER = 4;
export const GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_GRAPH_PROJECTION_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

export interface SendGraphProjectionOptions {
  readonly admission: WeightedAdmission;
  readonly bundle: GraphProjectionBundle;
  readonly input: GraphProjectionRequest;
  readonly response: ServerResponse;
  readonly signal: AbortSignal;
  readonly queryOptions?: GraphProjectionQueryOptions;
}

export interface HandleGraphProjectionRequestOptions {
  readonly admission: WeightedAdmission;
  readonly bundle: GraphProjectionBundle;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly queryOptions?: GraphProjectionQueryOptions;
  /** Server shutdown plus any external graph-ownership loss. */
  readonly lifecycleSignal: AbortSignal;
}

/**
 * Reserve the result object's resident upper bound plus a fixed streaming encoder/socket window.
 * The lease remains live through socket completion. The transport serializes one bounded chunk at
 * a time, so it never needs another response-sized allocation or retains a completed value.
 */
export function graphProjectionReservationBytes(request: Pick<GraphProjectionRequest, "maxResponseBytes">): number {
  if (!Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 1) {
    throw new RangeError("graph projection response budget must be a positive safe integer");
  }
  const reservation = request.maxResponseBytes * PROJECTION_RESULT_RESIDENT_MULTIPLIER
    + GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES * PROJECTION_STREAM_TRANSIENT_MULTIPLIER;
  if (!Number.isSafeInteger(reservation)) {
    throw new RangeError("graph projection memory reservation exceeds the safe integer range");
  }
  return reservation;
}

export function createGraphProjectionAdmission(
  capacity = DEFAULT_GRAPH_PROJECTION_MEMORY_BUDGET_BYTES,
): WeightedAdmission {
  return new WeightedAdmission(capacity);
}

/** The sole HTTP request lifecycle for both web and standalone projection routes. */
export async function handleGraphProjectionRequest(
  options: HandleGraphProjectionRequestOptions,
): Promise<void> {
  const body = await readJsonBody({
    request: options.request,
    signal: options.lifecycleSignal,
    maxBytes: GRAPH_PROJECTION_MAX_REQUEST_BYTES,
  });
  const cancellation = cancelWhenClientLeaves(
    options.request,
    options.response,
    "The client closed the graph projection request",
  );
  const operationSignal = AbortSignal.any([cancellation.signal, options.lifecycleSignal]);
  try {
    await sendGraphProjectionResponse({
      admission: options.admission,
      bundle: options.bundle,
      input: body as GraphProjectionRequest,
      response: options.response,
      signal: operationSignal,
      ...(options.queryOptions ? { queryOptions: options.queryOptions } : {}),
    });
  } finally {
    cancellation.dispose();
  }
}

export async function sendGraphProjectionResponse(options: SendGraphProjectionOptions): Promise<void> {
  let request: GraphProjectionRequest;
  try {
    request = canonicalizeGraphProjectionRequest(options.input);
  } catch (error) {
    throwAsWebRequestError(error);
  }

  options.signal.throwIfAborted();
  const lease = options.admission.tryAcquire(graphProjectionReservationBytes(request));
  if (lease === null) {
    options.response.setHeader("retry-after", "1");
    throw new WebError(503, "graph projection memory budget is busy; retry later");
  }

  try {
    options.signal.throwIfAborted();
    const queryStarted = performance.now();
    let result: GraphProjectionResult;
    try {
      result = await options.bundle.query(request, options.signal, options.queryOptions);
    } catch (error) {
      throwAsWebRequestError(error);
    }
    options.signal.throwIfAborted();
    const queryMs = performance.now() - queryStarted;

    options.response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-meridian-projection-id": result.projectionId,
      "x-meridian-resident-bytes": String(result.residentBytes),
      "server-timing": `projection_query;dur=${queryMs.toFixed(2)}`,
    });
    await writeBoundedJson(options.response, result, options.signal);
  } finally {
    lease.release();
  }
}

function throwAsWebRequestError(error: unknown): never {
  if (error instanceof GraphProjectionRequestError) {
    throw new WebError(error.status, error.message);
  }
  throw error;
}

async function writeBoundedJson(
  response: ServerResponse,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  for (const chunk of boundedJsonChunks(value, GRAPH_PROJECTION_RESPONSE_CHUNK_BYTES)) {
    signal.throwIfAborted();
    await writeChunk(response, chunk, signal);
  }
  await endResponse(response, signal);
}

function writeChunk(response: ServerResponse, chunk: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeReturned = false;
    let callbackFinished = false;
    let drainFinished = false;

    const cleanup = () => {
      response.off("drain", drain);
      response.off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    function fail(error: unknown): void {
      settle(error);
    }
    function abort(): void {
      try {
        signal.throwIfAborted();
      } catch (error) {
        settle(error);
      }
    }
    function drain(): void {
      drainFinished = true;
      finishIfFlushed();
    }
    function finishIfFlushed(): void {
      if (writeReturned && callbackFinished && drainFinished) settle();
    }

    response.once("error", fail);
    response.once("drain", drain);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    try {
      const accepted = response.write(chunk, (error) => {
        if (error) {
          fail(error);
          return;
        }
        callbackFinished = true;
        finishIfFlushed();
      });
      writeReturned = true;
      drainFinished = accepted;
      finishIfFlushed();
    } catch (error) {
      settle(error);
    }
  });
}

function endResponse(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off("error", fail);
      response.off("finish", finish);
      signal.removeEventListener("abort", abort);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    function fail(error: unknown): void {
      settle(error);
    }
    function finish(): void {
      settle();
    }
    function abort(): void {
      try {
        signal.throwIfAborted();
      } catch (error) {
        settle(error);
      }
    }

    response.once("error", fail);
    response.once("finish", finish);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      response.end();
    } catch (error) {
      settle(error);
    }
  });
}
