/**
 * `web`: serve a local UI that clones/extracts/renders any repo's call graph in the browser.
 *
 * Extraction always runs here in Node (ts-morph never touches a browser); the page only POSTs a
 * source and then loads the UNCHANGED renderer bundle against the resulting in-memory graph. The
 * pure server factory lives in `server/web-server`; this command only binds it and takes it live.
 */

import { fileURLToPath } from "node:url";
import { resolveCwd } from "../paths";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { createWebServer } from "../server/web-server";
import { serve } from "../server/serve";

export interface WebOptions extends GlobalOptions {
  port: number;
  host: string;
  open: boolean;
}

export async function runWeb(source: string | undefined, options: WebOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const server = createWebServer({
    rendererRoot: rendererRoot(),
    webUiPath: webUiPath(),
    cwd,
    source,
  });
  await serve(
    server,
    { host: options.host, startPort: options.port, openBrowser: options.open, label: "Blueprint web UI" },
    reporter,
  );
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer`. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}

/** The hand-written landing page ships as a package-root static asset (see package.json files). */
function webUiPath(): string {
  return fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
}
