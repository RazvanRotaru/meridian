/**
 * Taking a built server live: bind, announce, optionally open a browser, and shut down
 * cleanly on Ctrl-C. Kept apart from the pure factory so `createBlueprintServer` stays
 * testable without ever touching a real port or process signal.
 */

import type { Server } from "node:http";
import { EXIT } from "../errors";
import type { Reporter } from "../reporter";
import { listenWithRetry } from "./listen";
import { openInBrowser } from "./opener";

export interface ServeOptions {
  host: string;
  startPort: number;
  openBrowser: boolean;
  /** Announcement prefix, e.g. "Blueprint web UI" (defaults to the renderer wording). */
  label?: string;
}

export async function serve(server: Server, options: ServeOptions, reporter: Reporter): Promise<void> {
  const port = await listenWithRetry(server, options.host, options.startPort);
  const url = `http://${options.host}:${port}`;
  reporter.info(`${options.label ?? "Blueprint renderer"} at ${url}`);
  if (options.openBrowser) {
    openInBrowser(url);
  }
  installShutdown(server);
}

function installShutdown(server: Server): void {
  process.on("SIGINT", () => {
    server.close(() => process.exit(EXIT.ok));
  });
}
