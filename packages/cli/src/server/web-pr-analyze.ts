/**
 * POST /api/pr/analyze — resolve a PR's immutable HEAD/base pair, prepare its review graph contract,
 * and stream real miss stages to the browser as NDJSON.
 *
 * The production progressive path publishes bounded, disk-backed HEAD + exact-merge-base seeds and
 * terminates once their depth-one projections are actionable. Later depth/search/ghost requests grow
 * that same exact-revision pair with independent partial slices; they never trigger a complete graph.
 * `progressive:false` retains only the explicit complete-artifact benchmark control path. Both paths
 * need full commit/tree history to prove `merge-base`, while a blobless clone keeps repository transfer
 * smaller and immutable revision coordinates prevent reuse after a force-push or base update.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PrReviewProgressRevisionId,
  SyntheticScenarioDescriptor,
} from "@meridian/core";
import { readJsonBody } from "./web-request";
import {
  parsePrAnalyzeRequest,
  parsePrPrepareRequest,
  PR_FULL_BASELINE_BENCHMARK_CAPABILITY,
  PR_FULL_BASELINE_BENCHMARK_HEADER,
} from "./web-pr-request";
import type { PrAnalyzeRequest } from "./web-pr-request";
import { githubTokenFor } from "./web-auth";
import { WebError } from "./web-error";
import {
  isOperationCancelled,
  requestCancellation,
  responseCanWrite,
  throwIfAborted,
} from "./web-cancellation";
import type { ArtifactSource } from "./web-source";
import type { Context } from "./web-server";
import {
  cachedPrGraph,
  ProvisionalPrGraphAccepted,
  resolvePrRevisionCoordinates,
  type PrManifestReady,
  type ProvisionalPrGraphPair,
} from "./web-pr-cache";
import type {
  VerifiedFileArtifactMaterial,
  WebGraphPublicationReceipt,
  WebGraphRegistrationHandle,
  WebGraphRegistration,
} from "./web-graph-store";
import type {
  RepositoryAnalysisFacts,
  RepositoryAnalysisProgress,
} from "./repository-analysis-child";
import { syntheticSourceFingerprintForFiles } from "./synthetic-fingerprint";
import { streamedOverloadLine } from "./web-overload";
import type { RepositoryWorkspaceLease } from "./web-repository-mirror";
import { isWebServiceShutdown, WEB_SERVICE_SHUTDOWN_MESSAGE } from "./web-service-shutdown";
import {
  beginForegroundGraphWork,
  graphProjectionRootChunks,
  prepareInitialGraphProjectionCache,
  type InitialProjectionCacheEvidence,
} from "./web-graph-project";

type GitHubSource = Extract<ArtifactSource, { kind: "github" }>;
type PrAnalysisStage =
  | "clone"
  | "checkout"
  | "extract"
  | "extract-head"
  | "extract-merge-base"
  | "reuse-head"
  | "reuse-merge-base";

interface PrAnalysisProgressLine {
  stage: "extract-head" | "extract-merge-base";
  progress: RepositoryAnalysisProgress;
}

interface PrAnalysisLaneCompleteLine {
  stage: "lane-complete";
  lane: PrReviewProgressRevisionId;
}

interface PrAnalysisReadyLine extends Omit<PrAnalysisDone, "stage"> {
  stage: "ready";
  /** Stable identity of this exact provisional HEAD/merge-base generation. */
  pairId: string;
  completeness: "provisional";
  initialProjectionCache: InitialProjectionCacheEvidence;
}

type PrAnalysisManifestReadyLine = Omit<PrManifestReady, "version"> & {
  stage: "manifest-ready";
};

type PrAnalysisProgress =
  | PrAnalysisStage
  | PrAnalysisProgressLine
  | PrAnalysisLaneCompleteLine
  | PrAnalysisManifestReadyLine
  | PrAnalysisReadyLine;

/** Preserve independent HEAD and merge-base lanes for callers joining an in-flight singleflight. */
function prProgressReplayKey(progress: PrAnalysisProgress): string | undefined {
  if (typeof progress !== "string" && progress.stage === "manifest-ready") return "manifest";
  if (typeof progress !== "string" && progress.stage === "lane-complete") {
    return progress.lane === "head" ? "head" : "merge-base";
  }
  if (typeof progress !== "string" && progress.stage === "ready") return "provisional";
  const stage = typeof progress === "string" ? progress : progress.stage;
  if (stage === "extract-head" || stage === "reuse-head") return "head";
  if (stage === "extract-merge-base" || stage === "reuse-merge-base") return "merge-base";
  return undefined;
}

interface PrAnalysisDone {
  stage: "done";
  graphId: string;
  comparisonGraphId: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  counts: { nodes: number; edges: number };
  changedFiles: RepositoryAnalysisFacts["changedFiles"];
  warnings: string[];
  cache: "hit" | "miss";
  /** Present only when the bounded pair is the authoritative progressive terminal. */
  pairId?: string;
  completeness?: "provisional";
  initialProjectionCache?: InitialProjectionCacheEvidence;
}

export async function handlePrAnalyze(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  let sessionRegistration: ReturnType<Context["graphStore"]["acquire"]> = undefined;
  try {
    const body = parsePrAnalyzeRequest(await readJsonBody(request, cancellation.signal));
    if (
      body.progressive === false
      && (
        !ctx.benchmarkPrFullBaseline
        || request.headers[PR_FULL_BASELINE_BENCHMARK_HEADER]
          !== PR_FULL_BASELINE_BENCHMARK_CAPABILITY
      )
    ) {
      // Reject before graph lookup, credentials, repository preparation, or analysis admission.
      // Production is partial-only; the complete path exists only as a controlled measurement.
      throw new WebError(403, "complete PR graph baselines require the loopback benchmark capability");
    }
    sessionRegistration = ctx.graphStore.acquire(body.id);
    const source = sessionRegistration?.descriptor.source;
    if (source?.kind !== "github") {
      sessionRegistration?.release();
      sessionRegistration = undefined;
      throw new WebError(404, "pull request analysis needs a GitHub-sourced session");
    }
    const token = githubTokenFor(ctx, request);
    beginNdjson(response);
    await streamAnalysis(ctx, response, source, token, body, cancellation.signal);
  } finally {
    sessionRegistration?.release();
    cancellation.dispose();
  }
}

/**
 * Landing-page sibling of `/api/pr/analyze`: the repository identity comes directly from the
 * selected PR, so opening a review never has to generate a throwaway base-branch graph first.
 *
 * The returned HEAD id is safe to boot immediately, but `rev=1` deliberately asks `/api/pr/analyze`
 * again after navigation. That cheap cache hit re-resolves both moving refs; if either moved, the
 * renderer receives and swaps to the newly prepared immutable pair instead of trusting this result.
 */
export async function handlePrPrepare(ctx: Context, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const cancellation = requestCancellation(request, response, ctx.shutdownSignal);
  try {
    const direct = parsePrPrepareRequest(await readJsonBody(request, cancellation.signal));
    const [owner, repo] = direct.repository.split("/") as [string, string];
    const source: GitHubSource = { kind: "github", owner, repo };
    const body: PrAnalyzeRequest = {
      id: "direct-pr-prepare",
      prNumber: direct.prNumber,
      baseRef: direct.baseRef,
      headRef: direct.headRef,
      ...(direct.headSha === undefined ? {} : { expectedHeadSha: direct.headSha }),
      progressive: true,
    };
    const token = githubTokenFor(ctx, request);
    beginNdjson(response);
    await streamAnalysis(
      ctx,
      response,
      source,
      token,
      body,
      cancellation.signal,
      (completed, initialProjectionCache) => directPreparationDone(
        completed,
        direct.prNumber,
        initialProjectionCache,
      ),
      true,
      true,
      (ready) => directPreparationReady(ready, direct.prNumber),
    );
  } finally {
    cancellation.dispose();
  }
}

/**
 * The streamed body. Every stage writes a line before the work it names starts, so the browser
 * sees "clone → checkout → extract" progress on a miss; a hit emits only `done`. Any failure
 * collapses to a single safe `error` line, and `/api/source` reads from the persistent checkout.
 */
async function streamAnalysis(
  ctx: Context,
  response: ServerResponse,
  source: GitHubSource,
  token: string | undefined,
  body: PrAnalyzeRequest,
  signal: AbortSignal,
  terminal: (
    completed: PrAnalysisDone,
    initialProjectionCache?: InitialProjectionCacheEvidence,
  ) => Record<string, unknown> = (completed) => ({ ...completed }),
  emitManifestReady = false,
  prepareInitialProjectionCache = false,
  readyTerminal: (ready: PrAnalysisReadyLine) => Record<string, unknown> = (ready) => ({ ...ready }),
): Promise<void> {
  let releaseTerminalReservation: (() => void) | null = null;
  try {
    const credentialKey = token ? createHash("sha256").update(token).digest("hex") : "anonymous";
    const jobKey = prAnalysisJobKey(source, body, credentialKey, ctx.refreshCache);
    const retainedReady = body.progressive === true && !ctx.refreshCache
      ? await reusableProvisionalPair(ctx, source, body, token, jobKey, signal)
      : null;
    if (retainedReady !== null) {
      requireExpectedHead(body, retainedReady.headSha);
      await writeLine(response, readyTerminal(retainedReady));
      throwIfAborted(signal);
      await writeLine(
        response,
        terminal(provisionalDoneLine(retainedReady), retainedReady.initialProjectionCache),
      );
      return;
    }
    // Stop stale lookahead/indexing before this request enters the coordinator. In particular, a
    // capacity-one service cannot rely on later phase admission to preempt an already running
    // speculative worker, because the foreground phase would otherwise wait behind that worker.
    const releaseForeground = beginForegroundGraphWork(ctx);
    let completed: PrAnalysisDone;
    try {
      completed = await ctx.analysisCoordinator.run<PrAnalysisDone, PrAnalysisProgress>(
        jobKey,
        async ({
          analysisCapacity,
          signal: jobSignal,
          report,
          runPreparation,
          runCoordination,
          runAnalysis,
        }) => {
          let acceptedReady: PrAnalysisReadyLine | null = null;
          let cached: Awaited<ReturnType<typeof cachedPrGraph>>;
          try {
            cached = await cachedPrGraph({
          cacheRoot: ctx.cacheRoot,
          repositories: ctx.repositories,
          source,
          body,
          cwd: ctx.cwd,
          token,
          refresh: ctx.refreshCache,
          typeScriptRevisionShardMode: ctx.typeScriptRevisionShardMode,
          experimentalPrRevisionCache: ctx.experimentalPrRevisionCache,
          signal: jobSignal,
          onStage: (stage) => report(stage, prProgressReplayKey(stage)),
          onRevisionComplete: (lane) => {
            const event: PrAnalysisProgress = { stage: "lane-complete", lane };
            report(event, prProgressReplayKey(event));
          },
          onExtractionProgress: (progress) => {
            const event: PrAnalysisProgress = {
              stage: progress.revision.kind === "head" ? "extract-head" : "extract-merge-base",
              progress,
            };
            report(event, prProgressReplayKey(event));
          },
          ...(emitManifestReady ? { onManifestReady: ({ version: _version, ...manifest }) => {
            const event: PrAnalysisProgress = { stage: "manifest-ready", ...manifest };
            report(event, prProgressReplayKey(event));
          } } : {}),
          ...(body.progressive === true ? { onProvisionalPair: async (pair: ProvisionalPrGraphPair) => {
            const ready = await publishProvisionalPair(ctx, source, body, pair, jobSignal);
            if (ready === null) return "continue" as const;
            acceptedReady = ready;
            rememberProvisionalPair(ctx, jobKey, ready);
            // Keep this exact job alive only through cleanup and its bounded terminal. Navigating
            // may close the landing waiter immediately; no complete extraction follows.
            retainPrCompletion(ctx, jobKey);
            report(ready, prProgressReplayKey(ready));
            return "accepted" as const;
          } } : {}),
          runPreparation,
          runCoordination,
          runAnalysis,
          analysisCapacity,
          repositoryAnalysis: ctx.repositoryAnalysis,
            });
          } catch (error) {
            if (!(error instanceof ProvisionalPrGraphAccepted) || acceptedReady === null) throw error;
            return provisionalDoneLine(acceptedReady);
          }
        let leasesHandedOff = false;
        const existingPins: WebGraphRegistrationHandle[] = [];
        try {
          throwIfAborted(jobSignal);
          // Publication belongs to the keyed job. Waiters share only this immutable terminal line,
          // never either single-owner source lease.
          const head = await prepareHeadPublication(
            ctx,
            cached.artifactFacts,
            source,
            cached.sourceDir,
            cached.sourceLease,
            body,
            cached.headSha,
            cached.mergeBaseSha,
            cached.artifactMaterial,
          );
          if (head.existingPin !== undefined) existingPins.push(head.existingPin);
          const comparison = prepareComparisonPublication(
            ctx,
            source,
            cached.comparisonSourceDir,
            cached.comparisonSourceLease,
            body,
            cached.mergeBaseSha,
            cached.comparisonMaterial,
          );
          if (comparison.existingPin !== undefined) existingPins.push(comparison.existingPin);
          throwIfAborted(jobSignal);
          // The store consumes both workspace leases and publishes HEAD + merge-base atomically.
          // Retention pressure may temporarily exceed its soft targets while live owners are
          // protected, but it cannot reject or split this coherent pair.
          leasesHandedOff = true;
          ctx.graphStore.publishBatch([head.registration, comparison.registration]);
          return doneLine(
            head.graphId,
            comparison.graphId,
            cached.headSha,
            cached.baseSha,
            cached.mergeBaseSha,
            cached.artifactFacts,
            [...cached.warnings, ...head.syntheticWarnings],
            cached.cache,
          );
        } finally {
          for (const pin of existingPins) pin.release();
          if (!leasesHandedOff) {
            cached.sourceLease.release();
            cached.comparisonSourceLease.release();
          }
        }
        },
        {
          signal,
          onProgress: (progress) => {
            if (typeof progress !== "string" && progress.stage === "ready") {
              requireExpectedHead(body, progress.headSha);
              // Every HTTP subscriber owns an independent foreground fence, including callers
              // joining an already-running singleflight. Release it before writing the actionable
              // terminal so incremental projection and symbol work can enter normal admission.
              releaseForeground();
            }
            return writeLine(response, (
              typeof progress === "string"
                ? { stage: progress }
                : progress.stage === "ready"
                  ? readyTerminal(progress)
                  : { ...progress }
            ));
          },
        },
      );
    } finally {
      releaseForeground();
    }
    // `expectedHeadSha` is a waiter-local picker proof. Validate every waiter against the immutable
    // terminal as well as against any replayed bounded pair.
    requireExpectedHead(body, completed.headSha);
    throwIfAborted(signal);
    let terminalCompleted = completed;
    let initialProjectionCache = completed.initialProjectionCache;
    if (prepareInitialProjectionCache && initialProjectionCache === undefined) {
      const prepared = await prepareInitialGraphProjectionCache(
        ctx,
        completed.graphId,
        completed.comparisonGraphId,
        signal,
      );
      initialProjectionCache = prepared.evidence;
      releaseTerminalReservation = prepared.releaseReservation;
      if (prepared.warning !== null) {
        terminalCompleted = {
          ...completed,
          warnings: [...completed.warnings, prepared.warning],
        };
      }
    }
    throwIfAborted(signal);
    await writeLine(response, terminal(terminalCompleted, initialProjectionCache));
    // A successfully delivered terminal leaves the bounded pair protected for the short landing
    // handoff. A newer picker action, timeout, request cancellation, or shutdown owns release.
    releaseTerminalReservation = null;
  } catch (error) {
    releaseTerminalReservation?.();
    releaseTerminalReservation = null;
    if (!isOperationCancelled(error) && responseCanWrite(response)) {
      await writeLine(
        response,
        streamedOverloadLine(error) ?? { stage: "error", message: safeMessage(error) },
      );
    }
  } finally {
    if (responseCanWrite(response)) response.end();
  }
}

const retainedPrCompletions = new WeakMap<Context, Map<string, Promise<void>>>();
const provisionalPairHandoffs = new WeakMap<Context, Map<string, {
  ready: PrAnalysisReadyLine;
}>>();
const PROVISIONAL_PAIR_HANDOFF_TTL_MS = 60_000;
const MAX_PROVISIONAL_PAIR_HANDOFFS = 32;

/** Keep the exact running singleflight alive only until its accepted bounded terminal settles. */
function retainPrCompletion(ctx: Context, jobKey: string): void {
  const retained = retainedPrCompletions.get(ctx) ?? new Map<string, Promise<void>>();
  if (!retainedPrCompletions.has(ctx)) retainedPrCompletions.set(ctx, retained);
  if (retained.has(jobKey)) return;
  // This is called synchronously from inside the matching job before its readiness event is
  // reported, so the factory is intentionally unreachable: run() attaches one service waiter.
  const completion = ctx.analysisCoordinator.run<PrAnalysisDone, PrAnalysisProgress>(
    jobKey,
    async () => {
      throw new Error("provisional completion owner lost its running analysis");
    },
  ).then(() => undefined, () => undefined).finally(() => {
    if (retained.get(jobKey) === completion) retained.delete(jobKey);
    if (retained.size === 0) retainedPrCompletions.delete(ctx);
  });
  retained.set(jobKey, completion);
}

function rememberProvisionalPair(
  ctx: Context,
  jobKey: string,
  ready: PrAnalysisReadyLine,
): void {
  const handoffs = provisionalPairHandoffs.get(ctx) ?? new Map();
  if (!provisionalPairHandoffs.has(ctx)) provisionalPairHandoffs.set(ctx, handoffs);
  handoffs.delete(jobKey);
  // This bounded map owns metadata only. GraphStore remains the resource authority: its handoff
  // TTL and retention policy own both registrations and their source leases. Keeping the immutable
  // result coordinates while those registrations still exist lets a delayed navigation reuse the
  // exact pair instead of re-extracting byte-different artifacts solely because `generatedAt`
  // changed. A moving ref or an evicted registration invalidates the candidate below.
  handoffs.set(jobKey, { ready });
  while (handoffs.size > MAX_PROVISIONAL_PAIR_HANDOFFS) {
    const oldest = handoffs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    handoffs.delete(oldest);
  }
}

/**
 * The landing navigation revalidates its exact PR pair. Reuse the bounded immutable server result
 * only after moving refs and both registrations are proven current; otherwise start a fresh bounded
 * preparation. This metadata owns no graph pin, worker, or foreground admission.
 */
async function reusableProvisionalPair(
  ctx: Context,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  token: string | undefined,
  jobKey: string,
  signal: AbortSignal,
): Promise<PrAnalysisReadyLine | null> {
  const handoffs = provisionalPairHandoffs.get(ctx);
  const candidate = handoffs?.get(jobKey);
  if (candidate === undefined) return null;
  const revisions = await resolvePrRevisionCoordinates({ source, body, cwd: ctx.cwd, token, signal });
  if (
    revisions.headSha !== candidate.ready.headSha
    || revisions.baseSha !== candidate.ready.baseSha
  ) {
    handoffs!.delete(jobKey);
    return null;
  }
  const head = ctx.graphStore.acquire(candidate.ready.graphId);
  const comparison = ctx.graphStore.acquire(candidate.ready.comparisonGraphId);
  try {
    if (
      head === undefined
      || comparison === undefined
      || !sameGitHubSource(head.descriptor.source, source)
      || !sameGitHubSource(comparison.descriptor.source, source)
    ) {
      handoffs!.delete(jobKey);
      return null;
    }
    // Projection reservations are deliberately shorter-lived than graph registrations. Re-prove
    // and briefly reserve the boot pair on every delayed handoff instead of replaying stale
    // `ready` evidence after the projection cache has reclaimed its files.
    const prepared = await prepareInitialGraphProjectionCache(
      ctx,
      candidate.ready.graphId,
      candidate.ready.comparisonGraphId,
      signal,
    );
    if (!prepared.evidence.ready) {
      prepared.releaseReservation();
      handoffs!.delete(jobKey);
      return null;
    }
    const ready = {
      ...candidate.ready,
      cache: "hit" as const,
      initialProjectionCache: prepared.evidence,
    };
    candidate.ready = ready;
    return ready;
  } finally {
    head?.release();
    comparison?.release();
  }
}

function sameGitHubSource(value: ArtifactSource, expected: GitHubSource): boolean {
  return value.kind === "github"
    && value.owner === expected.owner
    && value.repo === expected.repo
    && (value.subdir ?? "") === (expected.subdir ?? "");
}

function provisionalDoneLine(ready: PrAnalysisReadyLine): PrAnalysisDone {
  return {
    ...ready,
    stage: "done",
    pairId: ready.pairId,
    completeness: "provisional",
    initialProjectionCache: ready.initialProjectionCache,
  };
}

/** Atomically publish and project the bounded pair after its extraction slot has been released. */
async function publishProvisionalPair(
  ctx: Context,
  source: GitHubSource,
  body: PrAnalyzeRequest,
  pair: ProvisionalPrGraphPair,
  signal: AbortSignal,
): Promise<PrAnalysisReadyLine | null> {
  // `cachedPrGraph` transfers these leases when it invokes this callback, before a publication is
  // necessarily attempted. Keep the pre-publication path explicit so cancellation or an identity
  // failure cannot strand the independently acquired provisional workspace. Once publishBatch is
  // invoked, GraphStore owns both leases even when its atomic transaction throws; its receipt lets
  // a post-publication readiness failure discard only registrations created by this exact attempt.
  let publicationAttempted = false;
  let publicationReceipt: WebGraphPublicationReceipt | null = null;
  let readyForHandoff = false;
  try {
    throwIfAborted(signal);
    const pairId = provisionalPairId(source, body, pair);
    const graphId = `pr-partial-${pairId}-${pair.headSha}`;
    const comparisonGraphId = `pr-partial-base-${pairId}-${pair.mergeBaseSha}`;
    const noSynthetic = { scenarios: [], sourceFingerprint: null, trust: null };
    const headProjectionRootChunks = graphProjectionRootChunks(
      pair.head.facts.initialGraphSeedFiles,
    );
    const comparisonProjectionRootChunks = graphProjectionRootChunks(
      pair.comparison.facts.initialGraphSeedFiles,
    );
    publicationAttempted = true;
    const publication = ctx.graphStore.publishBatch([
      {
        id: graphId,
        material: pair.head.material,
        rawGraphPayload: "projection-only",
        metadata: {
          sourceRoot: pair.head.sourceDir,
          ...(headProjectionRootChunks === undefined
            ? {}
            : { projectionRootChunks: headProjectionRootChunks }),
          sourceLease: pair.head.sourceLease,
          source,
          synthetic: noSynthetic,
        },
      },
      {
        id: comparisonGraphId,
        material: pair.comparison.material,
        rawGraphPayload: "projection-only",
        metadata: {
          sourceRoot: pair.comparison.sourceDir,
          ...(comparisonProjectionRootChunks === undefined
            ? {}
            : { projectionRootChunks: comparisonProjectionRootChunks }),
          sourceLease: pair.comparison.sourceLease,
          source,
          synthetic: noSynthetic,
        },
      },
    ], {
      receipt: true,
      // The server will not reuse this landing handoff after the same deadline. Keeping its two
      // source leases under the five-minute registry default beyond that point has no consumer.
      publicationHandoffTtlMs: PROVISIONAL_PAIR_HANDOFF_TTL_MS,
    });
    publicationReceipt = publication.receipt;
    throwIfAborted(signal);
    const prepared = await prepareInitialGraphProjectionCache(
      ctx,
      graphId,
      comparisonGraphId,
      signal,
    );
    if (!prepared.evidence.ready) {
      prepared.releaseReservation();
      return null;
    }
    // The reservation is TTL-backed and bound to the job signal. It intentionally spans the short
    // cross-page handoff; releasing here would recreate the eviction race the reservation prevents.
    const ready: PrAnalysisReadyLine = {
      stage: "ready",
      pairId,
      completeness: "provisional",
      graphId,
      comparisonGraphId,
      headSha: pair.headSha,
      baseSha: pair.baseSha,
      mergeBaseSha: pair.mergeBaseSha,
      counts: {
        nodes: pair.head.facts.summary.nodeCount,
        edges: pair.head.facts.summary.edgeCount,
      },
      changedFiles: pair.head.facts.changedFiles,
      warnings: uniqueStrings([...pair.head.facts.warnings, ...pair.comparison.facts.warnings]),
      cache: "miss",
      initialProjectionCache: prepared.evidence,
    };
    readyForHandoff = true;
    return ready;
  } finally {
    if (publicationReceipt !== null && !readyForHandoff) {
      ctx.graphStore.discardPublication(publicationReceipt);
    } else if (!publicationAttempted) {
      for (const lease of [pair.head.sourceLease, pair.comparison.sourceLease]) {
        try {
          lease.release();
        } catch {
          // Preserve the cancellation/publication failure while still attempting the sibling.
        }
      }
    }
  }
}

function provisionalPairId(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  pair: ProvisionalPrGraphPair,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    owner: source.owner,
    repo: source.repo,
    subdir: source.subdir ?? "",
    prNumber: body.prNumber,
    headRef: body.headRef,
    progressive: body.progressive === true,
    headSha: pair.headSha,
    mergeBaseSha: pair.mergeBaseSha,
    headDigest: pair.head.material.byteDigest,
    comparisonDigest: pair.comparison.material.byteDigest,
  })).digest("hex").slice(0, 20);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireExpectedHead(body: PrAnalyzeRequest, actualHeadSha: string): void {
  if (
    body.expectedHeadSha !== undefined
    && body.expectedHeadSha.toLowerCase() !== actualHeadSha.toLowerCase()
  ) {
    throw new WebError(409, "the pull request head changed after it was selected; refresh and try again");
  }
}

/** Request coordinates plus credential scope identify work that is safe for independent waiters
 * to share. Moving refs are resolved inside the job; completed results are never retained here. */
function prAnalysisJobKey(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  credentialKey: string,
  refresh: boolean,
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    owner: source.owner,
    repo: source.repo,
    subdir: source.subdir ?? "",
    prNumber: body.prNumber,
    baseRef: body.baseRef,
    headRef: body.headRef,
    progressive: body.progressive === true,
    credentialKey,
    refresh,
  })).digest("hex");
  return `pr:${digest}`;
}

async function prepareHeadPublication(
  ctx: Context,
  artifact: RepositoryAnalysisFacts,
  source: GitHubSource,
  sourceDir: string,
  sourceLease: RepositoryWorkspaceLease,
  body: PrAnalyzeRequest,
  headSha: string,
  mergeBaseSha: string,
  material: VerifiedFileArtifactMaterial,
): Promise<{
  graphId: string;
  registration: WebGraphRegistration;
  syntheticWarnings: string[];
  existingPin?: WebGraphRegistrationHandle;
}> {
  const sandboxAdmission = ctx.allowSyntheticPrExecution && ctx.syntheticPrSandboxRuntimeSupported();
  let syntheticScenarios: SyntheticScenarioDescriptor[] = [];
  let syntheticFingerprint: string | null = null;
  let syntheticTrustReady = sandboxAdmission;
  const syntheticWarnings: string[] = [];
  if (sandboxAdmission) {
    try {
      const { loadSyntheticScenarios } = await import("./synthetic-execution");
      syntheticScenarios = loadSyntheticScenarios(sourceDir);
      if (syntheticScenarios.length > 0) {
        syntheticFingerprint = syntheticSourceFingerprintForFiles(sourceDir, artifact.sourceFiles);
      } else {
        syntheticWarnings.push("Synthetic execution needs a valid meridian.synthetic.json scenario manifest.");
      }
    } catch {
      // A PR controls this file. Never leak parser/path details and never let a malformed manifest
      // prevent review of the graph itself; simply withhold the executable capability.
      syntheticScenarios = [];
      syntheticFingerprint = null;
      syntheticTrustReady = false;
      syntheticWarnings.push("Synthetic execution was disabled because the PR scenario manifest is invalid.");
    }
  }
  const synthetic = {
    scenarios: syntheticFingerprint === null ? [] : syntheticScenarios,
    sourceFingerprint: syntheticFingerprint,
    trust: syntheticTrustReady
      ? { mode: "sandboxed-pr" as const, provenance: { repository: `${source.owner}/${source.repo}`, headSha } }
      : null,
  };
  const syntheticDigest = createHash("sha256").update(JSON.stringify(synthetic)).digest("hex");
  const graphId = prGraphId(source, body, headSha, mergeBaseSha, material.byteDigest, syntheticDigest);
  const existingPin = ctx.graphStore.acquire(graphId);
  const sourceRoot = existingPin?.descriptor.sourceRoot ?? sourceDir;
  return {
    graphId,
    registration: {
        id: graphId,
        material,
        rawGraphPayload: "complete",
        metadata: {
          sourceRoot,
          sourceLease,
          source,
          synthetic,
        },
    },
    syntheticWarnings,
    ...(existingPin === undefined ? {} : { existingPin }),
  };
}

function prepareComparisonPublication(
  ctx: Context,
  source: GitHubSource,
  sourceDir: string,
  sourceLease: RepositoryWorkspaceLease,
  body: PrAnalyzeRequest,
  mergeBaseSha: string,
  material: VerifiedFileArtifactMaterial,
): {
  graphId: string;
  registration: WebGraphRegistration;
  existingPin?: WebGraphRegistrationHandle;
} {
  const graphId = prComparisonGraphId(source, body, mergeBaseSha, material.byteDigest);
  // One merge base can be rediscovered through multiple PR cache entries. Its source contents are
  // commit-identical, so keep the first published checkout as the immutable source snapshot rather
  // than rebinding the graph id to a newer filesystem path. Artifact/source mismatches still fail
  // closed in WebGraphStore.publishBatch.
  const existingPin = ctx.graphStore.acquire(graphId);
  const sourceRoot = existingPin?.descriptor.sourceRoot ?? sourceDir;
  return {
    graphId,
    registration: {
        id: graphId,
        material,
        rawGraphPayload: "complete",
        metadata: {
          sourceRoot,
          sourceLease,
          source,
          synthetic: { scenarios: [], sourceFingerprint: null, trust: null },
        },
    },
    ...(existingPin === undefined ? {} : { existingPin }),
  };
}

/** The terminal `done` line carries immutable ids and commit provenance for both comparison sides. */
function doneLine(
  graphId: string,
  comparisonGraphId: string,
  headSha: string,
  baseSha: string,
  mergeBaseSha: string,
  artifact: RepositoryAnalysisFacts,
  warnings: string[],
  cache: "hit" | "miss",
): PrAnalysisDone {
  return {
    stage: "done",
    graphId,
    comparisonGraphId,
    headSha,
    baseSha,
    mergeBaseSha,
    counts: { nodes: artifact.summary.nodeCount, edges: artifact.summary.edgeCount },
    changedFiles: artifact.changedFiles,
    warnings,
    cache,
  };
}

function directPreparationDone(
  completed: PrAnalysisDone,
  prNumber: number,
  initialProjectionCache?: InitialProjectionCacheEvidence,
): Record<string, unknown> {
  const provisional = completed.completeness === "provisional"
    && typeof completed.pairId === "string"
    && /^[a-f0-9]{20}$/.test(completed.pairId);
  const query = new URLSearchParams({
    id: completed.graphId,
    view: "modules",
    prn: String(prNumber),
    rev: "1",
    // Production review entry is partial-only. The complete artifact exists solely as an explicit
    // controlled benchmark lane, so its URL carries `0` rather than relying on an unsafe absence.
    progressive: initialProjectionCache?.ready === true || provisional ? "1" : "0",
    ...(provisional ? { partial: "1", pair: completed.pairId! } : {}),
  });
  return {
    ...completed,
    preparedPair: {
      version: 1,
      prNumber,
      headGraphId: completed.graphId,
      mergeBaseGraphId: completed.comparisonGraphId,
      headSha: completed.headSha,
      baseSha: completed.baseSha,
      mergeBaseSha: completed.mergeBaseSha,
      ...(provisional ? { completeness: "provisional", pairId: completed.pairId } : {}),
    },
    ...(initialProjectionCache === undefined ? {} : { initialProjectionCache }),
    viewUrl: `/view?${query.toString()}`,
  };
}

function directPreparationReady(
  ready: PrAnalysisReadyLine,
  prNumber: number,
): Record<string, unknown> {
  const canonicalShape: PrAnalysisDone = { ...ready, stage: "done" };
  const payload = directPreparationDone(
    canonicalShape,
    prNumber,
    ready.initialProjectionCache,
  );
  const view = new URL(payload.viewUrl as string, "http://meridian.invalid");
  view.searchParams.set("partial", "1");
  view.searchParams.set("pair", ready.pairId);
  return {
    ...payload,
    stage: "ready",
    pairId: ready.pairId,
    completeness: ready.completeness,
    initialProjectionCache: ready.initialProjectionCache,
    preparedPair: {
      ...(payload.preparedPair as Record<string, unknown>),
      completeness: "provisional",
      pairId: ready.pairId,
    },
    viewUrl: `${view.pathname}${view.search}`,
  };
}

/**
 * Immutable semantic snapshot id.
 *
 * The moving base-tip SHA is revalidated and returned as provenance, but the extracted HEAD graph
 * depends on the exact merge base. Advancing the target branch without changing that merge base
 * must therefore preserve this id so the already-decoded boot graph can be reused.
 */
function prGraphId(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  headSha: string,
  mergeBaseSha: string,
  artifactDigest: string,
  syntheticDigest: string,
): string {
  const key = [
    "pr",
    source.owner,
    source.repo,
    source.subdir ?? "",
    body.prNumber,
    body.headRef,
    headSha,
    mergeBaseSha,
    artifactDigest,
    syntheticDigest,
  ].join(" ");
  const keyDigest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `pr-${keyDigest}-${headSha}`;
}

/** The comparison id is pinned to the merge base plus exact extracted snapshot, never a moving ref. */
function prComparisonGraphId(
  source: GitHubSource,
  body: PrAnalyzeRequest,
  mergeBaseSha: string,
  artifactDigest: string,
): string {
  const key = [
    "pr-comparison",
    source.owner,
    source.repo,
    source.subdir ?? "",
    body.prNumber,
    mergeBaseSha,
    artifactDigest,
  ].join(" ");
  const keyDigest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return `pr-base-${keyDigest}-${mergeBaseSha}`;
}

function beginNdjson(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
}

function writeLine(response: ServerResponse, line: Record<string, unknown>): Promise<void> {
  if (!responseCanWrite(response)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    response.write(`${JSON.stringify(line)}\n`, (error) => error ? reject(error) : resolve());
  });
}

/** Never echo an unknown error's text (it could carry a path or secret); a WebError is pre-vetted. */
function safeMessage(error: unknown): string {
  if (isWebServiceShutdown(error)) return WEB_SERVICE_SHUTDOWN_MESSAGE;
  if (error instanceof WebError) {
    return error.message;
  }
  return "internal error while analyzing the pull request";
}
