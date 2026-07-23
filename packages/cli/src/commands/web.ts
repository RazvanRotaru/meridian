/**
 * `web`: the single app launcher for repository analysis and existing graph artifacts.
 *
 * Repository extraction always runs in Node (ts-morph never touches a browser); the page only
 * POSTs a source and loads the renderer against the resulting disk-backed graph. A file source uses
 * the existing-artifact server through the same public command.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgainst, resolveCwd } from "../paths";
import { Reporter } from "../reporter";
import type { GlobalOptions } from "../reporter";
import { createWebService } from "../server/web-server";
import { createGitHubClient, resolveGitHubClientId } from "../server/github";
import type { GitHubUser } from "../server/github-parse";
import { resolveGhCliToken } from "../server/gh-cli-token";
import { serve } from "../server/serve";
import { CliError, EXIT } from "../errors";
import { isLoopbackHost } from "../server/web-guards";
import { repositoryRetentionOptionsFromEnv } from "../server/web-repository-retention";
import { graphRetentionOptionsFromEnv } from "../server/web-graph-retention";

export interface WebOptions extends GlobalOptions {
  port: number;
  host: string;
  open: boolean;
  githubClientId?: string;
  refreshCache?: boolean;
  overlay?: string;
  env?: string;
  sourceRoot?: string;
  testCoverage?: string;
  allowSyntheticExecution?: boolean;
  allowSyntheticPrExecution?: boolean;
}

export async function runWeb(source: string | undefined, options: WebOptions): Promise<void> {
  if ((options.allowSyntheticExecution === true || options.allowSyntheticPrExecution === true)
    && !isLoopbackHost(options.host)) {
    const flag = options.allowSyntheticPrExecution === true
      ? "--allow-synthetic-pr-execution"
      : "--allow-synthetic-execution";
    throw new CliError(EXIT.usage, `${flag} requires a loopback --host`);
  }
  const cwd = resolveCwd(options.cwd);
  if (source && isFile(resolveAgainst(cwd, source))) {
    return (await import("./view")).runView(source, options);
  }
  const reporter = new Reporter(options);
  const githubClientId = resolveGitHubClientId(options.githubClientId, process.env.MERIDIAN_GITHUB_CLIENT_ID);
  const fallback = await resolveFallbackAuth(githubClientId, reporter);
  let repositoryRetention;
  let graphRetention;
  try {
    repositoryRetention = repositoryRetentionOptionsFromEnv();
    graphRetention = graphRetentionOptionsFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(EXIT.usage, `invalid cache retention configuration: ${message}`);
  }
  const service = createWebService({
    rendererRoot: rendererRoot(),
    webUiPath: webUiPath(),
    cwd,
    source,
    githubClientId,
    fallbackToken: fallback.token,
    fallbackUser: fallback.user,
    repositoryRetention,
    graphRetention,
    onRepositoryRetentionError: (error) => reporter.info(
      `Repository cache maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
    onGraphRetentionError: (error) => reporter.info(
      `Graph cache maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
    refreshCache: options.refreshCache,
    allowSyntheticExecution: options.allowSyntheticExecution === true,
    allowSyntheticPrExecution: options.allowSyntheticPrExecution === true,
  });
  await serve(
    service,
    { host: options.host, startPort: options.port, openBrowser: options.open, label: "Blueprint web UI" },
    reporter,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The ambient credential to sign the UI in with when there's no interactive session and no
 * GITHUB_TOKEN/GH_TOKEN: the `gh` CLI's own login. `gh` persists its token in the OS keychain, so
 * reusing it means a signed-in-with-gh user reaches search + own repos + clone + PR review WITHOUT
 * the device flow, and it survives restarts (unlike the in-memory session). An explicit env token
 * still wins, so we don't even spawn gh when one is set.
 */
async function resolveFallbackAuth(clientId: string, reporter: Reporter): Promise<{ token?: string; user?: GitHubUser }> {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return {};
  }
  const token = await resolveGhCliToken();
  if (!token) {
    return {};
  }
  const user = await fetchUserQuietly(clientId, token);
  const who = user?.login ? ` as ${user.login}` : "";
  reporter.info(`GitHub: signed in with your \`gh\` CLI login${who} — no sign-in needed (run \`gh auth logout\` to disable)`);
  return { token, user };
}

/** Best-effort identity for the gh token; offline / API hiccup just yields no name (still signed in). */
async function fetchUserQuietly(clientId: string, token: string): Promise<GitHubUser | undefined> {
  try {
    return await createGitHubClient({ clientId }).getUser(token);
  } catch {
    return undefined;
  }
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer`. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}

/** The hand-written landing page ships as a package-root static asset (see package.json files). */
function webUiPath(): string {
  return fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
}
