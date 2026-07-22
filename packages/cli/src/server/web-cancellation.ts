import type { IncomingMessage, ServerResponse } from "node:http";
import { WebError } from "./web-error";

/** A safe, stable cancellation result. HTTP handlers normally suppress it because the peer left. */
export class OperationCancelledError extends WebError {
  constructor(message = "operation was cancelled") {
    super(499, message);
    this.name = "OperationCancelledError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

export function isOperationCancelled(error: unknown): error is OperationCancelledError {
  return error instanceof OperationCancelledError;
}

export interface RequestCancellation {
  signal: AbortSignal;
  dispose(): void;
}

/**
 * Tie one waiter to its socket without tying the shared job to that socket. A normal response also
 * emits `close`, but only after `writableEnded`; that must not retroactively cancel completed work.
 */
export function requestCancellation(
  request: IncomingMessage,
  response: ServerResponse,
): RequestCancellation {
  const controller = new AbortController();
  const abort = () => controller.abort(new OperationCancelledError());
  const onResponseClose = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", abort);
  response.once("close", onResponseClose);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener("aborted", abort);
      response.removeListener("close", onResponseClose);
    },
  };
}

export function responseCanWrite(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}
