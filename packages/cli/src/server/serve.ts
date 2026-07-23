/**
 * Taking an owned HTTP service live: bind, announce, optionally open a browser, and wait until a
 * signal or ordinary service close has completed the same asynchronous shutdown path.
 */

import type { Reporter } from "../reporter";
import type { HttpService } from "./http-service";
import { listenWithRetry } from "./listen";
import { openInBrowser } from "./opener";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export interface ShutdownSignalSource {
  once(event: ShutdownSignal, listener: () => void): unknown;
  removeListener(event: ShutdownSignal, listener: () => void): unknown;
}

export interface ServeOptions {
  host: string;
  startPort: number;
  openBrowser: boolean;
  /** Announcement prefix, e.g. "Blueprint web UI" (defaults to the renderer wording). */
  label?: string;
  /** Deterministic test seam; production always uses the current Node process. */
  signalSource?: ShutdownSignalSource;
}

export async function serve(service: HttpService, options: ServeOptions, reporter: Reporter): Promise<void> {
  const shutdown = observeShutdown(service, options.signalSource ?? process);
  try {
    const port = await listenWithRetry(service.server, options.host, options.startPort, service.signal);
    if (port === null) {
      await shutdown.promise;
      return;
    }
    if (!service.signal.aborted) {
      const url = `http://${options.host}:${port}`;
      reporter.info(`${options.label ?? "Blueprint renderer"} at ${url}`);
      if (options.openBrowser) {
        openInBrowser(url);
      }
    }
  } catch (error) {
    shutdown.dispose();
    // A failed bind must not strand resources allocated before the listener was created.
    try {
      await service.close();
    } catch {
      // Preserve the actionable bind failure; close remains best-effort on this construction path.
    }
    throw error;
  }
  await shutdown.promise;
}

interface ShutdownObservation {
  readonly promise: Promise<void>;
  dispose(): void;
}

/** Install ownership before binding so no signal or early ordinary close can be missed. */
function observeShutdown(service: HttpService, signals: ShutdownSignalSource): ShutdownObservation {
  let disposed = false;
  let closing = false;
  let beginShutdown!: () => void;
  const removeSignalListeners = () => {
    signals.removeListener("SIGINT", beginShutdown);
    signals.removeListener("SIGTERM", beginShutdown);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    removeSignalListeners();
    service.server.removeListener("close", beginShutdown);
  };
  const promise = new Promise<void>((resolve, reject) => {
    beginShutdown = () => {
      if (closing) return;
      closing = true;
      // Restore the platform's default second-signal behaviour while graceful cleanup is pending.
      removeSignalListeners();
      void service.close().then(
        () => {
          cleanup();
          resolve();
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    };

    signals.once("SIGINT", beginShutdown);
    signals.once("SIGTERM", beginShutdown);
    service.server.once("close", beginShutdown);
    // `serve` can receive an owner that was closed before observation was installed. The aborted
    // service signal is durable even though Node's one-shot `close` event is not.
    if (service.signal.aborted) beginShutdown();
  });
  return {
    promise,
    dispose() {
      cleanup();
    },
  };
}
