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
import { createGitHubClient } from "../server/github";
import type { GitHubUser } from "../server/github-parse";
import { resolveGhCliToken } from "../server/gh-cli-token";
import { serve } from "../server/serve";

export interface WebOptions extends GlobalOptions {
  port: number;
  host: string;
  open: boolean;
  githubClientId?: string;
}

/**
 * The project's own OAuth app registration (Device Flow enabled; maintained by the meridian
 * owners). A client id is public by design — the device flow uses no secret. Forks that want
 * their own app identity override via --github-client-id or MERIDIAN_GITHUB_CLIENT_ID.
 */
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liC6UQi42iShRkP4";

export async function runWeb(source: string | undefined, options: WebOptions): Promise<void> {
  const reporter = new Reporter(options);
  const cwd = resolveCwd(options.cwd);
  const githubClientId = options.githubClientId ?? process.env.MERIDIAN_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID;
  const fallback = await resolveFallbackAuth(githubClientId, reporter);
  const server = createWebServer({
    rendererRoot: rendererRoot(),
    webUiPath: webUiPath(),
    cwd,
    source,
    githubClientId,
    fallbackToken: fallback.token,
    fallbackUser: fallback.user,
  });
  await serve(
    server,
    { host: options.host, startPort: options.port, openBrowser: options.open, label: "Blueprint web UI" },
    reporter,
  );
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
