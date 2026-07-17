import type { IncomingMessage, ServerResponse } from "node:http";

export interface ClientRequestCancellation {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

/**
 * Abort work when the HTTP peer has already left or leaves later.
 *
 * Listeners are installed before checking the current stream state, closing the narrow race where
 * a peer disconnects between request-body completion and endpoint-specific work admission.
 */
export function cancelWhenClientLeaves(
  request: IncomingMessage,
  response: ServerResponse,
  message = "The client closed the request",
): ClientRequestCancellation {
  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    if (reason !== undefined) {
      controller.abort(reason);
      return;
    }
    const disconnect = new Error(message);
    disconnect.name = "AbortError";
    controller.abort(disconnect);
  };
  const onAborted = () => abort();
  const onClose = () => {
    if (!response.writableEnded) abort();
  };
  request.once("aborted", onAborted);
  response.once("close", onClose);
  // IncomingMessage becomes `destroyed` after a fully consumed request body in normal operation;
  // only the explicit aborted flag distinguishes a peer that left before request completion.
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    abort,
    dispose() {
      request.off("aborted", onAborted);
      response.off("close", onClose);
    },
  };
}
