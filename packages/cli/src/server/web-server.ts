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
  handleGenerate,
  handleGraphProjection,
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
import type { ArtifactSource } from "./web-source";
import { sendSource } from "./source-serve";
import { cachedPrPreparation } from "./web-pr-cache";
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
import { InspectionSnapshotStore } from "./inspection-snapshot-store";
import { RepositoryMirrorStore } from "./repository-mirror";
import { extractionWorkerHeapMb, runExtractionWorker } from "./extraction-worker";
import type {
  ExtractionWorkerResult,
  ExtractionWorkerRunner,
  SerializablePipelineRequest,
} from "./extraction-worker";
import { resolveInspectionConcurrency } from "./inspection-capacity";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import {
  PreparedReviewHandoffStore,
  type PreparedReviewHandoffStoreOptions,
} from "./prepared-review-handoff-store";

const WEB_TELEMETRY_SOURCE = { kind: "none" } as const;
const API_METHODS = new Map<string, readonly ("GET" | "POST")[]>([
  ["/api/generate", ["POST"]],
  ["/api/graph/projection", ["POST"]],
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

export interface Context {
  /** File-backed local results; the server reads only their projection bundle and summary. */
  localGraphFiles: Map<string, {
    artifactPath: string;
    graphSummary: InspectionGraphSummary;
    projectionDirectory: string;
  }>;
  /** Per-id source directory retained after a successful generate so `/api/source` can read it. */
  sourceRoots: Map<string, string>;
  /** Per-id original source metadata retained for GitHub PR listing. */
  sources: Map<string, ArtifactSource>;
  /** Per-PR repo-root changed paths, invalidated when GitHub's updated_at or head SHA changes. */
  prFilesCache: Map<string, { updatedAt: string; headSha: string | null; paths: string[] }>;
  /** Temp-clone removers, held until process exit so retained sources are cleaned on shutdown. */
  tempCleanups: Set<() => void>;
  /** All cold PR inspections pass through one bounded, cancellable singleflight boundary. */
  prInspectionScheduler: InspectionScheduler<string, PrPreparationInputs, CachedPrPreparation, PrPrepareProgress>;
  /** Base/local generation lifecycle admission; extraction still shares the stricter worker pool. */
  generationScheduler: InspectionScheduler<string, GenerationLifecycleJob, unknown, string>;
  /** Restart-safe id resolver and bounded descriptor-only cache for immutable inspections. */
  inspectionSnapshots: InspectionSnapshotStore;
  /** Restart-safe, file-backed prepared-review navigation metadata; never an in-memory registry. */
  preparedReviewHandoffs: PreparedReviewHandoffStore;
  /** Node-local bare object cache and isolated detached worktree allocator. */
  repositoryMirrors: RepositoryMirrorStore;
  /** One process-wide pool bounds every CPU-heavy extraction, including base/local generation. */
  extractionScheduler: InspectionScheduler<string, ExtractionJob, ExtractionWorkerResult>;
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
  const cacheRoot = resolveWebCacheRoot(config.cacheRoot);
  const repositoryMirrors = new RepositoryMirrorStore({ cacheRoot });
  // Crash-orphaned detached worktrees and private refs must not accumulate forever. Scavenging is
  // lock-coordinated inside the mirror store and deliberately does not delay server readiness.
  void repositoryMirrors.scavenge().catch(() => {
    // Best effort: a later process/startup pass can retry, while live inspection remains usable.
  });
  const concurrency = inspectionConcurrency();
  const extractionScheduler = new InspectionScheduler<string, ExtractionJob, ExtractionWorkerResult>({
    concurrency,
    maxQueued: inspectionQueueLimit(concurrency),
    execute: ({ input, signal }) => runExtractionWorker(input.request, {
      artifactOutputPath: input.artifactOutputPath,
      token: input.token,
      signal,
    }),
  });
  const runExtraction: ExtractionWorkerRunner = (request, options) => {
    try {
      return extractionScheduler.schedule(
        extractionJobKey(request, options.artifactOutputPath, options.token),
        { kind: "extract", request, artifactOutputPath: options.artifactOutputPath, token: options.token },
        { signal: options.signal, admitted: options.admitted },
      );
    } catch (error) {
      if (error instanceof InspectionQueueFullError) throw new WebError(error.status, error.message);
      throw error;
    }
  };
  let inspectionSnapshots: InspectionSnapshotStore | undefined;
  let preparedReviewHandoffs: PreparedReviewHandoffStore | undefined;
  const generationConcurrency = Math.max(4, concurrency * 2);
  const ctx: Context = {
    localGraphFiles: new Map(),
    sourceRoots: new Map(),
    sources: new Map(),
    prFilesCache: new Map(),
    tempCleanups: new Set(),
    extractionScheduler,
    runExtraction,
    generationScheduler: new InspectionScheduler({
      concurrency: generationConcurrency,
      maxQueued: inspectionQueueLimit(generationConcurrency),
      execute: ({ input, signal, reportProgress }) => input.run(signal, reportProgress),
    }),
    prInspectionScheduler: new InspectionScheduler({
      concurrency,
      maxQueued: inspectionQueueLimit(concurrency),
      execute: ({ input, signal, reportProgress }) => cachedPrPreparation({
        ...input,
        signal,
        extractionAdmitted: true,
        onProgress: reportProgress,
        repositoryMirrors,
        runExtraction,
      }),
    }),
    get inspectionSnapshots() {
      // Most web sessions never inspect a PR. Keep boot and local-only generation free of cache
      // filesystem writes; the first immutable-id read or publication initializes the resolver.
      return inspectionSnapshots ??= new InspectionSnapshotStore({ cacheRoot });
    },
    get preparedReviewHandoffs() {
      return preparedReviewHandoffs ??= new PreparedReviewHandoffStore({
        cacheRoot,
        ...config.preparedReviewHandoffLimits,
      });
    },
    repositoryMirrors,
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
  cleanRetainedSourcesOnExit(ctx);
  return ctx;
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

function inspectionQueueLimit(concurrency: number): number {
  const configured = Number.parseInt(process.env.MERIDIAN_INSPECTION_QUEUE_LIMIT ?? "", 10);
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : concurrency;
}

function inspectionConcurrency(): number {
  const bytesPerMb = 1024 ** 2;
  const availableBytes = typeof process.availableMemory === "function" ? process.availableMemory() : totalmem();
  return resolveInspectionConcurrency({
    totalMemoryMb: totalmem() / bytesPerMb,
    availableMemoryMb: availableBytes / bytesPerMb,
    parentHeapMb: getHeapStatistics().heap_size_limit / bytesPerMb,
    workerHeapMb: extractionWorkerHeapMb(),
    requestedConcurrency: process.env.MERIDIAN_INSPECTION_CONCURRENCY,
    memoryBudgetMb: process.env.MERIDIAN_INSPECTION_MEMORY_BUDGET_MB,
  });
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
    sendView(ctx, response, url.searchParams.get("id"), {
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
    await handleGraphProjection(ctx, request, response, url.searchParams.get("id"));
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
  const capability = resolveSyntheticCapability(ctx, id);
  if (!capability
    || capability.scenarios.length === 0
    || capability.sourceFingerprint === null) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
    return;
  }
  const sandboxedPrAdmission = capability.trust.mode === "sandboxed-pr";
  if (sandboxedPrAdmission && request.headers["x-meridian-sandbox-consent"] !== "true") {
    sendJson(response, 403, { error: "sandbox consent is required for GitHub synthetic execution" });
    return;
  }
  const body = parseSyntheticExecutionRequest(await readJsonBody(request));
  const scenario = capability.scenarios.find((candidate) => candidate.id === body.scenarioId);
  if (scenario === undefined) {
    sendJson(response, 404, { error: "synthetic execution is not enabled for this graph" });
    return;
  }
  if (scenario.rootId !== body.rootNodeId) {
    throw new WebError(409, "selected flow no longer matches the synthetic scenario");
  }
  const cancellation = cancelSyntheticWhenClientLeaves(request, response);
  try {
    const executionRequest = {
      sourceRoot: capability.sourceRoot,
      artifactPath: capability.artifactPath,
      scenarioId: body.scenarioId,
      expectedRootId: body.rootNodeId,
      expectedSourceFingerprint: capability.sourceFingerprint,
      input: body.input,
      inputOverrides: body.inputOverrides,
      watchers: body.watchers,
      signal: cancellation.signal,
    };
    const execution = sandboxedPrAdmission
      ? await ctx.runSyntheticScenarioInOci(executionRequest)
      : await ctx.runSyntheticScenarioFromArtifactFile(executionRequest);
    sendJson(response, 200, execution);
  } finally {
    cancellation.dispose();
  }
}

function cancelSyntheticWhenClientLeaves(
  request: IncomingMessage,
  response: ServerResponse,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    const error = new Error("The client closed the synthetic execution request");
    error.name = "AbortError";
    controller.abort(error);
  };
  request.once("aborted", abort);
  const events = response as ServerResponse & {
    once?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
  };
  const onClose = () => {
    if (!response.writableEnded) abort();
  };
  events.once?.("close", onClose);
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      events.off?.("close", onClose);
    },
  };
}

async function handleApiGet(ctx: Context, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const pathname = url.pathname;
  if (pathname === "/api/graph/manifest") {
    sendProjectionManifest(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/pr/prepared") {
    await sendPreparedReviewHandoff(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/meta") {
    sendMeta(ctx, response, url.searchParams.get("id"));
    return;
  }
  if (pathname === "/api/overlay") {
    const artifactPath = telemetryArtifactPath(ctx, response, url.searchParams.get("id"));
    if (artifactPath === null) return;
    await sendTelemetryOverlay(
      response,
      WEB_TELEMETRY_SOURCE,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
      { artifactPath, scratchRoot: join(ctx.cacheRoot, "web-telemetry") },
    );
    return;
  }
  if (pathname === "/api/traces") {
    const artifactPath = telemetryArtifactPath(ctx, response, url.searchParams.get("id"));
    if (artifactPath === null) return;
    await sendTelemetryTraces(
      response,
      WEB_TELEMETRY_SOURCE,
      url.searchParams.get("env"),
      url.searchParams.get("source"),
      { artifactPath, scratchRoot: join(ctx.cacheRoot, "web-telemetry") },
    );
    return;
  }
  if (pathname === "/api/source") {
    const id = url.searchParams.get("id") ?? "";
    const sourceRoot = ctx.sourceRoots.get(id) ?? ctx.inspectionSnapshots.resolveSource(id)?.sourceDir ?? null;
    sendSource(response, sourceRoot, url.searchParams);
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

function telemetryArtifactPath(ctx: Context, response: ServerResponse, id: string | null): string | null {
  const artifactPath = id === null
    ? undefined
    : ctx.localGraphFiles.get(id)?.artifactPath ?? ctx.inspectionSnapshots.resolveArtifact(id)?.path;
  if (artifactPath === undefined) {
    sendJson(response, 404, { error: "unknown graph id" });
    return null;
  }
  return artifactPath;
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
