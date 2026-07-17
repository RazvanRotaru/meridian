/**
 * Internal existing-graph path used by the public `web` launcher.
 *
 * The never-default-prod rule is enforced before anything else: `--overlay` without an
 * environment is a usage error, mirrored again server-side on `/api/overlay`. The renderer
 * SPA ships inside this package (copied to `renderer-dist`), so `view` serves self-contained.
 */

import { fileURLToPath } from "node:url";
import { CliError, EXIT } from "../errors";
import { resolveAgainst, resolveCwd } from "../paths";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { resolveOverlaySource } from "../server/overlay-source";
import { createBlueprintServer } from "../server/server";
import { serve } from "../server/serve";
import { normalizeTelemetryEnvironment } from "../telemetry-environment";
import { isLoopbackHost } from "../server/web-guards";
import { createStandaloneViewSession } from "../server/standalone-view-session";

export interface ViewOptions extends GlobalOptions {
  port: number;
  host: string;
  open: boolean;
  overlay?: string;
  env?: string;
  sourceRoot?: string;
  testCoverage?: string;
  allowSyntheticExecution?: boolean;
}

export async function runView(graph: string, options: ViewOptions): Promise<void> {
  requireLoopbackForSyntheticExecution(options.host, options.allowSyntheticExecution === true);
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const env = requireEnvForOverlay(options);
  const overlay = resolveOverlaySource(options.overlay, cwd);
  const sourceRoot = options.sourceRoot ? resolveAgainst(cwd, options.sourceRoot) : undefined;
  const session = createStandaloneViewSession({
    graphPath: resolveAgainst(cwd, graph),
    cwd,
    sourceRoot: sourceRoot ?? null,
    ...(options.testCoverage
      ? { coveragePath: resolveAgainst(cwd, options.testCoverage) }
      : {}),
  });
  try {
    const server = createBlueprintServer({
      session,
      overlay,
      preselectedEnv: env,
      rendererRoot: rendererRoot(),
      allowSyntheticExecution: options.allowSyntheticExecution === true,
    });
    await serve(server, { host: options.host, startPort: options.port, openBrowser: options.open }, reporter);
  } catch (error) {
    // Once bound, the server owns cleanup through its `close` event. Startup failures never reach
    // that event, so release the private artifact/projection session here as well.
    session.cleanup();
    throw error;
  }
}

function requireLoopbackForSyntheticExecution(host: string, enabled: boolean): void {
  if (enabled && !isLoopbackHost(host)) {
    throw new CliError(EXIT.usage, "--allow-synthetic-execution requires a loopback --host");
  }
}

function requireEnvForOverlay(options: ViewOptions): string | null {
  const env = options.env ?? process.env.BLUEPRINT_ENV ?? null;
  if (options.overlay && !env) {
    throw new CliError(EXIT.usage, "--env is required with --overlay; blueprint never defaults and never prod");
  }
  return env === null ? null : normalizeTelemetryEnvironment(env);
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer`. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}
