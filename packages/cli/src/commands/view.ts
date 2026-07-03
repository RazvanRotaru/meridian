/**
 * `view`: validate a graph and serve the bundled renderer against it.
 *
 * The never-default-prod rule is enforced before anything else: `--overlay` without an
 * environment is a usage error, mirrored again server-side on `/api/overlay`. The renderer
 * SPA ships inside this package (copied to `renderer-dist`), so `view` serves self-contained.
 */

import { fileURLToPath } from "node:url";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { resolveAgainst, resolveCwd } from "../paths";
import { readJsonFile } from "../json-io";
import { validateOrThrow } from "../validation";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { resolveOverlaySource } from "../server/overlay-source";
import { createBlueprintServer } from "../server/server";
import { serve } from "../server/serve";

export interface ViewOptions extends GlobalOptions {
  port: number;
  host: string;
  open: boolean;
  overlay?: string;
  env?: string;
}

export async function runView(graph: string, options: ViewOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const env = requireEnvForOverlay(options);
  const artifact = loadGraph(graph, cwd);
  const overlay = resolveOverlaySource(options.overlay, cwd);
  const server = createBlueprintServer({ artifact, overlay, preselectedEnv: env, rendererRoot: rendererRoot() });
  await serve(server, { host: options.host, startPort: options.port, openBrowser: options.open }, reporter);
}

function requireEnvForOverlay(options: ViewOptions): string | null {
  const env = options.env ?? process.env.BLUEPRINT_ENV ?? null;
  if (options.overlay && !env) {
    throw new CliError(EXIT.usage, "--env is required with --overlay; blueprint never defaults and never prod");
  }
  return env;
}

function loadGraph(graph: string, cwd: string): GraphArtifact {
  const graphPath = resolveAgainst(cwd, graph);
  return validateOrThrow(readJsonFile(graphPath), `graph ${graphPath}`).artifact;
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer`. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}
