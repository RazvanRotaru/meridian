import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceShutdownError } from "./service-shutdown";
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
    const reason = signal.reason;
    if (reason instanceof ServiceShutdownError) {
      throw reason;
    }
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
  parentSignal?: AbortSignal,
): RequestCancellation {
  const controller = new AbortController();
  const abortForPeer = () => controller.abort(new OperationCancelledError());
  const abortForParent = () => controller.abort(
    parentSignal?.reason instanceof Error ? parentSignal.reason : new OperationCancelledError(),
  );
  const onResponseClose = () => {
    if (!response.writableEnded) abortForPeer();
  };
  request.once("aborted", abortForPeer);
  response.once("close", onResponseClose);
  parentSignal?.addEventListener("abort", abortForParent, { once: true });
  if (parentSignal?.aborted) abortForParent();
  else if (request.aborted || response.destroyed) abortForPeer();
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener("aborted", abortForPeer);
      response.removeListener("close", onResponseClose);
      parentSignal?.removeEventListener("abort", abortForParent);
    },
  };
}

export function responseCanWrite(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}
