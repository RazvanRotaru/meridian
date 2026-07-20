import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { CliError, EXIT } from "../errors";
import { serveStatic } from "./static-files";
import type { StaticAssets } from "./static-files";
import { sendOverlay as sendTelemetryOverlay, sendTraces as sendTelemetryTraces } from "./api";
import { WebError } from "./web-error";
import { cancelWhenClientLeaves } from "./web-cancellation";
import { createSourceTextAdmission, type SourceTextAdmission } from "./source-text-admission";
import { createGraphProjectionAdmission } from "./graph-projection-response";
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
import {
  GraphProjectionRegistry,
  handleGenerate,
  handleGraphProjection,
  handleGraphSymbolSearch,
  resolveSyntheticCapability,
  sendMeta,
  sendProjectionManifest,
  sendView,
} from "./web-graph";
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
import { handlePrPrepare } from "./web-pr-prepare";
import { sendPreparedReviewHandoff } from "./web-pr-prepared";
import { handlePickFolder } from "./web-pick-folder";
import { handleRepoPullRequests } from "./web-repo-pulls";
import { sendSource } from "./source-serve";
import { cachedPrPreparation, PrBaseInspectionCoordinator } from "./web-pr-cache";
import type {
  CachedPrPreparation,
  PrPreparationInputs,
  PrPrepareProgress,
} from "./web-pr-cache";
import { resolveWebCacheRoot } from "./web-cache-storage";
import { handleCacheStatus } from "./web-cache-status";
import { parseSyntheticExecutionRequest, readJsonBody } from "./web-request";
import {
  runSyntheticScenarioFromArtifactFile,
  runSyntheticScenarioInOci,
  SyntheticExecutionError,
  syntheticPrSandboxRuntimeSupported,
} from "./synthetic-execution";
import { InspectionQueueFullError, InspectionScheduler } from "./inspection-scheduler";
import { GraphCapabilityStore } from "./graph-capability-store";
import { GraphGenerationLifecycle } from "./graph-generation-lifecycle";
import { GraphGenerationGarbageCollector } from "./graph-generation-gc";
import { GraphGenerationMaintenanceCoordinator } from "./graph-generation-maintenance";
import { RepositoryMirrorStore } from "./repository-mirror";
import { extractionWorkerHeapMb, runExtractionWorker } from "./extraction-worker";
import type {
  ExtractionWorkerResult,
  ExtractionWorkerRunner,
  SerializablePipelineRequest,
} from "./extraction-worker";
import {
  resolveExtractionWorkerConcurrency,
  resolveGenerationConcurrency,
  resolvePrInspectionConcurrency,
} from "./inspection-capacity";
import {
  PreparedReviewHandoffStore,
  type PreparedReviewHandoffStoreOptions,
} from "./prepared-review-handoff-store";
import { PrFilesCache } from "./pr-files-cache";

const WEB_TELEMETRY_SOURCE = { kind: "none" } as const;
const API_METHODS = new Map<string, readonly ("GET" | "POST")[]>([
  ["/api/generate", ["POST"]],
  ["/api/graph/projection", ["POST"]],
  ["/api/graph/search", ["POST"]],
  ["/api/pr/prepare", ["POST"]],
  ["/api/synthetic-executions", ["POST"]],
  ["/api/auth/device", ["POST"]],
  ["/api/auth/logout", ["POST"]],
  ["/api/pick-folder", ["POST"]],
  ["/api/prs/review", ["POST"]],
  ["/api/prs/related", ["POST"]],
  ["/api/graph/manifest", ["GET"]],
  ["/api/pr/prepared", ["GET"]],
  ["/api/meta", ["GET"]],
  ["/api/overlay", ["GET"]],
  ["/api/traces", ["GET"]],
  ["/api/source", ["GET"]],
  ["/api/prs", ["GET"]],
  ["/api/prs/one", ["GET"]],
  ["/api/prs/files", ["GET"]],
  ["/api/prs/comments", ["GET", "POST"]],
  ["/api/prs/checks", ["GET"]],
  ["/api/prs/file", ["GET"]],
  ["/api/auth/status", ["GET"]],
  ["/api/auth/session", ["GET"]],
  ["/api/repos/branches", ["GET"]],
  ["/api/cache/status", ["GET"]],
  ["/api/repos/pulls", ["GET"]],
  ["/api/repos/search", ["GET"]],
  ["/api/repos/mine", ["GET"]],
]);
const GRAPH_CAPABILITY_API_PATHS = new Set([
  "/api/generate",
  "/api/graph/projection",
  "/api/graph/search",
  "/api/graph/manifest",
  "/api/pr/prepare",
  "/api/pr/prepared",
  "/api/synthetic-executions",
  "/api/meta",
  "/api/overlay",
  "/api/traces",
  "/api/source",
]);

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
  /** Optional deployment overrides for bounded prepared-review metadata retention. */
  preparedReviewHandoffLimits?: Pick<
    PreparedReviewHandoffStoreOptions,
    "maxEntries" | "maxCacheBytes" | "maxAgeMs"
  >;
  /** Explicit opt-in; individual graph ids are still restricted to local `kind:path` sources. */
  allowSyntheticExecution?: boolean;
  /** Separate opt-in for consent-gated prepared PR-head runs in an available OCI sandbox. */
  allowSyntheticPrExecution?: boolean;
}

/** Explicit ownership boundary for the HTTP listener and its persistent lifecycle authorities. */
export interface WebServerHandle {
  readonly server: Server;
  close(): Promise<void>;
}

export interface Context {
  /** Process-local shutdown ownership propagated into every graph lifecycle request. */
  shutdownSignal: AbortSignal;
  /** Per-PR repo-root changed paths, invalidated when GitHub's updated_at or head SHA changes. */
  prFilesCache: PrFilesCache;
  /** All cold PR inspections pass through one bounded, cancellable singleflight boundary. */
  prInspectionScheduler: InspectionScheduler<string, PrPreparationInputs, CachedPrPreparation, PrPrepareProgress>;
  /** Owns merge-base singleflights after individual subscribers stop waiting. */
  prBaseInspectionCoordinator: PrBaseInspectionCoordinator;
  /** Base/local generation lifecycle admission; extraction still shares the stricter worker pool. */
  generationScheduler: InspectionScheduler<string, GenerationLifecycleJob, unknown, string>;
  /** Sole durable authority for coherent graph/generation/source capabilities. */
  graphCapabilities: GraphCapabilityStore;
  /** Durable publication/read pins shared with immutable-generation collection. */
  graphGenerationLifecycle: GraphGenerationLifecycle;
  /** Per-server recurring owner for disk-bounded immutable-generation collection. */
  graphGenerationMaintenance: GraphGenerationMaintenanceCoordinator;
  /** Restart-safe, file-backed prepared-review navigation metadata; never an in-memory registry. */
  preparedReviewHandoffs: PreparedReviewHandoffStore;
  /** Node-local bare object cache and isolated detached worktree allocator. */
  repositoryMirrors: RepositoryMirrorStore;
  /** Ordered startup reconciliation; remote capability routes fail closed until it completes. */
  lifecycleReady: Promise<void>;
  /** One process-wide pool bounds every CPU-heavy extraction, including base/local generation. */
  extractionScheduler: InspectionScheduler<string, ExtractionJob, ExtractionWorkerResult>;
  /** Aggregate transient projection result + transport memory; completed projections are not cached. */
  graphProjectionAdmission: ReturnType<typeof createGraphProjectionAdmission>;
  /** Per-server bounded parsed-page cache; disposed only after the request registry is drained. */
  graphProjectionRegistry: GraphProjectionRegistry;
  /** Per-server count/weight boundary for raw source reads and response bodies. */
  sourceTextAdmission: SourceTextAdmission;
  runExtraction: ExtractionWorkerRunner;
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
  /** Local file worker; the long-lived server never parses artifact.json. */
  runSyntheticScenarioFromArtifactFile: typeof runSyntheticScenarioFromArtifactFile;
  /** Injectable OCI executor; never substituted with the host-process runner. */
  runSyntheticScenarioInOci: typeof runSyntheticScenarioInOci;
}

class RequestTaskRegistry {
  private readonly tasks = new Set<Promise<void>>();
  private sealed = false;

  admit(request: IncomingMessage, response: ServerResponse, operation: () => Promise<void>): void {
    if (this.sealed) {
      request.destroy();
      response.destroy();
      return;
    }
    let task!: Promise<void>;
    let pending: Promise<void>;
    try {
      pending = operation();
    } catch (error) {
      pending = Promise.reject(error);
    }
    task = pending.finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  seal(): void {
    this.sealed = true;
  }

  async drain(): Promise<void> {
    if (!this.sealed) throw new Error("request task registry must be sealed before drain");
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

export function createWebServer(config: WebServerConfig): WebServerHandle {
  const shutdown = new AbortController();
  const ctx = buildContext(config, shutdown.signal);
  const requestTasks = new RequestTaskRegistry();
  const server = createServer((request, response) => {
    requestTasks.admit(request, response, () => handle(ctx, request, response)
      .catch((error) => sendError(response, error)));
  });
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    close(): Promise<void> {
      if (closePromise === undefined) {
        // Seal synchronously: a parser callback already queued on a keep-alive socket must not
        // enter after the close call has established the shutdown boundary.
        requestTasks.seal();
        closePromise = closeWebServer(server, ctx, requestTasks, shutdown);
      }
      return closePromise;
    },
  });
}

async function closeWebServer(
  server: Server,
  ctx: Context,
  requestTasks: RequestTaskRegistry,
  shutdown: AbortController,
): Promise<void> {
  const errors: unknown[] = [];
  const listenerClosed = server.listening
    ? new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeIdleConnections?.();
      })
    : Promise.resolve();

  // Closing each scheduler synchronously seals its admission boundary. Only then broadcast the
  // server abort to request-owned projection/preparation work; the promises below remain the
  // physical drain joins rather than merely subscriber cancellation acknowledgements.
  const schedulerDrains = beginShutdownOperations(errors, [
    () => ctx.generationScheduler.close(),
    () => ctx.prInspectionScheduler.close(),
  ]);
  if (!shutdown.signal.aborted) shutdown.abort(webServerClosingError());
  const maintenanceDrain = beginShutdownOperations(errors, [
    () => ctx.graphGenerationMaintenance.close(ctx.shutdownSignal.reason),
  ]);
  await collectShutdownErrors(errors, schedulerDrains);
  await collectShutdownErrors(errors, maintenanceDrain);
  await runShutdownOperations(errors, [
    () => ctx.prBaseInspectionCoordinator.close(ctx.shutdownSignal.reason),
  ]);
  await runShutdownOperations(errors, [() => ctx.extractionScheduler.close()]);
  await collectShutdownErrors(errors, [requestTasks.drain()]);
  await runShutdownOperations(errors, [async () => ctx.graphProjectionRegistry.dispose()]);
  // Connections that become idle only after their request task drains were not eligible for the
  // initial closeIdleConnections call above. Retire them now so shutdown never waits out Node's
  // keep-alive timeout after all owned work is already complete.
  server.closeIdleConnections?.();
  await collectShutdownErrors(errors, [listenerClosed]);
  await collectShutdownErrors(errors, [ctx.lifecycleReady]);
  await runShutdownOperations(errors, [() => ctx.repositoryMirrors.close()]);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "web server shutdown failed");
}

async function collectShutdownErrors(errors: unknown[], operations: readonly Promise<unknown>[]): Promise<void> {
  for (const result of await Promise.allSettled(operations)) {
    if (result.status === "rejected") errors.push(result.reason);
  }
}

function beginShutdownOperations(
  errors: unknown[],
  operations: readonly (() => Promise<unknown>)[],
): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  for (const operation of operations) {
    try {
      pending.push(operation());
    } catch (error) {
      errors.push(error);
    }
  }
  return pending;
}

async function runShutdownOperations(
  errors: unknown[],
  operations: readonly (() => Promise<unknown>)[],
): Promise<void> {
  await collectShutdownErrors(errors, beginShutdownOperations(errors, operations));
}

async function withReleasedResource<Resource extends { release(): Promise<void> }, Result>(
  resource: Resource,
  label: string,
  operation: (resource: Resource) => Promise<Result>,
): Promise<Result> {
  let failed = false;
  let failure: unknown;
  try {
    return await operation(resource);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      await resource.release();
    } catch (releaseError) {
      if (failed) {
        throw new AggregateError([failure, releaseError], `${label} operation and release both failed`);
      }
      throw releaseError;
    }
  }
}

function serverRequestLifecycle(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  message: string,
): { signal: AbortSignal; dispose(): void } {
  const client = cancelWhenClientLeaves(request, response, message);
  const signal = AbortSignal.any([client.signal, ctx.shutdownSignal]);
  const destroyRequest = () => {
    if (!request.destroyed) request.destroy();
  };
  signal.addEventListener("abort", destroyRequest, { once: true });
  if (signal.aborted) destroyRequest();
  return {
    signal,
    dispose() {
      signal.removeEventListener("abort", destroyRequest);
      client.dispose();
    },
  };
}

function buildContext(config: WebServerConfig, shutdownSignal: AbortSignal): Context {
  const indexPath = join(config.rendererRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new CliError(EXIT.io, `renderer bundle not found at ${config.rendererRoot} — run \`pnpm --filter @meridian/cli copy-renderer\``);
  }
  const github = createGitHubClient({ clientId: resolveGitHubClientId(config.githubClientId) });
  const landing = injectPrefill(readFileSync(config.webUiPath, "utf8"), config.source);
  const cacheRoot = resolveWebCacheRoot(config.cacheRoot);
  const repositoryMirrors = new RepositoryMirrorStore({ cacheRoot });
  const prBaseInspectionCoordinator = new PrBaseInspectionCoordinator();
  const workerConcurrency = extractionWorkerConcurrency();
  const prConcurrency = resolvePrInspectionConcurrency(process.env.MERIDIAN_PR_INSPECTION_CONCURRENCY);
  const generationConcurrency = resolveGenerationConcurrency(process.env.MERIDIAN_GENERATION_CONCURRENCY);
  const extractionScheduler = new InspectionScheduler<string, ExtractionJob, ExtractionWorkerResult>({
    concurrency: workerConcurrency,
    maxQueued: queueLimit(process.env.MERIDIAN_EXTRACTION_QUEUE_LIMIT, workerConcurrency),
    execute: ({ input, signal }) => runExtractionWorker(input.request, {
      artifactOutputPath: input.artifactOutputPath,
      lifecycleCacheRoot: cacheRoot,
      token: input.token,
      signal,
    }),
  });
  const runExtraction: ExtractionWorkerRunner = (request, options) => {
    try {
      return extractionScheduler.schedule(
        extractionJobKey(request, options.artifactOutputPath, options.token),
        { kind: "extract", request, artifactOutputPath: options.artifactOutputPath, token: options.token },
        {
          signal: options.signal,
          admitted: options.admitted,
          fairnessGroup: options.schedulingGroup,
          // The PR cache owns the worker's checkout lease. Do not let cancellation unwind that
          // owner until the child process has physically drained from the scheduler.
          awaitExecutorDrain: true,
        },
      );
    } catch (error) {
      if (error instanceof InspectionQueueFullError) throw new WebError(error.status, error.message);
      throw error;
    }
  };
  const graphCapabilities = new GraphCapabilityStore({ cacheRoot, repositoryMirrors });
  const graphGenerationLifecycle = new GraphGenerationLifecycle({ cacheRoot });
  const graphGenerationGarbageCollector = new GraphGenerationGarbageCollector({
    cacheRoot,
    lifecycle: graphGenerationLifecycle,
    repositoryMirrors,
  });
  const preparedReviewHandoffs = new PreparedReviewHandoffStore({
    cacheRoot,
    graphCapabilities,
    ...config.preparedReviewHandoffLimits,
  });
  const graphGenerationMaintenance = new GraphGenerationMaintenanceCoordinator({
    collector: graphGenerationGarbageCollector,
    roots: graphCapabilities,
    shutdownSignal,
  });
  const lifecycleReady = (async () => {
    shutdownSignal.throwIfAborted();
    await graphCapabilities.reconcile({ signal: shutdownSignal });
    shutdownSignal.throwIfAborted();
    await preparedReviewHandoffs.reconcile({ signal: shutdownSignal });
    shutdownSignal.throwIfAborted();
    await graphCapabilities.scavenge({ signal: shutdownSignal });
    shutdownSignal.throwIfAborted();
    await graphGenerationMaintenance.start();
    shutdownSignal.throwIfAborted();
    await repositoryMirrors.scavenge({ signal: shutdownSignal });
    shutdownSignal.throwIfAborted();
  })()
    .catch((error: unknown) => {
      if (expectedShutdownError(error, shutdownSignal)) return;
      throw error;
    });
  const ctx: Context = {
    shutdownSignal,
    prFilesCache: new PrFilesCache(),
    extractionScheduler,
    graphProjectionAdmission: createGraphProjectionAdmission(),
    graphProjectionRegistry: new GraphProjectionRegistry(),
    sourceTextAdmission: createSourceTextAdmission(),
    runExtraction,
    generationScheduler: new InspectionScheduler({
      concurrency: generationConcurrency,
      maxQueued: queueLimit(process.env.MERIDIAN_GENERATION_QUEUE_LIMIT, generationConcurrency),
      execute: ({ input, signal, reportProgress }) => input.run(signal, reportProgress),
    }),
    prInspectionScheduler: new InspectionScheduler({
      concurrency: prConcurrency,
      maxQueued: queueLimit(process.env.MERIDIAN_PR_INSPECTION_QUEUE_LIMIT, prConcurrency),
      execute: ({ key, input, signal, reportProgress }) => cachedPrPreparation({
        ...input,
        signal,
        extractionAdmitted: true,
        extractionSchedulingGroup: key,
        onProgress: reportProgress,
        repositoryMirrors,
        baseInspectionCoordinator: prBaseInspectionCoordinator,
        generationLifecycle: graphGenerationLifecycle,
        runExtraction,
      }),
    }),
    prBaseInspectionCoordinator,
    graphCapabilities,
    graphGenerationLifecycle,
    graphGenerationMaintenance,
    preparedReviewHandoffs,
    repositoryMirrors,
    lifecycleReady,
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
    runSyntheticScenarioFromArtifactFile,
    runSyntheticScenarioInOci,
  };
  // Observe rejection so server construction remains synchronous; every remote route awaits the
  // same promise and fails closed with the original reconciliation error.
  void lifecycleReady.catch(() => undefined);
  return ctx;
}

function webServerClosingError(): Error {
  const error = new Error("The web server is closing");
  error.name = "AbortError";
  return error;
}

function expectedShutdownError(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return !(error instanceof AggregateError)
    && error instanceof Error
    && error.name === "AbortError";
}

interface ExtractionJob {
  readonly kind: "extract";
  readonly request: SerializablePipelineRequest;
  readonly artifactOutputPath: string;
  readonly token?: string;
}

interface GenerationLifecycleJob {
  readonly run: (signal: AbortSignal, reportProgress: (stage: string) => void) => Promise<unknown>;
}

function extractionJobKey(
  request: SerializablePipelineRequest,
  artifactOutputPath: string,
  token: string | undefined,
): string {
  const credential = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
  return createHash("sha256").update(JSON.stringify({ request, artifactOutputPath, credential })).digest("hex");
}

function queueLimit(value: string | undefined, concurrency: number): number {
  const configured = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : concurrency;
}

function extractionWorkerConcurrency(): number {
  const bytesPerMb = 1024 ** 2;
  const availableBytes = typeof process.availableMemory === "function" ? process.availableMemory() : totalmem();
  return resolveExtractionWorkerConcurrency({
    totalMemoryMb: totalmem() / bytesPerMb,
    availableMemoryMb: availableBytes / bytesPerMb,
    parentHeapMb: getHeapStatistics().heap_size_limit / bytesPerMb,
    workerHeapMb: extractionWorkerHeapMb(),
    requestedConcurrency: process.env.MERIDIAN_EXTRACTION_WORKER_CONCURRENCY,
    memoryBudgetMb: process.env.MERIDIAN_EXTRACTION_MEMORY_BUDGET_MB,
  });
}

async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(ctx, request, response, url);
    return;
  }
  if (url.pathname === "/view") {
    await ctx.lifecycleReady;
    await sendView(ctx, request, response, url.searchParams.get("id"), {
      preparedId: url.searchParams.get("prepared"),
      prNumber: url.searchParams.get("prn"),
      revision: url.searchParams.get("rev"),
      view: url.searchParams.get("view"),
    });
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
  const allowed = API_METHODS.get(url.pathname);
  if (!allowed) {
    sendJson(response, 404, { error: "unknown endpoint" });
    return;
  }
  const method = request.method ?? "GET";
  if ((method !== "GET" && method !== "POST") || !allowed.includes(method)) {
    sendJson(response, 405, { error: "method not allowed" }, { allow: allowed.join(", ") });
    return;
  }
  if (GRAPH_CAPABILITY_API_PATHS.has(url.pathname)) await ctx.lifecycleReady;
  if (method === "POST") {
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
  if (pathname === "/api/graph/projection") {
    await handleGraphProjection(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/graph/search") {
    await handleGraphSymbolSearch(ctx, request, response, url.searchParams);
    return;
  }
  if (pathname === "/api/pr/prepare") {
    await handlePrPrepare(ctx, request, response);
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
  const lifecycle = serverRequestLifecycle(
    ctx,
    request,
    response,
    "The client closed the synthetic execution request",
  );
  try {
    const capability = await resolveSyntheticCapability(ctx, id, lifecycle.signal);
    if (!capability
      || capability.scenarios.length === 0
      || capability.sourceFingerprint === null) {
      sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
      return;
    }
    const sourceFingerprint = capability.sourceFingerprint;
    await withReleasedResource(capability, "synthetic graph capability", async () => {
      const sandboxedPrAdmission = capability.trust.mode === "sandboxed-pr";
      if (sandboxedPrAdmission && request.headers["x-meridian-sandbox-consent"] !== "true") {
        sendJson(response, 403, { error: "sandbox consent is required for GitHub synthetic execution" });
        return;
      }
      const operationSignal = AbortSignal.any([lifecycle.signal, capability.signal]);
      const body = parseSyntheticExecutionRequest(await readJsonBody({ request, signal: operationSignal }));
      const scenario = capability.scenarios.find((candidate) => candidate.id === body.scenarioId);
      if (scenario === undefined) {
        sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
        return;
      }
      if (scenario.rootId !== body.rootNodeId) {
        throw new WebError(409, "selected flow no longer matches the synthetic scenario");
      }
      const executionRequest = {
        sourceRoot: capability.sourceRoot,
        artifactPath: capability.artifactPath,
        scenarioId: body.scenarioId,
        expectedRootId: body.rootNodeId,
        expectedSourceFingerprint: sourceFingerprint,
        input: body.input,
        inputOverrides: body.inputOverrides,
        watchers: body.watchers,
        signal: operationSignal,
      };
      const execution = sandboxedPrAdmission
        ? await ctx.runSyntheticScenarioInOci(executionRequest)
        : await ctx.runSyntheticScenarioFromArtifactFile(executionRequest);
      sendJson(response, 200, execution);
    });
  } finally {
    lifecycle.dispose();
  }
}

async function handleApiGet(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph/manifest") {
    await sendProjectionManifest(ctx, request, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/pr/prepared") {
    await sendPreparedReviewHandoff(ctx, request, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/meta") {
    await sendMeta(ctx, request, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/overlay") {
    const lifecycle = serverRequestLifecycle(ctx, request, response, "The client closed the overlay request");
    try {
      const artifact = await acquireArtifact(ctx, response, url.searchParams.get("id"), lifecycle.signal);
      if (artifact === null) return;
      await withReleasedResource(artifact, "overlay graph capability", async () => {
        const operationSignal = AbortSignal.any([lifecycle.signal, artifact.signal]);
        operationSignal.throwIfAborted();
        await sendTelemetryOverlay(
          response,
          WEB_TELEMETRY_SOURCE,
          url.searchParams.get("env"),
          url.searchParams.get("source"),
          { artifactPath: artifact.path, scratchRoot: join(ctx.cacheRoot, "web-telemetry"), signal: operationSignal },
        );
      });
    } finally {
      lifecycle.dispose();
    }
    return;
  }
  if (pathname === "/api/traces") {
    const lifecycle = serverRequestLifecycle(ctx, request, response, "The client closed the traces request");
    try {
      const artifact = await acquireArtifact(ctx, response, url.searchParams.get("id"), lifecycle.signal);
      if (artifact === null) return;
      await withReleasedResource(artifact, "traces graph capability", async () => {
        const operationSignal = AbortSignal.any([lifecycle.signal, artifact.signal]);
        operationSignal.throwIfAborted();
        await sendTelemetryTraces(
          response,
          WEB_TELEMETRY_SOURCE,
          url.searchParams.get("env"),
          url.searchParams.get("source"),
          { artifactPath: artifact.path, scratchRoot: join(ctx.cacheRoot, "web-telemetry"), signal: operationSignal },
        );
      });
    } finally {
      lifecycle.dispose();
    }
    return;
  }
  if (pathname === "/api/source") {
    const lifecycle = serverRequestLifecycle(ctx, request, response, "The client closed the source request");
    const id = url.searchParams.get("id") ?? "";
    try {
      const handle = await ctx.graphCapabilities.acquire(id, { signal: lifecycle.signal });
      if (!handle) {
        await sendSource(response, null, url.searchParams, {
          admission: ctx.sourceTextAdmission,
          signal: lifecycle.signal,
        });
        return;
      }
      await withReleasedResource(handle, "source graph capability", async () => {
        const operationSignal = AbortSignal.any([lifecycle.signal, handle.signal]);
        operationSignal.throwIfAborted();
        await sendSource(
          response,
          handle.source.sourceDir,
          url.searchParams,
          { admission: ctx.sourceTextAdmission, signal: operationSignal },
        );
      });
    } finally {
      lifecycle.dispose();
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

async function acquireArtifact(
  ctx: Context,
  response: ServerResponse,
  id: string | null,
  signal: AbortSignal,
): Promise<{ path: string; signal: AbortSignal; release(): Promise<void> } | null> {
  if (id === null) {
    sendJson(response, 404, { error: "unknown graph id" });
    return null;
  }
  const handle = await ctx.graphCapabilities.acquire(id, { signal });
  if (!handle) {
    sendJson(response, 404, { error: "unknown graph id" });
    return null;
  }
  return { path: handle.artifactPath, signal: handle.signal, release: handle.release };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded || response.destroyed) {
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
