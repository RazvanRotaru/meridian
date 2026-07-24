import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, EXIT } from "../errors";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { sendOverlay as sendTelemetryOverlay, sendTraces as sendTelemetryTraces } from "./api";
import { WebError } from "./web-error";
import { injectPrefill } from "./web-boot";
import { sendHtml, sendJson } from "./http-response";
import { createHttpService, type HttpService } from "./http-service";
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
  handlePullRequestViewedFiles,
  handleRelatedPullRequests,
  handleSetPullRequestViewedFile,
  handlePullRequests,
  handleSubmitReview,
} from "./web-prs";
import { handlePrAnalyze } from "./web-pr-analyze";
import { handlePickFolder } from "./web-pick-folder";
import { pickFolder } from "./folder-dialog";
import { handleRepoPullRequests } from "./web-repo-pulls";
import { sendSource } from "./source-serve";
import { resolveWebCacheRoot } from "./web-cache-storage";
import { handleCacheStatus } from "./web-cache-status";
import { AnalysisCoordinator } from "./web-analysis-coordinator";
import { requestCancellation, responseCanWrite } from "./web-cancellation";
import { sendOverloadJson } from "./web-overload";
import { WebGraphStore } from "./web-graph-store";
import type { GraphRetentionOptions } from "./web-graph-retention";
import {
  handleGraphViewCreate,
  handleGraphViewDelete,
  handleGraphViewPut,
} from "./web-graph-views";
import { parseSyntheticExecutionRequest, readJsonBody } from "./web-request";
import { SyntheticExecutionError } from "./synthetic-error";
import {
  runSyntheticScenarioInOci,
  syntheticPrSandboxRuntimeSupported,
} from "./synthetic-oci";
import {
  runRepositoryAnalysisChild,
  runRepositoryArtifactRestampChild,
} from "./repository-analysis-child";
import {
  repositoryAnalysisMemoryPolicy,
  type RepositoryAnalysisMemoryPolicy,
} from "./repository-analysis-memory";
import { WebRepositoryMirror, type RepositoryMirror } from "./web-repository-mirror";
import type { RepositoryRetentionOptions } from "./web-repository-retention";
import { isWebServiceShutdown, WEB_SERVICE_SHUTDOWN_MESSAGE } from "./web-service-shutdown";

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
  /** Internal upper bound for memory-heavy analysis concurrency; never bypasses the memory budget. */
  maxConcurrentAnalyses?: number;
  /** Internal bounds for deterministic admission/load tests; production uses conservative defaults. */
  maxConcurrentPreparations?: number;
  maxQueuedPreparations?: number;
  maxQueuedAnalyses?: number;
  /** Internal analysis boundary override used by deterministic server tests. */
  repositoryAnalysis?: typeof runRepositoryAnalysisChild;
  /** Internal artifact-restamp boundary override used by deterministic server tests. */
  repositoryArtifactRestamp?: typeof runRepositoryArtifactRestampChild;
  /** Internal persistent repository boundary override used by deterministic server tests. */
  repositories?: RepositoryMirror;
  /** Internal native-picker boundary override used by deterministic lifecycle tests. */
  folderPicker?: typeof pickFolder;
  /** Persistent repository-store budget override; production resolves environment defaults. */
  repositoryRetention?: Partial<RepositoryRetentionOptions>;
  /** Process-private inactive graph registration budget override. */
  graphRetention?: Partial<GraphRetentionOptions>;
  /** Optional background-maintenance diagnostic sink. */
  onRepositoryRetentionError?: (error: unknown) => void;
  /** Optional process-private graph-registry cleanup diagnostic sink. */
  onGraphRetentionError?: (error: unknown) => void;
}

export interface Context {
  /** Service-wide cancellation boundary, aborted synchronously before resource draining starts. */
  shutdownSignal: AbortSignal;
  /** Disk-backed immutable graph registrations; request handlers load at most one artifact. */
  graphStore: WebGraphStore;
  /** Per-PR repo-root changed paths, invalidated when GitHub's updated_at or head SHA changes. */
  prFilesCache: Map<string, { updatedAt: string; headSha: string | null; paths: string[] }>;
  /** Ephemeral waiter-safe singleflight plus bounded admission for memory-heavy extraction. */
  analysisCoordinator: AnalysisCoordinator;
  /** Shared credential-free mirrors and exact-revision source workspaces. */
  repositories: RepositoryMirror;
  /** Disposable child boundary. The web parent never receives a graph object from it. */
  repositoryAnalysis: typeof runRepositoryAnalysisChild;
  /** Disposable child boundary for immutable branch-provenance derivatives. */
  repositoryArtifactRestamp: typeof runRepositoryArtifactRestampChild;
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
  folderPicker: typeof pickFolder;
}

export interface WebService extends HttpService {}

export function createWebService(config: WebServerConfig): WebService {
  // Validate and read every synchronous boot input before allocating timers or temporary stores.
  const staticContext = loadStaticContext(config);
  const analysisMemory = repositoryAnalysisMemoryPolicy({
    maxConcurrentAnalyses: config.maxConcurrentAnalyses,
  });
  const analysisCoordinator = new AnalysisCoordinator({
    maxConcurrentAnalyses: analysisMemory.maxConcurrentAnalyses,
    maxConcurrentPreparations: config.maxConcurrentPreparations,
    maxQueuedPreparations: config.maxQueuedPreparations,
    maxQueuedAnalyses: config.maxQueuedAnalyses,
  });
  const cacheRoot = resolveWebCacheRoot(config.cacheRoot);
  // Validate every retention target before allocating the graph store's private temporary root.
  const graphStore = new WebGraphStore(config.graphRetention, {
    onError: config.onGraphRetentionError,
  });
  let repositories: RepositoryMirror;
  try {
    repositories = config.repositories ?? new WebRepositoryMirror({
      cacheRoot,
      retention: config.repositoryRetention,
      onRetentionError: config.onRepositoryRetentionError,
    });
  } catch (error) {
    void analysisCoordinator.close();
    graphStore.dispose();
    throw error;
  }
  let ctx!: Context;
  const service = createHttpService({
    handle: (request, response) => handle(ctx, request, response),
    handleError: (response, error) => sendError(response, error),
    rejectRequest: (response) => sendJson(
      response,
      503,
      { error: WEB_SERVICE_SHUTDOWN_MESSAGE },
      { connection: "close" },
    ),
    beginShutdown: [
      () => analysisCoordinator.close(),
      () => repositories.close(),
    ],
    finishShutdown: () => {
      ctx.prFilesCache.clear();
      ctx.sessions.clear();
      graphStore.dispose();
    },
  });
  ctx = buildContext(
    config,
    staticContext,
    graphStore,
    analysisCoordinator,
    analysisMemory,
    repositories,
    cacheRoot,
    service.signal,
  );
  return service;
}

function buildContext(
  config: WebServerConfig,
  staticContext: StaticWebContext,
  graphStore: WebGraphStore,
  analysisCoordinator: AnalysisCoordinator,
  analysisMemory: RepositoryAnalysisMemoryPolicy,
  repositories: RepositoryMirror,
  cacheRoot: string,
  shutdownSignal: AbortSignal,
): Context {
  const repositoryAnalysis = config.repositoryAnalysis ?? runRepositoryAnalysisChild;
  const repositoryArtifactRestamp = config.repositoryArtifactRestamp
    ?? runRepositoryArtifactRestampChild;
  const ctx: Context = {
    shutdownSignal,
    graphStore,
    prFilesCache: new Map(),
    analysisCoordinator,
    repositories,
    repositoryAnalysis: (request, options) => repositoryAnalysis(request, {
      ...options,
      workerHeapMb: analysisMemory.workerHeapMb,
    }),
    repositoryArtifactRestamp: (request, options) => repositoryArtifactRestamp(request, {
      ...options,
      workerHeapMb: analysisMemory.workerHeapMb,
    }),
    cacheRoot,
    refreshCache: config.refreshCache === true,
    rendererIndex: staticContext.rendererIndex,
    landingHtml: staticContext.landingHtml,
    // Stray routes fall back to the front door rather than the renderer shell.
    staticAssets: { rendererRoot: config.rendererRoot, indexHtml: staticContext.landingHtml },
    cwd: config.cwd,
    sessions: new SessionStore(),
    github: staticContext.github,
    fallbackToken: config.fallbackToken,
    fallbackUser: config.fallbackUser,
    allowSyntheticExecution: config.allowSyntheticExecution === true,
    allowSyntheticPrExecution: config.allowSyntheticPrExecution === true,
    syntheticPrSandboxRuntimeSupported,
    runSyntheticScenarioInOci,
    folderPicker: config.folderPicker ?? pickFolder,
  };
  return ctx;
}

interface StaticWebContext {
  readonly rendererIndex: string;
  readonly landingHtml: string;
  readonly github: GitHubClient;
}

function loadStaticContext(config: WebServerConfig): StaticWebContext {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  return {
    rendererIndex: readFileSync(indexPath, "utf8"),
    landingHtml: injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source),
    github: createGitHubClient({ clientId: resolveGitHubClientId(config.githubClientId) }),
  };
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
  const graphViewLeaseId = graphViewLeaseIdFromPath(url.pathname);
  if (request.method === "PUT" && graphViewLeaseId !== null) {
    assertJsonContentType(request);
    await handleGraphViewPut(ctx.graphStore, request, response, graphViewLeaseId, ctx.shutdownSignal);
    return;
  }
  if (request.method === "DELETE" && graphViewLeaseId !== null) {
    handleGraphViewDelete(ctx.graphStore, response, graphViewLeaseId);
    return;
  }
  await handleApiGet(ctx, request, response, url);
}

function graphViewLeaseIdFromPath(pathname: string): string | null {
  const match = /^\/api\/graph-views\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

async function handleApiPost(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph-views") {
    await handleGraphViewCreate(ctx.graphStore, request, response, ctx.shutdownSignal);
    return;
  }
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
    const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
    try {
      await handlePickFolder(response, cancellation.signal, ctx.folderPicker);
    } finally {
      cancellation.dispose();
    }
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
  if (pathname === "/api/prs/viewed-files") {
    await handleSetPullRequestViewedFile(ctx, request, response, url.searchParams);
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
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  const registration = id ? ctx.graphStore.acquire(id) : undefined;
  if (registration === undefined) {
    cancellation.dispose();
    sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
    return;
  }
  try {
    const descriptor = registration.descriptor;
    const sourceRoot = descriptor.sourceRoot;
    const source = descriptor.source;
    const scenarios = descriptor.synthetic.scenarios;
    const sourceFingerprint = descriptor.synthetic.sourceFingerprint ?? undefined;
    const trust = descriptor.synthetic.trust ?? undefined;
    const localAdmission = source.kind === "path"
      && ctx.allowSyntheticExecution
      && trust?.mode === "local";
    const sandboxedPrAdmission = source.kind === "github"
      && ctx.allowSyntheticPrExecution
      && trust?.mode === "sandboxed-pr"
      && trust.provenance.repository === `${source.owner}/${source.repo}`
      && trust.provenance.headSha.length > 0
      && ctx.syntheticPrSandboxRuntimeSupported();
    if (
      (!localAdmission && !sandboxedPrAdmission)
      || scenarios.length === 0
      || sourceFingerprint === undefined
    ) {
      sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
      return;
    }
    const artifact = registration.loadArtifact();
    if (sandboxedPrAdmission && request.headers["x-meridian-sandbox-consent"] !== "true") {
      sendJson(response, 403, { error: "sandbox consent is required for GitHub synthetic execution" });
      return;
    }
    const body = parseSyntheticExecutionRequest(await readJsonBody(request, cancellation.signal));
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
      signal: cancellation.signal,
    };
    const execution = sandboxedPrAdmission
      ? await ctx.runSyntheticScenarioInOci(executionRequest)
      : await (await import("./synthetic-execution")).runSyntheticScenario(executionRequest);
    sendJson(response, 200, execution);
  } finally {
    registration.release();
    cancellation.dispose();
  }
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
    const registration = id ? ctx.graphStore.acquire(id) : undefined;
    try {
      sendSource(response, registration?.descriptor.sourceRoot ?? null, url.searchParams);
    } finally {
      registration?.release();
    }
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
  if (pathname === "/api/prs/viewed-files") {
    await handlePullRequestViewedFiles(ctx, request, response, url.searchParams);
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
    await handleRepoBranches(
      ctx,
      request,
      response,
      url.searchParams.get("repo") ?? "",
      url.searchParams.get("q") ?? undefined,
    );
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
  const registration = id ? ctx.graphStore.acquire(id) : undefined;
  if (registration === undefined) {
    sendJson(response, 404, { error: "unknown graph id" });
    return null;
  }
  try {
    return registration.loadArtifact();
  } finally {
    registration.release();
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (!responseCanWrite(response)) {
    return;
  }
  if (response.headersSent) {
    response.end();
    return;
  }
  if (isWebServiceShutdown(error)) {
    sendJson(response, 503, { error: WEB_SERVICE_SHUTDOWN_MESSAGE }, { connection: "close" });
    return;
  }
  if (sendOverloadJson(response, error)) {
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
