/** HTTP handlers and coordination for immutable server-side graph projections and symbol indexes. */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  compareBinaryStrings,
  GRAPH_PROJECTION_VERSION,
  type GraphProjectionRequestV1,
} from "@meridian/core";
import { sendJson, sendJsonFile } from "./http-response";
import { requestCancellation, throwIfAborted } from "./web-cancellation";
import { WebError } from "./web-error";
import type {
  WebGraphDescriptor,
  WebGraphRegistrationHandle,
} from "./web-graph-store";
import type { WebGraphProjectCacheHandle } from "./web-graph-project-cache";
import { readJsonBody } from "./web-request";
import type { Context } from "./web-server";
import {
  MAX_GRAPH_PROJECT_ROOTS,
  MAX_GRAPH_PROJECT_ROOT_BYTES,
  MAX_GRAPH_PROJECT_NODE_ID_BYTES,
  MAX_GRAPH_PROJECT_MERGED_ROOTS,
  MAX_GRAPH_PROJECT_MERGE_INPUTS,
  MAX_GRAPH_PROJECT_OUTPUT_BYTES,
  assertGraphProjectMergeInputBudget,
  isBoundedGraphProjectionRequest,
  type GraphProjectWorkerArtifactInput,
  type GraphProjectWorkerRequest,
} from "./web-graph-project-worker-job";
import {
  parsePrPartialSourceTopology,
  selectPrPartialTopology,
  type PrPartialSourceTopologyV1,
  type PrPartialTopologySelection,
} from "./web-pr-partial-topology";

export const GRAPH_PROJECTION_CACHE_HEADER = "x-meridian-graph-projection-cache";
export const GRAPH_PROJECTION_KEY_HEADER = "x-meridian-graph-projection-key";
export const GRAPH_PROJECTION_READY_HEADER = "x-meridian-graph-projection-ready";

const PROJECTION_CACHE_KEY = /^[a-f0-9]{64}$/;
// One changed-file warm per revision (HEAD + comparison) may wait or run. Any critical projection
// preempts unrelated speculation before entering the shared analysis FIFO, so background lookahead
// is bounded and cannot reserve the queue ahead of a user action.
const MAX_SPECULATIVE_PROJECTION_JOBS = 2;
// Includes the active child. Unlike equal-key coordinator waiters, every queued entry owns a
// distinct stage and graph pins, so this bound is part of the background lane's memory contract.
const MAX_SERIAL_GRAPH_WORKERS = 8;
const speculativeProjectionJobs = new WeakMap<Context, Map<string, SpeculativeProjectionJob>>();
// Symbol extraction is renderer-initiated background work too, but unlike a warm projection its
// HTTP waiter remains attached until the compact index is ready. Track every waiter (not only the
// singleflight producer) so an interactive projection can abandon the shared job even when two
// stale browsers happened to join it.
const speculativeSymbolWaiters = new WeakMap<Context, Map<string, Set<AbortController>>>();
// The analysis coordinator bounds all repository workers, but speculative partial-slice and source
// index work needs a stricter envelope. Serialize those disposable workers across both feature lanes
// so lookahead and indexing cannot multiply repository-sized RSS.
const speculativeWorkerStates = new WeakMap<Context, SpeculativeWorkerState>();
const INITIAL_PROJECTION_DEPTH = 1;
const INITIAL_PROJECTION_PREFETCH_DEPTH = 3;
// Initial PR artifacts are server-generated, immutable, and intentionally much smaller than an
// entire repository graph. Every dimension is checked before applying the stricter projection heap;
// all source scans, projections, and later partial extractions still use normal analysis admission.
const PROVISIONAL_GRAPH_ID = /^pr-partial(?:-base)?-[a-f0-9]{20}-(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_LIGHTWEIGHT_GRAPH_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_LIGHTWEIGHT_GRAPH_INPUT_NODES = 20_000;
const MAX_LIGHTWEIGHT_GRAPH_INPUT_EDGES = 100_000;
const LIGHTWEIGHT_GRAPH_WORKER_HEAP_MB = 1_024;
// Partial extraction is already capped at 20k exact-revision files. Keep its semantic child below
// the ordinary repository worker allowance while leaving enough headroom for declaration/flow
// extraction; the service wrapper may lower this further under a stricter startup policy.
const PARTIAL_GRAPH_ANALYSIS_WORKER_HEAP_MB = 4_096;
const INITIAL_PROJECTION_FALLBACK_WARNING =
  "Initial review context was not reserved; retry the partial PR review.";

export type GraphProjectionCacheDisposition = "hit" | "miss" | "coalesced";

interface ProjectionReadiness {
  readonly roots: number;
  readonly completeRoots: number;
  readonly loadedDepth: number;
}

interface EnsuredProjection {
  readonly cache: GraphProjectionCacheDisposition;
  readonly readiness: ProjectionReadiness | null;
  readonly handle: WebGraphProjectCacheHandle;
}

/** Projection cache entries are process-local. Keep their small readiness attestations beside the
 * cache instead of reparsing a potentially large JSON projection on the PR navigation path. */
const projectionReadiness = new WeakMap<Context, Map<string, ProjectionReadiness>>();
const MAX_PROJECTION_READINESS_ENTRIES = 256;

function rememberProjectionReadiness(ctx: Context, key: string, value: ProjectionReadiness): void {
  const readinessByKey = projectionReadiness.get(ctx) ?? new Map<string, ProjectionReadiness>();
  readinessByKey.delete(key);
  readinessByKey.set(key, value);
  while (readinessByKey.size > MAX_PROJECTION_READINESS_ENTRIES) {
    const oldest = readinessByKey.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    readinessByKey.delete(oldest);
  }
  projectionReadiness.set(ctx, readinessByKey);
}

interface ProjectionPins {
  graph: WebGraphRegistrationHandle;
  seed: WebGraphRegistrationHandle;
  release(): void;
}

interface PartialExpansionPlan {
  readonly targetName: string;
  readonly vcs: PrPartialSourceTopologyV1["target"]["vcs"];
  readonly changedSinceBaseRef: string | null;
  readonly selection: PrPartialTopologySelection;
  readonly extractionDepth: number;
}

interface SpeculativeProjectionJob {
  readonly controller: AbortController;
}

interface SpeculativeWorkerTask {
  readonly key: string;
  readonly run: () => Promise<unknown>;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  state: "queued" | "running" | "settled";
}

interface SpeculativeWorkerState {
  active: SpeculativeWorkerTask | null;
  readonly criticalKeys: Map<string, number>;
  foregroundDepth: number;
  readonly queue: SpeculativeWorkerTask[];
}

export interface InitialProjectionCacheEvidence {
  readonly version: 1;
  readonly depth: 1;
  readonly prefetchDepth: 3;
  readonly headKey: string | null;
  readonly comparisonKey: string | null;
  readonly ready: boolean;
}

export interface InitialProjectionCacheResult {
  readonly evidence: InitialProjectionCacheEvidence;
  readonly warning: string | null;
  /** Release the atomic publication pins after the handoff registry has acquired this pair. */
  releasePreparationPins(): void;
}

/**
 * Return the deliberately small child heap only for an immutable registration produced by the
 * provisional PR publisher. The graph id is server-owned provenance, while source and compact
 * descriptor bounds prevent an arbitrary registration from receiving the stricter child heap.
 */
export function boundedProvisionalGraphWorkerHeapMb(
  descriptor: WebGraphDescriptor,
  input: GraphProjectWorkerArtifactInput,
): number | null {
  if (
    descriptor.id !== input.graphId
    || descriptor.byteDigest !== input.sha256
    || !PROVISIONAL_GRAPH_ID.test(descriptor.id)
    || descriptor.source.kind !== "github"
    || input.bytes > MAX_LIGHTWEIGHT_GRAPH_INPUT_BYTES
    || descriptor.summary.nodeCount > MAX_LIGHTWEIGHT_GRAPH_INPUT_NODES
    || descriptor.summary.edgeCount > MAX_LIGHTWEIGHT_GRAPH_INPUT_EDGES
  ) {
    return null;
  }
  return LIGHTWEIGHT_GRAPH_WORKER_HEAP_MB;
}

export async function handleGraphProject(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  let pins: ProjectionPins | undefined;
  let cached: WebGraphProjectCacheHandle | undefined;
  try {
    const body = parseGraphProjectionRequest(await readJsonBody(request, cancellation.signal));
    pins = acquireProjectionPins(ctx, body);
    const key = projectionCacheKey(body, pins);
    const ensured = await ensureProjection(ctx, body, pins, key, cancellation.signal, "critical");
    cached = ensured.handle;
    await sendJsonFile(response, cached.path, {
      [GRAPH_PROJECTION_CACHE_HEADER]: ensured.cache,
      [GRAPH_PROJECTION_KEY_HEADER]: key,
      [GRAPH_PROJECTION_READY_HEADER]: "true",
    });
  } finally {
    cached?.release();
    pins?.release();
    cancellation.dispose();
  }
}

/**
 * Populate the exact direct-review boot pair. This runs after the outer PR
 * analysis singleflight has returned, so its two bounded revision lanes enter the coordinator as
 * ordinary top-level work rather than nesting an analysis phase inside another analysis phase.
 * Cross-request ownership belongs to the service's PR-review handoff registry; this projector owns
 * only cache computation and readiness proof. Non-cancellation failures are deliberately advisory:
 * callers retain the bounded provisional artifact and receive only a fixed, path-free warning.
 */
export async function prepareInitialGraphProjectionCache(
  ctx: Context,
  headGraphId: string,
  comparisonGraphId: string,
  signal: AbortSignal,
): Promise<InitialProjectionCacheResult> {
  throwIfAborted(signal);
  const requests: GraphProjectionRequestV1[] = [
    {
      version: GRAPH_PROJECTION_VERSION,
      graphId: headGraphId,
      roots: { kind: "changed-files", seedGraphId: headGraphId },
      requestedDepth: INITIAL_PROJECTION_DEPTH,
      prefetchDepth: INITIAL_PROJECTION_PREFETCH_DEPTH,
    },
    {
      version: GRAPH_PROJECTION_VERSION,
      graphId: comparisonGraphId,
      roots: { kind: "changed-files", seedGraphId: headGraphId },
      requestedDepth: INITIAL_PROJECTION_DEPTH,
      prefetchDepth: INITIAL_PROJECTION_PREFETCH_DEPTH,
    },
  ];
  let headKey: string | null = null;
  let comparisonKey: string | null = null;
  let work: Array<{
    request: GraphProjectionRequestV1;
    pins: ProjectionPins;
    key: string;
    rootPathChunks?: readonly (readonly string[])[];
  }> = [];
  try {
    throwIfAborted(signal);
    for (const projectionRequest of requests) {
      const pins = acquireProjectionPins(ctx, projectionRequest);
      const key = projectionCacheKey(projectionRequest, pins);
      const rootPathChunks = projectionRequest.roots.kind === "changed-files"
        && pins.graph.descriptor.summary.nodeCount > 0
        ? pins.graph.descriptor.projectionRootChunks
        : undefined;
      // Push immediately so a later pair-member acquisition failure cannot orphan this pin.
      work.push({
        request: projectionRequest,
        pins,
        key,
        ...(rootPathChunks === undefined ? {} : { rootPathChunks }),
      });
    }
    [headKey, comparisonKey] = work.map(({ key }) => key) as [string, string];
  } catch (error) {
    for (const item of work) item.pins.release();
    throwIfAborted(signal);
    return initialProjectionFailure(headKey, comparisonKey);
  }

  // The landing gate needs both immutable projections, so one failed member makes its sibling
  // useless for this navigation. Give the pair its own cancellation boundary: fail fast at the
  // worker layer, but drain every waiter before releasing the graph pins that back their inputs.
  const pairController = new AbortController();
  const cancelPair = () => pairController.abort(signal.reason);
  signal.addEventListener("abort", cancelPair, { once: true });
  if (signal.aborted) cancelPair();
  let outcomes: PromiseSettledResult<EnsuredProjection>[];
  const projectMember = async ({ request, pins, key, rootPathChunks }: (typeof work)[number]) => {
    try {
      return await ensureProjection(
        ctx,
        request,
        pins,
        key,
        pairController.signal,
        "critical",
        rootPathChunks,
      );
    } catch (error) {
      if (!pairController.signal.aborted) pairController.abort(error);
      throw error;
    }
  };
  try {
    if (ctx.analysisCoordinator.analysisCapacity === 1) {
      outcomes = [];
      for (const item of work) {
        try {
          outcomes.push({ status: "fulfilled", value: await projectMember(item) });
        } catch (reason) {
          outcomes.push({ status: "rejected", reason });
          break;
        }
      }
    } else {
      outcomes = await Promise.allSettled(work.map(projectMember));
    }
  } finally {
    signal.removeEventListener("abort", cancelPair);
    for (const item of work) item.pins.release();
  }
  const projectionHandles = outcomes.flatMap((outcome) => (
    outcome.status === "fulfilled" ? [outcome.value.handle] : []
  ));
  const releaseProjectionHandles = () => {
    for (const handle of projectionHandles) handle.release();
  };
  try {
    throwIfAborted(signal);
  } catch (error) {
    releaseProjectionHandles();
    throw error;
  }
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    releaseProjectionHandles();
    return initialProjectionFailure(headKey, comparisonKey);
  }
  const readiness = outcomes.flatMap((outcome) => (
    outcome.status === "fulfilled" && outcome.value.readiness !== null
      ? [outcome.value.readiness]
      : []
  ));
  if (
    readiness.length !== requests.length
    || readiness.some((entry) => (
      entry.loadedDepth < INITIAL_PROJECTION_DEPTH
      || entry.completeRoots !== entry.roots
    ))
  ) {
    releaseProjectionHandles();
    return initialProjectionFailure(headKey, comparisonKey);
  }

  return {
    evidence: {
      version: 1,
      depth: INITIAL_PROJECTION_DEPTH,
      prefetchDepth: INITIAL_PROJECTION_PREFETCH_DEPTH,
      headKey,
      comparisonKey,
      ready: true,
    },
    warning: null,
    releasePreparationPins: releaseProjectionHandles,
  };
}

/** Start speculative work only after the renderer reports an actionable canvas. The response is
 * deliberately immediate; the shutdown-owned job fills the same immutable cache a later critical
 * projection request consumes. */
export async function handleGraphProjectWarm(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  let pins: ProjectionPins | undefined;
  try {
    const body = parseGraphProjectionRequest(await readJsonBody(request, cancellation.signal));
    // Acquire before accepting and transfer these exact pins to the service-owned waiter. Releasing
    // and reacquiring here would leave a retention race in which a valid 202 silently warms nothing.
    pins = acquireProjectionPins(ctx, body);
    const key = projectionCacheKey(body, pins);
    const cached = ctx.graphProjectCache.acquire(key);
    if (cached !== undefined) {
      cached.release();
      sendJson(response, 200, {
        version: 1,
        key,
        accepted: false,
        completed: true,
        cache: "hit",
      });
      return;
    }
    const scheduled = scheduleSpeculativeProjection(ctx, body, pins, key);
    if (scheduled === "full") {
      sendJson(response, 503, {
        version: 1,
        key,
        accepted: false,
        completed: false,
        cache: "miss",
        error: "speculative graph projection capacity is full; try again shortly",
      });
      return;
    }
    if (scheduled === "started") pins = undefined;
    sendJson(response, 202, {
      version: 1,
      key,
      accepted: scheduled === "started",
      completed: false,
      cache: scheduled === "started" ? "miss" : "coalesced",
    });
  } finally {
    pins?.release();
    cancellation.dispose();
  }
}

/** Observe only whether an opaque key returned by the bounded warm request has become resident.
 * The key cannot name a file and this route never starts work; `completed:false` is intentionally
 * agnostic between still-running, failed, expired, and evicted work. */
export function handleGraphProjectWarmStatus(
  ctx: Context,
  response: ServerResponse,
  key: string | null,
): void {
  if (key === null || !PROJECTION_CACHE_KEY.test(key)) {
    throw new WebError(400, "graph projection warm status requires a valid key");
  }
  const cached = ctx.graphProjectCache.acquire(key);
  if (cached === undefined) {
    sendJson(response, 202, { version: 1, key, completed: false });
    return;
  }
  cached.release();
  sendJson(response, 200, { version: 1, key, completed: true });
}

export async function handleGraphSymbols(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
  id: string | null,
): Promise<void> {
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  const graph = id ? ctx.graphStore.acquire(id) : undefined;
  let cached: ReturnType<Context["graphProjectCache"]["acquire"]>;
  try {
    if (graph === undefined) throw new WebError(404, "unknown graph id");
    const key = symbolCacheKey(graph);
    const background = registerSpeculativeSymbolWaiter(ctx, key, cancellation.signal);
    try {
      await ensureSymbols(ctx, id as string, graph, key, background.signal);
    } finally {
      background.dispose();
    }
    cached = ctx.graphProjectCache.acquire(key);
    if (cached === undefined) throw new Error("published graph symbol index is unavailable");
    await sendJsonFile(response, cached.path);
  } finally {
    cached?.release();
    graph?.release();
    cancellation.dispose();
  }
}

export function parseGraphProjectionRequest(body: unknown): GraphProjectionRequestV1 {
  if (!isBoundedGraphProjectionRequest(body)) {
    throw new WebError(
      400,
      `graph projection must be version ${GRAPH_PROJECTION_VERSION}, use bounded canonical roots, and request depth 0..6 with at most three prefetched levels`,
    );
  }
  if (
    (body.roots.kind === "files" && body.roots.fileIds.length > MAX_GRAPH_PROJECT_ROOTS)
    || (body.roots.kind === "file-paths" && body.roots.paths.length > MAX_GRAPH_PROJECT_ROOTS)
  ) {
    throw new WebError(400, "graph projection contains too many file roots");
  }
  return {
    ...body,
    roots: body.roots.kind === "files"
      ? { kind: "files", fileIds: [...body.roots.fileIds].sort(compareBinaryStrings) }
      : body.roots.kind === "file-paths"
        ? { kind: "file-paths", paths: [...body.roots.paths].sort(compareBinaryStrings) }
        : { kind: "changed-files", seedGraphId: body.roots.seedGraphId },
  };
}

async function ensureProjection(
  ctx: Context,
  request: GraphProjectionRequestV1,
  pins: ProjectionPins,
  key: string,
  signal: AbortSignal,
  priority: "critical" | "speculative" = "critical",
  rootPathChunks?: readonly (readonly string[])[],
): Promise<EnsuredProjection> {
  const resolvedRootPathChunks = rootPathChunks
    ?? (request.roots.kind === "changed-files" && pins.graph.descriptor.summary.nodeCount > 0
      ? pins.graph.descriptor.projectionRootChunks
      : undefined);
  let sourceIndex: ProvisionalSourceIndexHandles | null = null;
  // The landing depth-one pair is already a self-contained partial artifact. Every deeper,
  // disconnected, or search-driven request resolves against the exact-revision source topology;
  // no canonical/full graph is started as a fallback.
  if (requiresPartialSourceExpansion(request, pins.graph) && !projectionIsResident(ctx, key)) {
    sourceIndex = priority === "critical"
      ? await ensureProvisionalSourceIndex(ctx, request.graphId, pins.graph, signal, key)
      : await ensureProvisionalSourceIndexWork(
          ctx,
          request.graphId,
          pins.graph,
          symbolCacheKey(pins.graph),
          signal,
        );
  }
  try {
    if (priority === "speculative") {
      return await ensureProjectionWork(
        ctx,
        request,
        pins,
        key,
        signal,
        priority,
        sourceIndex,
        resolvedRootPathChunks,
      );
    }
    // User-visible graph admission owns the shared worker pool even when its exact projection is
    // already cached: stale symbol parsing can otherwise consume several GiB while the fresh page
    // streams and lays out its depth-one scene. An equal-key warm is retained and safely joined.
    const releaseCritical = beginCriticalGraphWork(ctx, key);
    try {
      return await ensureProjectionWork(
        ctx,
        request,
        pins,
        key,
        signal,
        priority,
        sourceIndex,
        resolvedRootPathChunks,
      );
    } finally {
      releaseCritical();
    }
  } finally {
    sourceIndex?.symbols.release();
    sourceIndex?.topology.release();
  }
}

async function ensureProjectionWork(
  ctx: Context,
  request: GraphProjectionRequestV1,
  pins: ProjectionPins,
  key: string,
  signal: AbortSignal,
  priority: "critical" | "speculative",
  sourceIndex: ProvisionalSourceIndexHandles | null,
  rootPathChunks?: readonly (readonly string[])[],
): Promise<EnsuredProjection> {
  const hit = ctx.graphProjectCache.acquire(key);
  if (hit !== undefined) {
    return { cache: "hit", readiness: projectionReadiness.get(ctx)?.get(key) ?? null, handle: hit };
  }
  let ownedJob = false;
  const result = await ctx.analysisCoordinator.run<{
    state: "produced" | "raced";
    readiness: ProjectionReadiness | null;
    publicationPin: ProjectionPublicationPin;
  }>(
    `graph-project:${key}`,
    async ({ runAnalysis, signal: jobSignal }) => {
      // `AnalysisCoordinator.run` invokes only the first waiter's work closure. Every equal-key
      // waiter receives its result, so this closure-local bit distinguishes producer from joiner
      // without exposing coordinator internals or weakening its last-waiter cancellation contract.
      ownedJob = true;
      const raced = ctx.graphProjectCache.acquire(key);
      if (raced !== undefined) {
        return {
          state: "raced",
          readiness: projectionReadiness.get(ctx)?.get(key) ?? null,
          publicationPin: projectionPublicationPin(raced),
        };
      }
      const expansion = sourceIndex === null
        ? null
        : partialExpansionPlan(sourceIndex.topology, request, pins.graph);
      const stage = ctx.graphProjectCache.createStage();
      try {
        const directWorkerRequest: GraphProjectWorkerRequest = {
          type: "project",
          id: workerId(key),
          graph: artifactInput(request.graphId, pins.graph),
          seedGraph: request.roots.kind === "changed-files"
            ? artifactInput(request.roots.seedGraphId, pins.seed)
            : null,
          generation: pins.graph.descriptor.byteDigest,
          projection: request,
          projectionOutputPath: stage.outputPath,
          projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
          symbolOutputPath: null,
          symbolSourceRoot: null,
          topologyOutputPath: null,
        };
        const lightweightHeapMb = expansion === null
          ? boundedGraphProjectHeapMb(
              directWorkerRequest,
              pins.graph,
              directWorkerRequest.seedGraph === null ? null : pins.seed,
            )
          : null;
        const runWorker = expansion === null
          ? rootPathChunks === undefined
            ? (workerSignal: AbortSignal) => ctx.graphProject(directWorkerRequest, {
                signal: workerSignal,
                ...(lightweightHeapMb === null ? {} : { workerHeapMb: lightweightHeapMb }),
              })
            : (workerSignal: AbortSignal) => projectChangedFileRootChunks(
                ctx,
                directWorkerRequest.graph,
                directWorkerRequest.generation,
                request,
                key,
                rootPathChunks,
                stage.directory,
                stage.outputPath,
                workerSignal,
                lightweightHeapMb,
              )
          : (workerSignal: AbortSignal) => extractAndProjectPartialGraph(
              ctx,
              request,
              pins,
              key,
              expansion,
              stage.directory,
              stage.outputPath,
              workerSignal,
            );
        // Background work and every 4 GiB partial extractor wait at the stricter serial fence
        // *before* asking the global coordinator for a worker slot. Otherwise concurrent HEAD/base
        // expansion or a queued warm could multiply peak RSS or reserve analysis capacity ahead of
        // a fresh PR review. Every child still enters ordinary service-wide admission.
        const result = priority === "speculative" || expansion !== null
          ? await runSpeculativeGraphWorker(
              ctx,
              key,
              jobSignal,
              () => runAnalysis(runWorker),
            )
          : await runAnalysis(runWorker);
        if (result.projection === null) throw new Error("graph projection worker returned no projection");
        const publicationPin = projectionPublicationPin(
          ctx.graphProjectCache.publishAndAcquire(key, stage, result.projection),
        );
        const readiness = {
          roots: result.projection.roots,
          completeRoots: result.projection.completeRoots,
          loadedDepth: result.projection.loadedDepth,
        } satisfies ProjectionReadiness;
        rememberProjectionReadiness(ctx, key, readiness);
        if (jobSignal.aborted) {
          publicationPin.release();
          throw jobSignal.reason;
        }
        return {
          state: "produced" as const,
          readiness,
          publicationPin,
        };
      } finally {
        ctx.graphProjectCache.discardStage(stage);
      }
    },
    { signal },
  );
  const retained = ctx.graphProjectCache.acquire(key);
  result.publicationPin.release();
  if (retained === undefined) {
    throw new Error("published graph projection is unavailable");
  }
  return {
    cache: !ownedJob || result.state === "raced" ? "coalesced" : "miss",
    readiness: result.readiness,
    handle: retained,
  };
}

interface ProjectionPublicationPin {
  release(): void;
}

/** Keep a newly published result pinned until at least one resolved waiter acquires its own handle.
 * The timer is only a last-waiter-cancel safety net; ordinary callers release synchronously. */
function projectionPublicationPin(handle: WebGraphProjectCacheHandle): ProjectionPublicationPin {
  let released = false;
  const timer = setTimeout(release, 30_000);
  timer.unref?.();
  function release(): void {
    if (released) return;
    released = true;
    clearTimeout(timer);
    handle.release();
  }
  return { release };
}

function requiresPartialSourceExpansion(
  request: GraphProjectionRequestV1,
  graph: WebGraphRegistrationHandle,
): boolean {
  // A proven empty provisional side has no undiscovered adjacency. Changed-file depth expansion is
  // therefore complete at every horizon and must not require a language detector/source child in
  // an exact materialized empty root (all-additions, all-deletions, or docs-only PRs).
  if (
    request.roots.kind === "changed-files"
    && graph.descriptor.summary.nodeCount === 0
    && graph.descriptor.summary.edgeCount === 0
  ) return false;
  return PROVISIONAL_GRAPH_ID.test(graph.descriptor.id)
    && graph.descriptor.source.kind === "github"
    && (request.roots.kind !== "changed-files" || request.requestedDepth > INITIAL_PROJECTION_DEPTH);
}

function projectionIsResident(ctx: Context, key: string): boolean {
  const handle = ctx.graphProjectCache.acquire(key);
  if (handle === undefined) return false;
  handle.release();
  return true;
}

function partialExpansionPlan(
  topologyHandle: WebGraphProjectCacheHandle,
  request: GraphProjectionRequestV1,
  graph: WebGraphRegistrationHandle,
): PartialExpansionPlan {
  const topology = readPartialSourceTopology(topologyHandle, {
    graphId: request.graphId,
    generation: graph.descriptor.byteDigest,
  });
  // One bounded lookahead ring keeps the next frontier represented as ghosts. Prefetch remains the
  // caller's upper bound; a requested depth of zero still extracts one hop so a searched node can
  // satisfy the canvas's node-plus-neighbours readiness contract.
  const extractionDepth = Math.max(
    1,
    Math.min(request.prefetchDepth, request.requestedDepth + 1),
  );
  return {
    targetName: topology.target.name,
    vcs: topology.target.vcs,
    changedSinceBaseRef: topology.changedSinceBaseRef,
    selection: selectPrPartialTopology(topology, request.roots, extractionDepth),
    extractionDepth,
  };
}

function readPartialSourceTopology(
  handle: WebGraphProjectCacheHandle,
  expected: { graphId: string; generation: string },
): PrPartialSourceTopologyV1 {
  const before = lstatSync(handle.path);
  if (!before.isFile() || before.size !== handle.bytes) {
    throw new TypeError("partial graph source topology changed");
  }
  const bytes = readFileSync(handle.path);
  const after = lstatSync(handle.path);
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.ctimeMs !== before.ctimeMs
    || createHash("sha256").update(bytes).digest("hex") !== handle.sha256
  ) {
    throw new TypeError("partial graph source topology failed immutable verification");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("partial graph source topology is not valid JSON");
  }
  return parsePrPartialSourceTopology(parsed, expected);
}

async function extractAndProjectPartialGraph(
  ctx: Context,
  request: GraphProjectionRequestV1,
  pins: ProjectionPins,
  key: string,
  expansion: PartialExpansionPlan,
  stageDirectory: string,
  projectionOutputPath: string,
  signal: AbortSignal,
) {
  const artifactOutputPath = join(stageDirectory, "partial-artifact.json");
  try {
    const selectedHint = expansion.selection.selectedFiles[0];
    const analyzed = await ctx.repositoryAnalysis(
      {
        absoluteRoot: pins.graph.descriptor.sourceRoot,
        cwd: pins.graph.descriptor.sourceRoot,
        targetName: expansion.targetName,
        ...(expansion.vcs === undefined
          ? {}
          : { vcs: expansion.vcs }),
        ...(expansion.changedSinceBaseRef === null
          ? {}
          : { changedSince: expansion.changedSinceBaseRef }),
        ...(selectedHint === undefined ? {} : { hintedFiles: [selectedHint] }),
        allowEmpty: expansion.selection.selectedFiles.length === 0,
        initialGraph: {
          depth: expansion.extractionDepth,
          seedFiles: expansion.selection.seeds,
          selectedFiles: expansion.selection.selectedFiles,
          extractionFiles: expansion.selection.extractionFiles,
          frontierFiles: expansion.selection.frontierFiles,
          lineage: {
            graphId: request.graphId,
            generation: pins.graph.descriptor.byteDigest,
          },
        },
      },
      {
        artifactOutputPath,
        id: `partial-${workerId(key).slice("projection-".length)}`,
        reviewFingerprints: { mode: "all" },
        signal,
        workerHeapMb: PARTIAL_GRAPH_ANALYSIS_WORKER_HEAP_MB,
      },
    );
    throwIfAborted(signal);
    const workerRequest: GraphProjectWorkerRequest = {
      type: "project",
      id: workerId(key),
      graph: {
        graphId: request.graphId,
        path: analyzed.material.path,
        bytes: analyzed.byteLength,
        sha256: analyzed.material.byteDigest,
      },
      seedGraph: request.roots.kind === "changed-files"
        ? artifactInput(request.roots.seedGraphId, pins.seed)
        : null,
      // Independently serialized slices retain the immutable source revision's logical identity;
      // the child accepts it only after validating the server-stamped prPartialGraph lineage.
      generation: pins.graph.descriptor.byteDigest,
      projection: request,
      projectionOutputPath,
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
    };
    const rootPathChunks = request.roots.kind === "changed-files"
      ? graphProjectionRootChunks(expansion.selection.seeds)
      : undefined;
    if (rootPathChunks !== undefined) {
      return await projectChangedFileRootChunks(
        ctx,
        workerRequest.graph,
        workerRequest.generation,
        request,
        key,
        rootPathChunks,
        stageDirectory,
        projectionOutputPath,
        signal,
        LIGHTWEIGHT_GRAPH_WORKER_HEAP_MB,
      );
    }
    return await ctx.graphProject(workerRequest, {
      signal,
      // Projection reparses only the just-produced bounded slice and runs after extraction exits.
      workerHeapMb: LIGHTWEIGHT_GRAPH_WORKER_HEAP_MB,
    });
  } finally {
    // The cache accounts/publishes only result.json. Never retain the transient extraction beside
    // it after projection, even when publication loses an equal-key race.
    rmSync(artifactOutputPath, { force: true });
  }
}

/** Run each affected-file shard as an ordinary bounded project job, then union only their immutable
 * outputs in a separate rootless child. The original changed-files request remains the public cache
 * identity, so prepared navigation and later exact-key fetches observe one complete projection. */
async function projectChangedFileRootChunks(
  ctx: Context,
  graph: GraphProjectWorkerArtifactInput,
  generation: string,
  request: GraphProjectionRequestV1,
  key: string,
  rootPathChunks: readonly (readonly string[])[],
  stageDirectory: string,
  projectionOutputPath: string,
  signal: AbortSignal,
  workerHeapMb: number | null,
) {
  if (request.roots.kind !== "changed-files" || rootPathChunks.length < 2) {
    throw new TypeError("changed-file projection chunks are invalid");
  }
  const outputs: Array<{ path: string; bytes: number; sha256: string }> = [];
  let retainedOutputBytes = 0;
  try {
    for (const [index, paths] of rootPathChunks.entries()) {
      throwIfAborted(signal);
      const remainingOutputBytes = MAX_GRAPH_PROJECT_OUTPUT_BYTES - retainedOutputBytes;
      if (remainingOutputBytes <= 0) {
        throw new RangeError("graph projection merge inputs exhausted their aggregate byte limit");
      }
      const outputPath = join(stageDirectory, `roots-${String(index).padStart(3, "0")}.json`);
      const chunkRequest: GraphProjectWorkerRequest = {
        type: "project",
        id: `${workerId(key)}-c${index}`,
        graph,
        seedGraph: null,
        generation,
        projection: {
          ...request,
          roots: { kind: "file-paths", paths: [...paths] },
        },
        projectionOutputPath: outputPath,
        projectionOutputMaxBytes: remainingOutputBytes,
        symbolOutputPath: null,
        symbolSourceRoot: null,
        topologyOutputPath: null,
      };
      const result = await ctx.graphProject(chunkRequest, {
        signal,
        ...(workerHeapMb === null ? {} : { workerHeapMb }),
      });
      if (result.projection === null) throw new Error("graph projection chunk returned no projection");
      if (result.projection.bytes > remainingOutputBytes) {
        throw new RangeError("graph projection chunk exceeded its remaining aggregate byte limit");
      }
      outputs.push({
        path: result.projection.path,
        bytes: result.projection.bytes,
        sha256: result.projection.sha256,
      });
      retainedOutputBytes += result.projection.bytes;
      // Stop producing shards as soon as their retained aggregate crosses one bounded projection;
      // waiting until every root chunk finished could stage many individually valid 256 MiB files.
      if (outputs.length >= 2) assertGraphProjectMergeInputBudget(outputs);
    }
    const mergeRequest: GraphProjectWorkerRequest = {
      type: "merge",
      id: `${workerId(key)}-merge`,
      graph,
      seedGraph: null,
      generation,
      projection: request,
      projectionOutputPath,
      projectionOutputMaxBytes: MAX_GRAPH_PROJECT_OUTPUT_BYTES,
      symbolOutputPath: null,
      symbolSourceRoot: null,
      topologyOutputPath: null,
      projectionInputs: outputs,
    };
    assertGraphProjectMergeInputBudget(outputs);
    return await ctx.graphProject(mergeRequest, {
      signal,
      ...(workerHeapMb === null ? {} : { workerHeapMb }),
    });
  } finally {
    for (const output of outputs) rmSync(output.path, { force: true });
  }
}

function scheduleSpeculativeProjection(
  ctx: Context,
  request: GraphProjectionRequestV1,
  pins: ProjectionPins,
  key: string,
): "started" | "coalesced" | "full" {
  const jobs = speculativeJobsFor(ctx);
  if (jobs.has(key)) return "coalesced";
  if (jobs.size >= MAX_SPECULATIVE_PROJECTION_JOBS) return "full";

  const controller = new AbortController();
  const job: SpeculativeProjectionJob = { controller };
  const onShutdown = () => controller.abort(ctx.shutdownSignal.reason);
  ctx.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  if (ctx.shutdownSignal.aborted) onShutdown();
  jobs.set(key, job);

  void ensureProjection(ctx, request, pins, key, controller.signal, "speculative")
    .then(({ handle }) => handle.release())
    .catch(() => {})
    .finally(() => {
      ctx.shutdownSignal.removeEventListener("abort", onShutdown);
      if (jobs.get(key) === job) jobs.delete(key);
      pins.release();
    });
  return "started";
}

function preemptSpeculativeGraphWork(ctx: Context, retainedKeys: ReadonlySet<string>): void {
  const reason = new WebError(
    503,
    "background graph work yielded to an interactive projection; retry shortly",
  );
  const jobs = speculativeProjectionJobs.get(ctx);
  if (jobs !== undefined) {
    for (const [key, job] of jobs) {
      if (retainedKeys.has(key) || job.controller.signal.aborted) continue;
      job.controller.abort(reason);
    }
  }
  const symbolWaiters = speculativeSymbolWaiters.get(ctx);
  if (symbolWaiters === undefined) return;
  for (const [key, waiters] of symbolWaiters) {
    // An interactive expansion that depends on the exact in-flight source index promotes that
    // same immutable job. Its background HTTP waiter is still useful and must not become the
    // last-waiter cancellation that tears down/restarts the all-source scan.
    if (retainedKeys.has(key)) continue;
    for (const controller of waiters) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }
}

/**
 * Give a foreground PR analysis priority over this service's background graph work.
 *
 * The fence is context-local, aborts only live warm/symbol jobs, and leaves immutable completed
 * cache entries untouched. Calls may overlap (for example identical PR singleflight waiters); new
 * speculation remains parked until the last foreground owner releases it.
 */
export function beginForegroundGraphWork(ctx: Context): () => void {
  const state = speculativeWorkerStateFor(ctx);
  state.foregroundDepth += 1;
  preemptSpeculativeGraphWork(ctx, new Set());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.foregroundDepth -= 1;
    drainSpeculativeGraphWorkers(state);
  };
}

function beginCriticalGraphWork(ctx: Context, retained: string | readonly string[]): () => void {
  const state = speculativeWorkerStateFor(ctx);
  const retainedKeys = new Set(typeof retained === "string" ? [retained] : retained);
  for (const retainedKey of retainedKeys) {
    state.criticalKeys.set(retainedKey, (state.criticalKeys.get(retainedKey) ?? 0) + 1);
  }
  preemptSpeculativeGraphWork(ctx, retainedKeys);
  // The exact warm may already be parked behind a foreground fence with no unrelated active task
  // whose cancellation would otherwise trigger the drain. Promotion must therefore be explicit.
  drainSpeculativeGraphWorkers(state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const retainedKey of retainedKeys) {
      const remaining = (state.criticalKeys.get(retainedKey) ?? 1) - 1;
      if (remaining === 0) state.criticalKeys.delete(retainedKey);
      else state.criticalKeys.set(retainedKey, remaining);
    }
    drainSpeculativeGraphWorkers(state);
  };
}

function runSpeculativeGraphWorker<Result>(
  ctx: Context,
  key: string,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const state = speculativeWorkerStateFor(ctx);
  const retainedWorkers = state.queue.length + Number(state.active !== null);
  if (retainedWorkers >= MAX_SERIAL_GRAPH_WORKERS) {
    return Promise.reject(new WebError(
      503,
      "bounded graph worker capacity is full; try again shortly",
    ));
  }
  return new Promise<Result>((resolve, reject) => {
    let task!: SpeculativeWorkerTask;
    const onAbort = () => {
      if (task.state !== "queued") return;
      task.state = "settled";
      const index = state.queue.indexOf(task);
      if (index >= 0) state.queue.splice(index, 1);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
      drainSpeculativeGraphWorkers(state);
    };
    task = {
      key,
      run: () => run(signal),
      signal,
      onAbort,
      resolve: (value) => resolve(value as Result),
      reject,
      state: "queued",
    };
    signal.addEventListener("abort", onAbort, { once: true });
    state.queue.push(task);
    drainSpeculativeGraphWorkers(state);
    if (signal.aborted) onAbort();
  });
}

function speculativeWorkerStateFor(ctx: Context): SpeculativeWorkerState {
  const existing = speculativeWorkerStates.get(ctx);
  if (existing !== undefined) return existing;
  const created: SpeculativeWorkerState = {
    active: null,
    criticalKeys: new Map(),
    foregroundDepth: 0,
    queue: [],
  };
  speculativeWorkerStates.set(ctx, created);
  return created;
}

function drainSpeculativeGraphWorkers(state: SpeculativeWorkerState): void {
  if (state.active !== null) return;
  while (state.queue.length > 0) {
    const taskIndex = state.criticalKeys.size === 0
      ? (state.foregroundDepth === 0 ? 0 : -1)
      : state.queue.findIndex((candidate) => state.criticalKeys.has(candidate.key));
    if (taskIndex < 0) return;
    const [task] = state.queue.splice(taskIndex, 1);
    if (task === undefined) return;
    if (task.state !== "queued") continue;
    if (task.signal.aborted) {
      task.state = "settled";
      task.signal.removeEventListener("abort", task.onAbort);
      task.reject(task.signal.reason);
      continue;
    }
    task.state = "running";
    state.active = task;
    void Promise.resolve()
      .then(task.run)
      .then(
        (value) => settleSpeculativeGraphWorker(state, task, { value }),
        (error: unknown) => settleSpeculativeGraphWorker(state, task, { error }),
      );
    return;
  }
}

function settleSpeculativeGraphWorker(
  state: SpeculativeWorkerState,
  task: SpeculativeWorkerTask,
  outcome: { value: unknown } | { error: unknown },
): void {
  if (task.state !== "running" || state.active !== task) return;
  task.state = "settled";
  state.active = null;
  task.signal.removeEventListener("abort", task.onAbort);
  if (task.signal.aborted) task.reject(task.signal.reason);
  else if ("error" in outcome) task.reject(outcome.error);
  else task.resolve(outcome.value);
  drainSpeculativeGraphWorkers(state);
}

function registerSpeculativeSymbolWaiter(
  ctx: Context,
  key: string,
  requestSignal: AbortSignal,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const jobs = speculativeSymbolWaiters.get(ctx) ?? new Map<string, Set<AbortController>>();
  if (!speculativeSymbolWaiters.has(ctx)) speculativeSymbolWaiters.set(ctx, jobs);
  const waiters = jobs.get(key) ?? new Set<AbortController>();
  if (!jobs.has(key)) jobs.set(key, waiters);
  waiters.add(controller);
  const onRequestAbort = () => controller.abort(requestSignal.reason);
  requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  if (requestSignal.aborted) onRequestAbort();
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      requestSignal.removeEventListener("abort", onRequestAbort);
      waiters.delete(controller);
      if (waiters.size === 0) jobs.delete(key);
      if (jobs.size === 0) speculativeSymbolWaiters.delete(ctx);
    },
  };
}

function initialProjectionFailure(
  headKey: string | null,
  comparisonKey: string | null,
): InitialProjectionCacheResult {
  return {
    evidence: {
      version: 1,
      depth: INITIAL_PROJECTION_DEPTH,
      prefetchDepth: INITIAL_PROJECTION_PREFETCH_DEPTH,
      headKey,
      comparisonKey,
      ready: false,
    },
    warning: INITIAL_PROJECTION_FALLBACK_WARNING,
    releasePreparationPins: () => {},
  };
}

/** Sort/dedupe before packing so chunk identity is independent of Git diff order. Both item count
 * and decoded UTF-8 bytes retain the exact ordinary project-worker limits. A single admissible
 * chunk keeps the established changed-files request; only oversized sets take the merge path. */
export function graphProjectionRootChunks(
  rawPaths: readonly string[],
): readonly (readonly string[])[] | undefined {
  const paths = [...new Set(rawPaths)].sort(compareBinaryStrings);
  if (paths.length === 0) return undefined;
  if (paths.length > MAX_GRAPH_PROJECT_MERGED_ROOTS) {
    throw new RangeError("changed-file projection roots exceed the merged worker limit");
  }
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (pathBytes === 0 || pathBytes > MAX_GRAPH_PROJECT_NODE_ID_BYTES || path.includes("\0")) {
      throw new RangeError("changed-file projection root exceeds its worker byte limit");
    }
    if (
      chunk.length >= MAX_GRAPH_PROJECT_ROOTS
      || bytes + pathBytes > MAX_GRAPH_PROJECT_ROOT_BYTES
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += pathBytes;
  }
  chunks.push(chunk);
  if (chunks.length > MAX_GRAPH_PROJECT_MERGE_INPUTS) {
    throw new RangeError("changed-file projection root chunks exceed the merge input limit");
  }
  return chunks.length > 1 ? chunks : undefined;
}

function speculativeJobsFor(ctx: Context): Map<string, SpeculativeProjectionJob> {
  const existing = speculativeProjectionJobs.get(ctx);
  if (existing !== undefined) return existing;
  const created = new Map<string, SpeculativeProjectionJob>();
  speculativeProjectionJobs.set(ctx, created);
  return created;
}

export interface ProvisionalSourceIndexHandles {
  /** Renderer-safe compact symbol inventory for the exact provisional revision. */
  symbols: WebGraphProjectCacheHandle;
  /** Strict compact import/dynamic-import/exact-IPC topology used by incremental expansion. */
  topology: WebGraphProjectCacheHandle;
}

/**
 * Ensure and pin the one shared source scan for a provisional graph. Interactive expansion calls
 * this boundary before its projection coordinator; that promotes an equal-key background Cmd+P
 * scan instead of aborting and restarting it. Both handles must be released by the caller.
 */
export async function ensureProvisionalSourceIndex(
  ctx: Context,
  graphId: string,
  graph: WebGraphRegistrationHandle,
  signal: AbortSignal,
  retainedProjectionKey?: string,
): Promise<ProvisionalSourceIndexHandles> {
  if (retainedProjectionKey !== undefined && !PROJECTION_CACHE_KEY.test(retainedProjectionKey)) {
    throw new TypeError("retained projection key is invalid");
  }
  const key = symbolCacheKey(graph);
  const releaseCritical = beginCriticalGraphWork(
    ctx,
    retainedProjectionKey === undefined ? key : [key, retainedProjectionKey],
  );
  try {
    return await ensureProvisionalSourceIndexWork(ctx, graphId, graph, key, signal);
  } finally {
    releaseCritical();
  }
}

async function ensureProvisionalSourceIndexWork(
  ctx: Context,
  graphId: string,
  graph: WebGraphRegistrationHandle,
  key: string,
  signal: AbortSignal,
): Promise<ProvisionalSourceIndexHandles> {
  const input = artifactInput(graphId, graph);
  const workerHeapMb = boundedProvisionalGraphWorkerHeapMb(graph.descriptor, input);
  if (workerHeapMb === null) {
    throw new WebError(422, "source indexing requires a bounded provisional PR graph");
  }
  const topologyKey = sourceTopologyCacheKey(graph);
  const cached = acquireSourceIndexHandles(ctx, key, topologyKey);
  if (cached !== null) return cached;

  await ctx.analysisCoordinator.run<void>(
    `graph-source-index:${key}`,
    async ({ runAnalysis, signal: jobSignal }) => {
      const raced = acquireSourceIndexHandles(ctx, key, topologyKey);
      if (raced !== null) {
        raced.symbols.release();
        raced.topology.release();
        return;
      }
      const symbolStage = ctx.graphProjectCache.createStage();
      const topologyStage = ctx.graphProjectCache.createStage();
      try {
        const workerRequest: GraphProjectWorkerRequest = {
          type: "symbols",
          id: workerId(key),
          graph: input,
          seedGraph: null,
          generation: graph.descriptor.byteDigest,
          projection: null,
          projectionOutputPath: null,
          projectionOutputMaxBytes: null,
          symbolOutputPath: symbolStage.outputPath,
          symbolSourceRoot: graph.descriptor.sourceRoot,
          topologyOutputPath: topologyStage.outputPath,
        };
        const runWorker = (workerSignal: AbortSignal) => ctx.graphProject(workerRequest, {
          signal: workerSignal,
          workerHeapMb,
        });
        // This scan has a small child heap but still uses ordinary analysis admission. The serial
        // graph fence prevents it from overlapping partial extraction/projection; equal-key
        // interactive promotion lets a waiting expansion run the already-started scan to completion.
        const result = await runSpeculativeGraphWorker(
          ctx,
          key,
          jobSignal,
          () => runAnalysis(runWorker),
        );
        if (result.symbols === null || result.topology === null) {
          throw new Error("source index worker returned incomplete outputs");
        }
        ctx.graphProjectCache.publish(key, symbolStage, result.symbols);
        ctx.graphProjectCache.publish(topologyKey, topologyStage, result.topology);
      } finally {
        ctx.graphProjectCache.discardStage(symbolStage);
        ctx.graphProjectCache.discardStage(topologyStage);
      }
    },
    { signal },
  );
  throwIfAborted(signal);
  const completed = acquireSourceIndexHandles(ctx, key, topologyKey);
  if (completed === null) throw new Error("published provisional source index is unavailable");
  return completed;
}

function acquireSourceIndexHandles(
  ctx: Context,
  symbolKey: string,
  topologyKey: string,
): ProvisionalSourceIndexHandles | null {
  const symbols = ctx.graphProjectCache.acquire(symbolKey);
  const topology = ctx.graphProjectCache.acquire(topologyKey);
  if (symbols !== undefined && topology !== undefined) return { symbols, topology };
  symbols?.release();
  topology?.release();
  return null;
}

async function ensureSymbols(
  ctx: Context,
  graphId: string,
  graph: WebGraphRegistrationHandle,
  key: string,
  signal: AbortSignal,
): Promise<void> {
  if (boundedProvisionalGraphWorkerHeapMb(graph.descriptor, artifactInput(graphId, graph)) !== null) {
    const handles = await ensureProvisionalSourceIndexWork(ctx, graphId, graph, key, signal);
    handles.symbols.release();
    handles.topology.release();
    return;
  }
  const hit = ctx.graphProjectCache.acquire(key);
  if (hit !== undefined) {
    hit.release();
    return;
  }
  await ctx.analysisCoordinator.run<void>(
    `graph-symbols:${key}`,
    async ({ runAnalysis, signal: jobSignal }) => {
      const raced = ctx.graphProjectCache.acquire(key);
      if (raced !== undefined) {
        raced.release();
        return;
      }
      const stage = ctx.graphProjectCache.createStage();
      try {
        const workerRequest: GraphProjectWorkerRequest = {
          type: "symbols",
          id: workerId(key),
          graph: artifactInput(graphId, graph),
          seedGraph: null,
          generation: graph.descriptor.byteDigest,
          projection: null,
          projectionOutputPath: null,
          projectionOutputMaxBytes: null,
          symbolOutputPath: stage.outputPath,
          symbolSourceRoot: null,
          topologyOutputPath: null,
        };
        const lightweightHeapMb = boundedGraphProjectHeapMb(workerRequest, graph, null);
        const runWorker = (workerSignal: AbortSignal) => ctx.graphProject(workerRequest, {
          signal: workerSignal,
          ...(lightweightHeapMb === null ? {} : { workerHeapMb: lightweightHeapMb }),
        });
        // Like projection warms, canonical symbol indexing queues at the shared speculative fence
        // before it can consume process-wide analysis capacity. Provisional graphs returned above:
        // their source-backed index always uses ordinary admission despite its bounded child heap.
        const result = await runSpeculativeGraphWorker(
          ctx,
          key,
          jobSignal,
          () => lightweightHeapMb === null
            ? runAnalysis(runWorker)
            : runWorker(jobSignal),
        );
        if (result.symbols === null) throw new Error("graph projection worker returned no symbol index");
        ctx.graphProjectCache.publish(key, stage, result.symbols);
      } finally {
        ctx.graphProjectCache.discardStage(stage);
      }
    },
    { signal },
  );
}

function acquireProjectionPins(ctx: Context, request: GraphProjectionRequestV1): ProjectionPins {
  const graph = ctx.graphStore.acquire(request.graphId);
  if (graph === undefined) throw new WebError(404, "unknown graph id");
  const seedId = request.roots.kind === "changed-files" ? request.roots.seedGraphId : request.graphId;
  const seed = seedId === request.graphId ? graph : ctx.graphStore.acquire(seedId);
  if (seed === undefined) {
    graph.release();
    throw new WebError(404, "unknown projection seed graph id");
  }
  let released = false;
  return {
    graph,
    seed,
    release() {
      if (released) return;
      released = true;
      if (seed !== graph) seed.release();
      graph.release();
    },
  };
}

function artifactInput(graphId: string, graph: WebGraphRegistrationHandle): GraphProjectWorkerArtifactInput {
  const file = lstatSync(graph.artifactPath);
  if (!file.isFile() || file.size <= 0) throw new Error("graph artifact is unavailable");
  return {
    graphId,
    path: graph.artifactPath,
    bytes: file.size,
    sha256: graph.descriptor.byteDigest,
  };
}

function boundedGraphProjectHeapMb(
  request: GraphProjectWorkerRequest,
  graph: WebGraphRegistrationHandle,
  seed: WebGraphRegistrationHandle | null,
): number | null {
  const heap = boundedProvisionalGraphWorkerHeapMb(graph.descriptor, request.graph);
  if (heap === null) return null;
  if (request.seedGraph === null) return seed === null ? heap : null;
  if (seed === null) return null;
  return boundedProvisionalGraphWorkerHeapMb(seed.descriptor, request.seedGraph) === heap
    ? heap
    : null;
}

function projectionCacheKey(request: GraphProjectionRequestV1, pins: ProjectionPins): string {
  return createHash("sha256").update(JSON.stringify({
    version: request.version,
    graphId: request.graphId,
    graphDigest: pins.graph.descriptor.byteDigest,
    seedDigest: pins.seed.descriptor.byteDigest,
    roots: request.roots,
    requestedDepth: request.requestedDepth,
    prefetchDepth: request.prefetchDepth,
  })).digest("hex");
}

function symbolCacheKey(graph: WebGraphRegistrationHandle): string {
  // The compact payload embeds graphId. Two registrations may intentionally share artifact bytes,
  // so digest alone would serve an otherwise-correct index carrying the wrong registered id.
  return `symbols:${graph.descriptor.id}:${graph.descriptor.byteDigest}`;
}

function sourceTopologyCacheKey(graph: WebGraphRegistrationHandle): string {
  return `source-topology:${graph.descriptor.id}:${graph.descriptor.byteDigest}`;
}

function workerId(key: string): string {
  return `projection-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}
