import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphArtifact } from "@meridian/core";
import { CliError, EXIT } from "../errors";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { WebError } from "./web-error";
import { injectPrefill } from "./web-boot";
import { sendHtml, sendJson } from "./http-response";
import { createGitHubClient, resolveGitHubClientId } from "./github";
import type { GitHubClient } from "./github";
import type { GitHubUser } from "./github-parse";
import { SessionStore } from "./session";
import { assertJsonContentType, assertSameOrigin } from "./web-guards";
import {
  handleAuthSession,
  handleAuthStatus,
  handleDeviceStart,
  handleLogout,
  handleOwnRepos,
  handleRepoBranches,
  handleRepoSearch,
} from "./web-auth";
import { handleGenerate, sendGraph, sendMeta, sendView } from "./web-graph";
import {
  handlePullRequestChecks,
  handlePullRequestCommentMutation,
  handlePullRequestComments,
  handlePullRequestFileContent,
  handlePullRequestFiles,
  handlePullRequestOne,
  handleRelatedPullRequests,
  handlePullRequests,
  handleSubmitReview,
} from "./web-prs";
import { handlePrAnalyze } from "./web-pr-analyze";
import { handlePickFolder } from "./web-pick-folder";
import { handleRepoPullRequests } from "./web-repo-pulls";
import type { ArtifactSource } from "./web-source";
import { sendSource } from "./source-serve";

export interface WebServerConfig {
  rendererRoot: string;
  /** Path to the hand-written landing page (`web-ui/index.html`). */
  webUiPath: string;
  /** Directory local `kind:"path"` sources resolve against. */
  cwd: string;
  /** Optional CLI positional pre-filled into the landing form. */
  source?: string;
  /** Optional GitHub OAuth app identity override; blank/absent uses Meridian's bundled app. */
  githubClientId?: string;
  /** Last-resort token (the `gh` CLI login) used when no env token or session is present. */
  fallbackToken?: string;
  /** Identity behind `fallbackToken`, so the signed-in UI can name the gh-logged-in user. */
  fallbackUser?: GitHubUser;
}

export interface Context {
  graphs: Map<string, GraphArtifact>;
  /** Per-id source directory retained after a successful generate so `/api/source` can read it. */
  sourceRoots: Map<string, string>;
  /** Per-id original source metadata retained for GitHub PR listing. */
  sources: Map<string, ArtifactSource>;
  /** Per-PR repo-root changed paths, invalidated when GitHub's updated_at or head SHA changes. */
  prFilesCache: Map<string, { updatedAt: string; headSha: string | null; paths: string[] }>;
  /** Temp-clone removers, held until process exit so retained sources are cleaned on shutdown. */
  tempCleanups: Set<() => void>;
  rendererIndex: string;
  landingHtml: string;
  staticAssets: StaticAssets;
  cwd: string;
  sessions: SessionStore;
  github: GitHubClient;
  /** Last-resort token (the `gh` CLI login), below env vars in `githubTokenFor` precedence. */
  fallbackToken?: string;
  /** Identity behind `fallbackToken`, surfaced by `/api/auth/session` as the signed-in user. */
  fallbackUser?: GitHubUser;
}

export function createWebServer(config: WebServerConfig): Server {
  const ctx = buildContext(config);
  return createServer((request, response) => {
    handle(ctx, request, response).catch((error) => sendError(response, error));
  });
}

function buildContext(config: WebServerConfig): Context {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const github = createGitHubClient({ clientId: resolveGitHubClientId(config.githubClientId) });
  const landing = injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source);
  const ctx: Context = {
    graphs: new Map(),
    sourceRoots: new Map(),
    sources: new Map(),
    prFilesCache: new Map(),
    tempCleanups: new Set(),
    rendererIndex: readFileSync(indexPath, "utf8"),
    landingHtml: landing,
    // Stray routes fall back to the front door rather than the renderer shell.
    staticAssets: { rendererRoot: config.rendererRoot, indexHtml: landing },
    cwd: config.cwd,
    sessions: new SessionStore(),
    github,
    fallbackToken: config.fallbackToken,
    fallbackUser: config.fallbackUser,
  };
  cleanRetainedSourcesOnExit(ctx);
  return ctx;
}

// A successful generate keeps its temp clone alive so `/api/source` can serve file slices; this
// exit hook still removes every retained clone on shutdown so `web` never leaks temp directories.
function cleanRetainedSourcesOnExit(ctx: Context): void {
  process.once("exit", () => {
    for (const cleanup of ctx.tempCleanups) {
      cleanup();
    }
  });
}

async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(ctx, request, response, url);
    return;
  }
  if (url.pathname === "/view") {
    sendView(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (url.pathname === "/") {
    sendHtml(response, ctx.landingHtml);
    return;
  }
  serveStatic(ctx.staticAssets, url.pathname, response);
}

// Every `/api/*` path is terminal (never falls through to the static SPA fallback), and the
// same-origin guard runs before any handler so a cross-site page cannot drive these routes.
async function handleApi(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  assertSameOrigin(request);
  if (request.method === "POST") {
    assertJsonContentType(request);
    await handleApiPost(ctx, request, response, url);
    return;
  }
  await handleApiGet(ctx, request, response, url);
}

async function handleApiPost(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/generate") {
    await handleGenerate(ctx, request, response);
    return;
  }
  if (pathname === "/api/pr/analyze") {
    await handlePrAnalyze(ctx, request, response);
    return;
  }
  if (pathname === "/api/auth/device") {
    await handleDeviceStart(ctx, response);
    return;
  }
  if (pathname === "/api/auth/logout") {
    handleLogout(ctx, request, response);
    return;
  }
  if (pathname === "/api/pick-folder") {
    await handlePickFolder(response);
    return;
  }
  if (pathname === "/api/prs/review") {
    await handleSubmitReview(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/comments") {
    await handlePullRequestCommentMutation(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/related") {
    await handleRelatedPullRequests(ctx, request, response, url.searchParams);
    return;
  }
  sendJson(response, 404, { error: "unknown endpoint" });
}

async function handleApiGet(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph") {
    sendGraph(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/meta") {
    sendMeta(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/overlay") {
    sendJson(response, 400, { error: "no telemetry overlay in web mode" });
    return;
  }
  if (pathname === "/api/traces") {
    sendJson(response, 400, { error: "no telemetry traces in web mode" });
    return;
  }
  if (pathname === "/api/source") {
    sendSource(response, ctx.sourceRoots.get(url.searchParams.get("id") ?? "") ?? null, url.searchParams);
    return;
  }
  if (pathname === "/api/prs") {
    await handlePullRequests(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/one") {
    await handlePullRequestOne(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/files") {
    await handlePullRequestFiles(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/comments") {
    await handlePullRequestComments(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/checks") {
    await handlePullRequestChecks(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/prs/file") {
    await handlePullRequestFileContent(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/auth/status") {
    await handleAuthStatus(ctx, request, response);
    return;
  }
  if (pathname === "/api/auth/session") {
    handleAuthSession(ctx, request, response);
    return;
  }
  if (pathname === "/api/repos/branches") {
    await handleRepoBranches(ctx, request, response, url.searchParams.get("repo") ?? "");
    return;
  }
  if (pathname === "/api/repos/pulls") {
    await handleRepoPullRequests(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/repos/search") {
    await handleRepoSearch(ctx, request, response, url.searchParams.get("q") ?? "");
    return;
  }
  if (pathname === "/api/repos/mine") {
    await handleOwnRepos(ctx, request, response);
    return;
  }
  sendJson(response, 404, { error: "unknown endpoint" });
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof WebError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof CliError) {
    sendJson(response, 422, { error: error.message });
    return;
  }
  // Never echo an unknown error's text — it could carry a path or secret we did not vet.
  sendJson(response, 500, { error: "internal error while generating the blueprint" });
}
