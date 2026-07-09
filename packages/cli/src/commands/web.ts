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
  const server = createWebServer({
    rendererRoot: rendererRoot(),
    webUiPath: webUiPath(),
    cwd,
    source,
    githubClientId: options.githubClientId ?? process.env.MERIDIAN_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
    fallbackToken: await resolveFallbackToken(reporter),
  });
  await serve(
    server,
    { host: options.host, startPort: options.port, openBrowser: options.open, label: "Blueprint web UI" },
    reporter,
  );
}

/**
 * A GitHub token to fall back to when the request carries no session and no GITHUB_TOKEN/GH_TOKEN:
 * the `gh` CLI's own login. This survives server restarts (unlike the in-memory session), so a gh
 * user reaches clone + PR review without signing in each time. An explicit env token still wins, so
 * we don't even spawn gh when one is set.
 */
async function resolveFallbackToken(reporter: Reporter): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return undefined;
  }
  const token = await resolveGhCliToken();
  if (token) {
    reporter.info("GitHub: using your `gh` CLI login — no sign-in needed (run `gh auth logout` to disable)");
  }
  return token;
}

/** The renderer bundle sits next to `dist/bin.js` after `copy-renderer`. */
function rendererRoot(): string {
  return fileURLToPath(new URL("../renderer-dist/", import.meta.url));
}

/** The hand-written landing page ships as a package-root static asset (see package.json files). */
function webUiPath(): string {
  return fileURLToPath(new URL("../web-ui/index.html", import.meta.url));
}
