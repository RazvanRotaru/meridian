import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "../errors";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { sendOverlay as sendTelemetryOverlay, sendTraces as sendTelemetryTraces } from "./api";
import { WebError } from "./web-error";
import { injectPrefill } from "./web-boot";
import { sendHtml, sendJson } from "./http-response";
import { createGitHubClient, resolveGitHubClientId } from "./github";
import type { GitHubClient } from "./github";
import type { GitHubUser } from "./github-parse";
import { SessionStore } from "./session";
import { assertJsonContentType, assertLoopbackHost, assertSameOrigin } from "./web-guards";
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
import { sendSource } from "./source-serve";
import type { CachedGraph } from "./web-cache";
import { resolveWebCacheRoot } from "./web-cache-storage";
import { handleCacheStatus } from "./web-cache-status";
import { WebGraphStore } from "./web-graph-store";
import { parseSyntheticExecutionRequest, readJsonBody } from "./web-request";
import {
  runSyntheticScenario,
  runSyntheticScenarioInOci,
  SyntheticExecutionError,
  syntheticPrSandboxRuntimeSupported,
} from "./synthetic-execution";

const WEB_TELEMETRY_SOURCE = { kind: "none" } as const;

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
  /** Persistent remote graph cache root; primarily overridden by tests. */
  cacheRoot?: string;
  /** Re-extract artifacts for this server run while retaining immutable checkouts. */
  refreshCache?: boolean;
  /** Explicit opt-in; individual graph ids are still restricted to local `kind:path` sources. */
  allowSyntheticExecution?: boolean;
  /** Separate opt-in for consent-gated prepared PR-head runs in an available OCI sandbox. */
  allowSyntheticPrExecution?: boolean;
}

export interface Context {
  /** Disk-backed immutable graph registrations; request handlers load at most one artifact. */
  graphStore: WebGraphStore;
  /** Per-PR repo-root changed paths, invalidated when GitHub's updated_at or head SHA changes. */
  prFilesCache: Map<string, { updatedAt: string; headSha: string | null; paths: string[] }>;
  /** Duplicate remote generations share one clone/extract job within this server process. */
  cacheJobs: Map<string, Promise<CachedGraph>>;
  cacheRoot: string;
  refreshCache: boolean;
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
  allowSyntheticExecution: boolean;
  allowSyntheticPrExecution: boolean;
  /** Injectable capability probe; production checks for the prebuilt, no-fallback OCI runner. */
  syntheticPrSandboxRuntimeSupported: () => boolean;
  /** Injectable OCI executor; never substituted with the host-process runner. */
  runSyntheticScenarioInOci: typeof runSyntheticScenarioInOci;
}

export function createWebServer(config: WebServerConfig): Server {
  const graphStore = new WebGraphStore();
  let ctx: Context;
  try {
    ctx = buildContext(config, graphStore);
  } catch (error) {
    graphStore.dispose();
    throw error;
  }
  const server = createServer((request, response) => {
    handle(ctx, request, response).catch((error) => sendError(response, error));
  });
  attachGraphStoreLifecycle(server, graphStore);
  return server;
}

function buildContext(config: WebServerConfig, graphStore: WebGraphStore): Context {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const github = createGitHubClient({ clientId: resolveGitHubClientId(config.githubClientId) });
  const landing = injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source);
  const cacheRoot = resolveWebCacheRoot(config.cacheRoot);
  const ctx: Context = {
    graphStore,
    prFilesCache: new Map(),
    cacheJobs: new Map(),
    cacheRoot,
    refreshCache: config.refreshCache === true,
    rendererIndex: readFileSync(indexPath, "utf8"),
    landingHtml: landing,
    // Stray routes fall back to the front door rather than the renderer shell.
    staticAssets: { rendererRoot: config.rendererRoot, indexHtml: landing },
    cwd: config.cwd,
    sessions: new SessionStore(),
    github,
    fallbackToken: config.fallbackToken,
    fallbackUser: config.fallbackUser,
    allowSyntheticExecution: config.allowSyntheticExecution === true,
    allowSyntheticPrExecution: config.allowSyntheticPrExecution === true,
    syntheticPrSandboxRuntimeSupported,
    runSyntheticScenarioInOci,
  };
  return ctx;
}

/** Dispose after Node's close event, when accepted connections have drained. The process hook
 * captures only the store cleanup and is removed on ordinary server close. */
function attachGraphStoreLifecycle(server: Server, graphStore: WebGraphStore): void {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    graphStore.dispose();
  };
  process.once("exit", dispose);
  server.once("close", () => {
    process.removeListener("exit", dispose);
    dispose();
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
  if (pathname === "/api/synthetic-executions") {
    await handleSyntheticExecution(ctx, request, response, url.searchParams.get("id"));
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

export async function handleSyntheticExecution(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  id: string | null,
): Promise<void> {
  assertLoopbackHost(request);
  const descriptor = id ? ctx.graphStore.descriptor(id) : undefined;
  const sourceRoot = descriptor?.sourceRoot;
  const source = descriptor?.source;
  const scenarios = descriptor?.synthetic.scenarios;
  const sourceFingerprint = descriptor?.synthetic.sourceFingerprint ?? undefined;
  const trust = descriptor?.synthetic.trust ?? undefined;
  const localAdmission = source?.kind === "path"
    && ctx.allowSyntheticExecution
    && trust?.mode === "local";
  const sandboxedPrAdmission = source?.kind === "github"
    && ctx.allowSyntheticPrExecution
    && trust?.mode === "sandboxed-pr"
    && trust.provenance.repository === `${source.owner}/${source.repo}`
    && trust.provenance.headSha.length > 0
    && ctx.syntheticPrSandboxRuntimeSupported();
  if (
    (!localAdmission && !sandboxedPrAdmission)
    || sourceRoot === undefined
    || scenarios === undefined
    || scenarios.length === 0
    || sourceFingerprint === undefined
  ) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
    return;
  }
  const artifact = id ? ctx.graphStore.loadArtifact(id) : undefined;
  if (artifact === undefined) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
    return;
  }
  if (sandboxedPrAdmission && request.headers["x-meridian-sandbox-consent"] !== "true") {
    sendJson(response, 403, { error: "sandbox consent is required for GitHub synthetic execution" });
    return;
  }
  const body = parseSyntheticExecutionRequest(await readJsonBody(request));
  const scenario = scenarios.find((candidate) => candidate.id === body.scenarioId);
  if (scenario !== undefined && scenario.rootId !== body.rootNodeId) {
    throw new WebError(409, "selected flow no longer matches the synthetic scenario");
  }
  const executionRequest = {
    sourceRoot,
    artifact,
    scenarioId: body.scenarioId,
    expectedRootId: body.rootNodeId,
    expectedSourceFingerprint: sourceFingerprint,
    input: body.input,
    inputOverrides: body.inputOverrides,
    watchers: body.watchers,
  };
  const execution = sandboxedPrAdmission
    ? await ctx.runSyntheticScenarioInOci(executionRequest)
    : await runSyntheticScenario(executionRequest);
  sendJson(response, 200, execution);
}

async function handleApiGet(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph") {
    await sendGraph(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/meta") {
    sendMeta(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/overlay") {
    const artifact = loadTelemetryGraph(ctx, response, url.searchParams.get("id"));
    if (artifact === null) return;
    sendTelemetryOverlay(
      response,
      artifact,
      WEB_TELEMETRY_SOURCE,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
    );
    return;
  }
  if (pathname === "/api/traces") {
    const artifact = loadTelemetryGraph(ctx, response, url.searchParams.get("id"));
    if (artifact === null) return;
    sendTelemetryTraces(
      response,
      artifact,
      WEB_TELEMETRY_SOURCE,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
    );
    return;
  }
  if (pathname === "/api/source") {
    const id = url.searchParams.get("id");
    const descriptor = id ? ctx.graphStore.descriptor(id) : undefined;
    sendSource(response, descriptor?.sourceRoot ?? null, url.searchParams);
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
  if (pathname === "/api/cache/status") {
    await handleCacheStatus(ctx, request, response, url.searchParams);
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

function loadTelemetryGraph(ctx: Context, response: ServerResponse, id: string | null) {
  const artifact = id ? ctx.graphStore.loadArtifact(id) : undefined;
  if (artifact === undefined) {
    sendJson(response, 404, { error: "unknown graph id" });
    return null;
  }
  return artifact;
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof SyntheticExecutionError || error instanceof WebError) {
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
