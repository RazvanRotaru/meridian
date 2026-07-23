/**
 * One owner for HTTP admission, accepted async handlers, and the resources behind them.
 *
 * The service flips every admission boundary synchronously, cancels accepted handlers, waits for
 * both Node's connection drain and the handler promises, and only then runs final disposal. Keeping
 * that sequence here prevents the `view` and `web` launchers from growing subtly different shutdown
 * semantics.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { SERVICE_SHUTDOWN_MESSAGE, ServiceShutdownError } from "./service-shutdown";

export const HTTP_SERVICE_SHUTDOWN_MESSAGE = SERVICE_SHUTDOWN_MESSAGE;

export class HttpServiceShutdownError extends ServiceShutdownError {
  constructor() {
    super(HTTP_SERVICE_SHUTDOWN_MESSAGE);
    this.name = "HttpServiceShutdownError";
  }
}

export interface HttpService {
  readonly server: Server;
  /** Aborted synchronously when `close()` starts. Accepted handlers may use it for owned work. */
  readonly signal: AbortSignal;
  /** Idempotent. Every call returns the exact same promise. */
  close(): Promise<void>;
}

export interface HttpServiceOptions {
  handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): void | Promise<void>;
  handleError(response: ServerResponse, error: unknown): void;
  rejectRequest(response: ServerResponse): void;
  /** Resource owners enter draining synchronously with HTTP admission. */
  beginShutdown?: readonly (() => void | Promise<void>)[];
  /** Runs after HTTP, accepted handlers, and every resource owner have drained. */
  finishShutdown?: () => void | Promise<void>;
}

export function createHttpService(options: HttpServiceOptions): HttpService {
  const shutdown = new AbortController();
  let acceptingRequests = true;
  let activeRequests = 0;
  let resolveRequestDrain: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    if (!acceptingRequests) {
      safelyRespond(response, () => options.rejectRequest(response));
      return;
    }
    activeRequests += 1;
    void Promise.resolve()
      .then(() => options.handle(request, response, shutdown.signal))
      .catch((error: unknown) => safelyRespond(response, () => options.handleError(response, error)))
      .finally(() => {
        activeRequests -= 1;
        if (activeRequests === 0) {
          resolveRequestDrain?.();
          resolveRequestDrain = undefined;
        }
      });
  });

  return {
    server,
    signal: shutdown.signal,
    close() {
      if (closePromise !== undefined) return closePromise;

      // Establish the exact shared promise before invoking user-owned cleanup. This keeps close()
      // idempotent even if a resource synchronously re-enters the service while it starts draining.
      let resolveClose!: () => void;
      let rejectClose!: (error: unknown) => void;
      closePromise = new Promise<void>((resolve, reject) => {
        resolveClose = resolve;
        rejectClose = reject;
      });
      acceptingRequests = false;
      shutdown.abort(new HttpServiceShutdownError());

      const tasks = [
        ...(options.beginShutdown ?? []).map(invokeShutdown),
        closeHttpServer(server),
        requestsDrained(),
      ];
      void finishShutdown(tasks, options.finishShutdown).then(resolveClose, rejectClose);
      return closePromise;
    },
  };

  function requestsDrained(): Promise<void> {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolveRequestDrain = resolve;
    });
  }
}

/** Resolve after Node has stopped admission and drained every accepted connection. */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      // Closing a never-bound server is an idempotent success. Calling close unconditionally is
      // still required: during an asynchronous bind `server.listening` remains false even though
      // Node already owns a pending listener that must be cancelled before service close resolves.
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
      } else {
        resolve();
      }
    });
    // Node 20 already closes idle keep-alive connections from `close`; the explicit call makes the
    // admission boundary immediate and keeps the intent clear on every supported runtime.
    server.closeIdleConnections();
  });
}

function invokeShutdown(shutdown: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(shutdown());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function finishShutdown(
  tasks: readonly Promise<void>[],
  finish: (() => void | Promise<void>) | undefined,
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (finish !== undefined) {
    try {
      await finish();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "HTTP service shutdown failed");
}

function safelyRespond(response: ServerResponse, send: () => void): void {
  try {
    send();
  } catch {
    response.destroy();
  }
}
