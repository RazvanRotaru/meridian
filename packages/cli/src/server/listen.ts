/**
 * Binding the server, walking forward over busy ports.
 *
 * The default port is a convenience, not a reservation, so a busy port is recoverable: we try
 * the next twenty before giving up with the dedicated port-bind exit code.
 */

import type { Server } from "node:http";
import { CliError, EXIT } from "../errors";

const MAX_PORT_ATTEMPTS = 20;

export async function listenWithRetry(
  server: Server,
  host: string,
  startPort: number,
  signal?: AbortSignal,
): Promise<number | null> {
  for (let port = startPort; port <= startPort + MAX_PORT_ATTEMPTS; port += 1) {
    const result = await tryListen(server, host, port, signal);
    if (result === "aborted") return null;
    if (result === "listening") {
      return port;
    }
  }
  throw new CliError(EXIT.portBind, `no free port in ${startPort}..${startPort + MAX_PORT_ATTEMPTS} on ${host}`);
}

type ListenAttempt = "listening" | "busy" | "aborted";

function tryListen(
  server: Server,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<ListenAttempt> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolveListen, rejectListen) => {
    let settled = false;
    let closingAbortedListener = false;
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      server.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (result: ListenAttempt) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveListen(result);
    };
    const reject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectListen(error);
    };
    const closeAbortedListener = () => {
      if (closingAbortedListener) return;
      closingAbortedListener = true;
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        settle("aborted");
      });
      server.closeIdleConnections();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (signal?.aborted) {
        settle("aborted");
        return;
      }
      if (error.code === "EADDRINUSE") {
        settle("busy");
      } else {
        reject(new CliError(EXIT.portBind, `cannot bind ${host}:${port}: ${error.message}`));
      }
    };
    const onListening = () => {
      if (signal?.aborted) {
        closeAbortedListener();
        return;
      }
      settle("listening");
    };
    const onClose = () => {
      if (signal?.aborted) {
        settle("aborted");
      } else {
        reject(new CliError(EXIT.portBind, `cannot bind ${host}:${port}: server closed during bind`));
      }
    };
    const onAbort = () => {
      // During an asynchronous bind `server.listening` is still false. Its eventual `listening`
      // or `error` event owns settlement; a completed bind is closed before returning `aborted`.
      if (server.listening) closeAbortedListener();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      server.listen(port, host);
    } catch (error) {
      reject(new CliError(EXIT.portBind, `cannot bind ${host}:${port}: ${String(error)}`));
      return;
    }
    if (signal?.aborted) onAbort();
  });
}
