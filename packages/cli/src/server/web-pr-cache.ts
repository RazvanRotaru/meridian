import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import {
  PR_PREPARE_MAX_CHANGED_PATH_BYTES,
  compareCanonicalPrPreparePaths,
  normalizePrPrepareChangedFiles,
  type ChangedFileManifestEntry,
  type PrPrepareStage,
  type PrPrepareTimings,
} from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { generatorVersion } from "../version";
import {
  canonicalRepositoryUrl,
  parseGitHubSource,
  sanitizeSubdir,
} from "./repository-source";
import { runGit } from "./git-exec";
import { prepareWebCache } from "./web-cache";
import { repositoryCacheKey } from "./web-cache-checkout";
import {
  createPrivateDirectory,
  isDirectory,
  readJson,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";
import {
  finalizedGenerationDirectory,
  prBaseArtifactEntry,
  prExactLookupFile,
  prHeadArtifactEntry,
} from "./graph-cache-layout";
import { WebError } from "./web-error";
import type { PrPrepareRequest } from "./web-pr-request";
import { repositoryMirrorSecurityKey } from "./repository-mirror";
import type {
  RepositoryDetachedWorktreeLease,
  RepositoryMirrorStore,
  RepositorySourceOperationLease,
  RepositorySourceLeaseReference,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import type {
  ExtractionWorkerResult,
  SerializablePipelineRequest,
} from "./extraction-worker";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import {
  GRAPH_PROJECTION_DIRECTORY,
  readGraphProjectionChangedSinceMeta,
  readGraphProjectionManifest,
} from "./graph-projection-bundle";
import {
  freezeGraphGenerationDirectory,
  sealGraphGeneration,
  verifyExistingGraphGeneration,
  type VerifiedGraphGeneration,
} from "./graph-generation-verifier";
import type {
  GraphGenerationLease,
  GraphGenerationLifecycle,
  GraphGenerationStage,
} from "./graph-generation-lifecycle";
import {
  REVIEW_COMPARISON_CONTEXT_FILE,
  readReviewComparisonContext,
  writeReviewComparisonContext,
  type ReviewComparisonContextReference,
} from "./review-comparison-context";
import { OwnershipCleanupError, withOwnershipCleanup } from "./ownership-cleanup";

export type { PrPrepareStage, PrPrepareTimings } from "@meridian/core";

export interface PrPrepareProgress {
  stage: PrPrepareStage;
  elapsedMs: number;
}

const FORMAT_VERSION = 11;
const ANALYSIS_VERSION = 5;
const CURRENT_FORMAT_VERSION = 1;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GENERATION = /^[a-z0-9][a-z0-9-]{0,95}$/;
const GIT_TIMEOUT_MS = 300_000;
const PR_CACHE_SOURCE_TTL_MS = 30 * 24 * 60 * 60_000;
interface SideMetadata {
  sourceRoot: string;
  leaseMetadata: string;
  sourceLease: RepositorySourceLeaseReference;
  graphSummary: GraphGenerationSummary;
  projectionContentId: string;
  artifactBytes: number;
  artifactSha256: string;
  projectionBytes: number;
  projectionSha256: string;
  vcsCommit: string;
  changedSinceBaseRef?: string;
}

interface PrMetadata {
  formatVersion: typeof FORMAT_VERSION;
  repositoryKey: string;
  securityDigest: string;
  headSha: string;
  /** Provenance only; deliberately excluded from cache/path validity. */
  creationBaseSha: string;
  mergeBaseSha: string;
  analysisKey: string;
  changedFiles: ChangedFileManifestEntry[];
  reviewContext: Pick<ReviewComparisonContextReference, "sha256" | "bytes">;
  warnings: string[];
  head: SideMetadata;
  /** Exact immutable shared merge-base generation referenced by this HEAD generation. */
  mergeBaseGenerationId: string;
  /** `populated`, or an empty-side hinted-file fingerprint. */
  mergeBaseVariant: string;
}

interface BaseMetadata {
  formatVersion: typeof FORMAT_VERSION;
  repositoryKey: string;
  securityDigest: string;
  mergeBaseSha: string;
  analysisKey: string;
  variant: string;
  side: SideMetadata;
  hintedFiles: string[];
  warnings: string[];
}

interface PrCurrentPointer {
  formatVersion: typeof CURRENT_FORMAT_VERSION;
  generationId: string;
}

interface ExactBasePointer {
  formatVersion: typeof CURRENT_FORMAT_VERSION;
  repositoryKey: string;
  securityDigest: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  analysisKey: string;
  generationId: string;
}

export interface CachedPrSide {
  artifactPath: string;
  projectionDirectory: string;
  graphSummary: GraphGenerationSummary;
  sourceDir: string;
  sourceRoot: string;
  sourceLease: RepositorySourceLeaseReference;
  verifiedGeneration: VerifiedGraphGeneration;
}

export interface CachedPrPreparation {
  analysisKey: string;
  repositoryKey: string;
  securityDigest: string;
  generationId: string;
  mergeBaseGenerationId: string;
  headSha: string;
  /** Current request provenance, not cache identity. */
  baseSha: string;
  mergeBaseSha: string;
  changedFiles: ChangedFileManifestEntry[];
  /** Digest-bound, status-rich comparison context physically owned by the HEAD generation. */
  reviewContext: ReviewComparisonContextReference;
  head: CachedPrSide;
  mergeBase: CachedPrSide;
  cache: "hit" | "miss";
  timings: PrPrepareTimings;
  warnings: string[];
}

type CachedSnapshot = Omit<
  CachedPrPreparation,
  "analysisKey" | "repositoryKey" | "securityDigest" | "baseSha" | "cache" | "timings"
>;

interface SharedBaseSnapshot {
  generationId: string;
  side: CachedPrSide;
  hintedFiles: string[];
  warnings: string[];
}

interface BaseFlight {
  controller: AbortController;
  promise: Promise<SharedBaseSnapshot>;
  subscribers: number;
  state: "waiting" | "active" | "draining" | "settled";
}

function isStructuralAbort(error: unknown): boolean {
  return !(error instanceof AggregateError)
    && typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

/**
 * Per-server owner of subscriber-aware merge-base singleflight work.
 *
 * A subscriber is allowed to stop waiting before the shared executor has physically drained. The
 * coordinator therefore owns every transferred detached-worktree lease until that executor and
 * its cleanup settle, and `close()` is the explicit server-shutdown join point for those tasks.
 */
export class PrBaseInspectionCoordinator {
  readonly #flights = new Map<string, BaseFlight>();
  readonly #activeFlights = new Set<BaseFlight>();
  #closed = false;
  #closedReason: unknown;
  #closePromise: Promise<void> | undefined;

  subscribe(
    key: string,
    lease: RepositoryDetachedWorktreeLease,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<SharedBaseSnapshot>,
  ): { promise: Promise<SharedBaseSnapshot>; leaseTransferred: boolean } {
    if (this.#closed) {
      return {
        promise: Promise.reject(this.#closedReason ?? coordinatorClosedError()),
        leaseTransferred: false,
      };
    }
    // Do not transfer a detached lease into a zero-subscriber flight. The creator may arrive here
    // already cancelled (for example while mirror preparation was completing); starting the shared
    // operation before subscription would otherwise leave it running without an owner.
    if (signal?.aborted) {
      return { promise: Promise.reject(abortReason(signal)), leaseTransferred: false };
    }
    let flight = this.#flights.get(key);
    let leaseTransferred = false;
    // A draining executor remains the same-key exclusion tombstone until it physically settles.
    // The first late subscriber installs one successor immediately, but that successor waits
    // behind the tombstone; later subscribers join it rather than overlapping another extraction.
    if (!flight || flight.state === "draining" || flight.state === "settled") {
      const predecessor = flight;
      leaseTransferred = true;
      const controller = new AbortController();
      const created: BaseFlight = {
        controller,
        promise: Promise.resolve(null as never),
        subscribers: 0,
        state: predecessor ? "waiting" : "active",
      };
      this.#activeFlights.add(created);
      created.promise = Promise.resolve()
        .then(async () => {
          if (predecessor) await predecessor.promise.catch(() => undefined);
          if (controller.signal.aborted) throw abortReason(controller.signal);
          created.state = "active";
          return operation(controller.signal);
        })
        .then(
          (value) => withOwnershipCleanup(
            () => value,
            [() => lease.release()],
            "merge-base inspection",
          ),
          (error: unknown) => withOwnershipCleanup(
            async () => { throw error; },
            [() => lease.release()],
            "merge-base inspection",
          ),
        )
        .finally(() => {
          created.state = "settled";
          this.#activeFlights.delete(created);
          if (this.#flights.get(key) === created) this.#flights.delete(key);
        });
      flight = created;
      this.#flights.set(key, created);
    }
    return { promise: subscribeToBaseFlight(flight, signal), leaseTransferred };
  }

  close(reason: unknown = coordinatorClosedError()): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closedReason = reason;
    const draining = [...this.#activeFlights];
    for (const flight of draining) {
      if (!flight.controller.signal.aborted) {
        flight.state = "draining";
        flight.controller.abort(reason);
      }
    }
    this.#closePromise = this.#drain(draining);
    return this.#closePromise;
  }

  async #drain(flights: readonly BaseFlight[]): Promise<void> {
    const settled = await Promise.allSettled(flights.map((flight) => flight.promise));
    const errors: unknown[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const flight = flights[index]!;
      if (result.status === "rejected"
        && (!flight.controller.signal.aborted
          || (result.reason !== flight.controller.signal.reason
            && !isStructuralAbort(result.reason)))) {
        errors.push(result.reason);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "merge-base inspections failed while the server was closing");
    }
  }
}

export interface PrPreparationInputs {
  cacheRoot: string;
  request: PrPrepareRequest;
  cwd: string;
  token?: string;
  refresh?: boolean;
  signal?: AbortSignal;
  repositoryMirrors: RepositoryMirrorStore;
  /** Per-server owner and shutdown join point for shared merge-base inspection work. */
  baseInspectionCoordinator: PrBaseInspectionCoordinator;
  generationLifecycle: GraphGenerationLifecycle;
  runExtraction: PrExtractionRunner;
  /** Set only by the bounded lifecycle scheduler before invoking this operation. */
  extractionAdmitted?: boolean;
  /** Stable hashed PR lifecycle identity used only for fair extraction-worker dequeue order. */
  extractionSchedulingGroup?: string;
  onProgress?(progress: PrPrepareProgress): void | Promise<void>;
}

export type PrExtractionRunner = (
  request: SerializablePipelineRequest,
  options: {
    artifactOutputPath: string;
    token?: string;
    signal?: AbortSignal;
    admitted?: boolean;
    schedulingGroup?: string;
  },
) => Promise<ExtractionWorkerResult>;

/** Resolve, prepare, extract and atomically publish a two-sided immutable PR inspection. */
export async function cachedPrPreparation(inputs: PrPreparationInputs): Promise<CachedPrPreparation> {
  prepareWebCache(inputs.cacheRoot);
  const timings: PrPrepareTimings = {};
  const remoteUrl = canonicalRepositoryUrl(parseGitHubSource(`${inputs.request.owner}/${inputs.request.repo}`));
  const revisions = await timed(inputs, timings, "resolve", () => remoteRevisions(
    remoteUrl,
    inputs.request,
    inputs.cwd,
    inputs.token,
    inputs.signal,
  ));
  const repositoryKey = repositoryCacheKey(remoteUrl);
  const securityKey = repositoryMirrorSecurityKey(repositoryKey, inputs.token);
  const securityDigest = createHash("sha256").update(securityKey).digest("hex");
  const analysisKey = prPreparationKey(inputs.request);
  let headLease: RepositoryWorktreeLease | undefined;
  let mergeBaseLease: RepositoryDetachedWorktreeLease | undefined;

  return withOwnershipCleanup(async () => {
    const prepared = await timed(inputs, timings, "git", async () => {
      throwIfAborted(inputs.signal);
      if (!inputs.refresh) {
        const exact = await readExactBaseLookup(
          inputs.cacheRoot,
          repositoryKey,
          securityDigest,
          inputs.request.subdir,
          revisions,
          analysisKey,
          inputs.generationLifecycle,
          inputs.signal,
        );
        if (exact) return exact;
      }
      headLease = await inputs.repositoryMirrors.prepare({
        repositoryKey: securityKey,
        remoteUrl,
        head: { ref: `refs/pull/${inputs.request.prNumber}/head`, oid: revisions.headSha },
        base: { ref: `refs/heads/${inputs.request.baseRef}`, oid: revisions.baseSha },
        jobId: `${analysisKey}:${revisions.headSha}`,
        token: inputs.token,
        signal: inputs.signal,
      });
      // GitHub's comparison is base...head. Argument order is observable for criss-cross
      // histories, so preserve base-first order and pin the resulting commit everywhere below.
      const mergeBaseSha = requireCommit((await runGit(["merge-base", headLease.baseRef, "HEAD"], {
        cwd: headLease.worktreeDir,
        timeoutMs: GIT_TIMEOUT_MS,
        ...(inputs.signal ? { signal: inputs.signal } : {}),
      })).trim());
      const entry = prEntry(
        inputs.cacheRoot,
        repositoryKey,
        securityDigest,
        inputs.request.subdir,
        revisions.headSha,
        mergeBaseSha,
        analysisKey,
      );
      const cached = inputs.refresh
        ? null
        : await readCached(
            inputs.cacheRoot,
            entry,
            repositoryKey,
            securityDigest,
            revisions.headSha,
            mergeBaseSha,
            analysisKey,
            inputs.request.subdir,
            inputs.generationLifecycle,
            inputs.signal,
          );
      return { mergeBaseSha, entry, cached };
    });

    if (prepared.cached) {
      await ensurePrCacheSourceOwners(
        inputs,
        prepared.cached,
        repositoryKey,
        securityDigest,
      );
      return {
        ...prepared.cached,
        analysisKey,
        repositoryKey,
        securityDigest,
        baseSha: revisions.baseSha,
        cache: "hit",
        timings,
      };
    }

    if (!headLease) throw new WebError(500, "repository worktree was not prepared");
    const generationId = newGenerationId();
    mergeBaseLease = await headLease.prepareDetachedRevision({
      oid: prepared.mergeBaseSha,
      jobId: `${analysisKey}:${generationId}:merge-base`,
      signal: inputs.signal,
    });
    // The detached lease object may be transferred to a shared base flight before HEAD starts.
    // Preserve the immutable comparison ref separately from the mutable ownership variable.
    const mergeBaseRef = mergeBaseLease.ref;
    const roots = extractionRoots(headLease.worktreeDir, mergeBaseLease.worktreeDir, inputs.request.subdir);
    const generationDir = finalizedGenerationDirectory(prepared.entry, generationId);
    createPrivateDirectory(dirname(generationDir));
    const stage = await inputs.generationLifecycle.reserveStage(inputs.signal);
    const headOutput = join(stage.directory, "head", "artifact.json");
    mkdirSync(dirname(headOutput), { recursive: true, mode: 0o700 });
    let generationLease: GraphGenerationLease | undefined;
    let result: CachedPrPreparation | undefined;
    let operationFailed = false;
    let operationError: unknown;

    try {
      let head: ExtractionWorkerResult;
      let mergeBase: SharedBaseSnapshot;
      let mergeBaseVariant: string;
      if (roots.headMaterialized) {
        mergeBaseVariant = "populated";
        mergeBase = await timed(inputs, timings, "extract-merge-base", () => sharedBase(
          inputs,
          repositoryKey,
          securityDigest,
          roots.mergeBase,
          remoteUrl,
          prepared.mergeBaseSha,
          analysisKey,
          mergeBaseVariant,
          mergeBaseLease as RepositoryDetachedWorktreeLease,
          { onLeaseTransfer: () => { mergeBaseLease = undefined; } },
        ));
        head = await timed(inputs, timings, "extract-head", () => extractHead(
          inputs,
          roots.head,
          remoteUrl,
          revisions.headSha,
          prepared.mergeBaseSha,
          mergeBaseRef,
          headOutput,
          { allowEmpty: true, hintedFiles: mergeBase.hintedFiles },
        ));
      } else {
        const comparisonRoot = resolveOrMaterializeComparisonRoot(mergeBaseLease.worktreeDir, inputs.request.subdir);
        if (comparisonRoot.materialized) {
          // An empty merge-base side needs representative paths from HEAD to select the same
          // extractors, so this branch is deliberately serialized.
          head = await timed(inputs, timings, "extract-head", () => extractHead(
            inputs,
            roots.head,
            remoteUrl,
            revisions.headSha,
            prepared.mergeBaseSha,
            mergeBaseRef,
            headOutput,
          ));
          mergeBaseVariant = emptyBaseVariant(head.hintedFiles);
          mergeBase = await timed(inputs, timings, "extract-merge-base", () => sharedBase(
            inputs,
            repositoryKey,
            securityDigest,
            comparisonRoot.root,
            remoteUrl,
            prepared.mergeBaseSha,
            analysisKey,
            mergeBaseVariant,
            mergeBaseLease as RepositoryDetachedWorktreeLease,
            {
              empty: { allowEmpty: true, hintedFiles: head.hintedFiles },
              onLeaseTransfer: () => { mergeBaseLease = undefined; },
            },
          ));
        } else {
          // Both populated sides are independent. Let the global extraction scheduler use spare
          // capacity for one PR while continuing to bound aggregate worker memory across PRs.
          mergeBaseVariant = "populated";
          [head, mergeBase] = await parallelExtractionPair(
            inputs.signal,
            async (signal) => {
              const scoped = { ...inputs, signal };
              return timed(scoped, timings, "extract-head", () => extractHead(
                scoped,
                roots.head,
                remoteUrl,
                revisions.headSha,
                prepared.mergeBaseSha,
                mergeBaseRef,
                headOutput,
              ));
            },
            async (signal) => {
              const scoped = { ...inputs, signal };
              return timed(scoped, timings, "extract-merge-base", () => sharedBase(
                scoped,
                repositoryKey,
                securityDigest,
                comparisonRoot.root,
                remoteUrl,
                prepared.mergeBaseSha,
                analysisKey,
                mergeBaseVariant,
                mergeBaseLease as RepositoryDetachedWorktreeLease,
                { onLeaseTransfer: () => { mergeBaseLease = undefined; } },
              ));
            },
          );
        }
      }
      const changedFiles = canonicalChangedFiles(head.changedFiles);
      const warnings = [...new Set([...head.warnings, ...mergeBase.warnings])];
      const reviewContext = writeReviewComparisonContext(
        join(dirname(headOutput), REVIEW_COMPARISON_CONTEXT_FILE),
        {
          headSha: revisions.headSha,
          mergeBaseSha: prepared.mergeBaseSha,
          analysisKey,
          changedFiles,
        },
      );
      const metadata: PrMetadata = {
        formatVersion: FORMAT_VERSION,
        repositoryKey,
        securityDigest,
        headSha: revisions.headSha,
        creationBaseSha: revisions.baseSha,
        mergeBaseSha: prepared.mergeBaseSha,
        analysisKey,
        changedFiles,
        reviewContext: {
          sha256: reviewContext.sha256,
          bytes: reviewContext.bytes,
        },
        warnings,
        head: sideMetadata(inputs.cacheRoot, headLease, head),
        mergeBaseGenerationId: mergeBase.generationId,
        mergeBaseVariant,
      };
      // The comparison edge and canonical status-rich manifest live inside the HEAD side seal.
      // GC can therefore traverse only metadata whose exact filesystem identity is digest-bound.
      writePrivateJson(join(dirname(headOutput), "metadata.json"), metadata);
      await verifyWorkerOutput(
        inputs.cacheRoot,
        stage,
        head,
        headOutput,
        revisions.headSha,
        prepared.mergeBaseSha,
        inputs.signal,
      );
      freezeGraphGenerationDirectory(inputs.cacheRoot, dirname(headOutput));

      const published = await timed(inputs, timings, "publish", async () => {
        throwIfAborted(inputs.signal);
        generationLease = await inputs.generationLifecycle.acquire(generationDir, {
          purpose: "publication",
          allowMissing: true,
          signal: inputs.signal,
        });
        if (!await stage.publish(generationLease, inputs.signal)) {
          throw new WebError(409, "PR cache generation already exists; retry");
        }
        freezeGraphGenerationDirectory(inputs.cacheRoot, generationDir);
        const snapshot = await readCachedGeneration(
          inputs.cacheRoot,
          inputs.generationLifecycle,
          generationLease,
          generationId,
          repositoryKey,
          securityDigest,
          revisions.headSha,
          prepared.mergeBaseSha,
          analysisKey,
          inputs.request.subdir,
          inputs.signal,
        );
        if (!snapshot) throw new WebError(422, "cached PR preparation failed verification");
        // The current pointer is a durable two-sided alias. Publish/repair both source owners
        // before making the alias visible so a restart can never observe a graph whose source
        // worktree was released between generation publication and alias publication.
        const ownerRepair = await ensurePrCacheSourceOwners(
          inputs,
          snapshot,
          repositoryKey,
          securityDigest,
        );
        try {
          await inputs.generationLifecycle.runExclusive(() => {
            writePrivateJson(join(prepared.entry, "current.json"), {
              formatVersion: CURRENT_FORMAT_VERSION,
              generationId,
            } satisfies PrCurrentPointer);
          }, inputs.signal);
        } catch (error) {
          return withOwnershipCleanup(
            async () => { throw error; },
            [() => ownerRepair.rollback()],
            "PR cache alias publication",
          );
        }
        // This exact-base alias only avoids mirror preparation on the next request. The canonical
        // generation/current pointer above is complete correctness state, so an alias I/O failure
        // must never turn an already-published inspection into a failed request.
        try {
          await inputs.generationLifecycle.runExclusive(() => {
            writePrivateJson(exactBaseLookupPath(
              inputs.cacheRoot,
              repositoryKey,
              securityDigest,
              inputs.request.subdir,
              revisions.headSha,
              revisions.baseSha,
              analysisKey,
            ), {
              formatVersion: CURRENT_FORMAT_VERSION,
              repositoryKey,
              securityDigest,
              headSha: revisions.headSha,
              baseSha: revisions.baseSha,
              mergeBaseSha: prepared.mergeBaseSha,
              analysisKey,
              generationId,
            } satisfies ExactBasePointer);
          }, inputs.signal);
        } catch {
          // A later request safely falls back to the mirror-backed canonical lookup.
        }
        return snapshot;
      });
      result = {
        ...published,
        analysisKey,
        repositoryKey,
        securityDigest,
        baseSha: revisions.baseSha,
        cache: "miss",
        timings,
      };
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    await finishGenerationStage(
      stage,
      generationLease,
      operationFailed,
      operationError,
      "PR HEAD generation",
    );
    return result!;
  }, [
    async () => { await mergeBaseLease?.release(); },
    async () => { await headLease?.release(); },
  ], "PR preparation");
}

async function ensurePrCacheSourceOwners(
  inputs: PrPreparationInputs,
  snapshot: CachedSnapshot,
  repositoryKey: string,
  securityDigest: string,
): Promise<{ rollback(): Promise<void> }> {
  const deadline = Date.now() + PR_CACHE_SOURCE_TTL_MS;
  const headOwner = prHeadCacheOwner(repositoryKey, securityDigest, snapshot.generationId);
  const baseOwner = prHeadBaseCacheOwner(repositoryKey, securityDigest, snapshot.generationId);
  const addedHead = await inputs.repositoryMirrors.retainSource(
    snapshot.head.sourceLease,
    snapshot.head.sourceRoot,
    headOwner,
    deadline,
  );
  try {
    const addedBase = await inputs.repositoryMirrors.retainSource(
      snapshot.mergeBase.sourceLease,
      snapshot.mergeBase.sourceRoot,
      baseOwner,
      deadline,
    );
    return {
      rollback: () => withOwnershipCleanup(
        () => undefined,
        [
          ...addedHead ? [() => inputs.repositoryMirrors.releaseSource(snapshot.head.sourceLease, headOwner)] : [],
          ...addedBase ? [() => inputs.repositoryMirrors.releaseSource(snapshot.mergeBase.sourceLease, baseOwner)] : [],
        ],
        "PR cache source-owner rollback",
      ),
    };
  } catch (error) {
    // If this call created the first half of a new alias, undo it. Existing ownership is never
    // shortened: warm reads use this same routine to repair either missing half deterministically.
    return withOwnershipCleanup(
      async () => { throw error; },
      addedHead
        ? [() => inputs.repositoryMirrors.releaseSource(snapshot.head.sourceLease, headOwner)]
        : [],
      "PR cache source-owner acquisition",
    );
  }
}

/**
 * Acquire per-subscriber transient source ownership after a shared preparation resolves.
 * These handles must never be stored in `CachedPrPreparation`: scheduler singleflight values are
 * shared, while publication/cancellation lifetimes belong to one HTTP subscriber.
 */
export async function acquirePrPreparationSourceOperations(
  repositoryMirrors: RepositoryMirrorStore,
  prepared: CachedPrPreparation,
  signal?: AbortSignal,
): Promise<readonly [RepositorySourceOperationLease, RepositorySourceOperationLease]> {
  const headOperation = await repositoryMirrors.acquireSource(
    prepared.head.sourceLease,
    prepared.head.sourceRoot,
    `pr-head-publication:${prepared.generationId}`,
    signal,
  );
  try {
    const baseOperation = await repositoryMirrors.acquireSource(
      prepared.mergeBase.sourceLease,
      prepared.mergeBase.sourceRoot,
      `pr-base-publication:${prepared.mergeBaseGenerationId}`,
      signal,
    );
    return [headOperation, baseOperation] as const;
  } catch (error) {
    return withOwnershipCleanup(
      async () => { throw error; },
      [() => headOperation.release()],
      "PR publication source acquisition",
    );
  }
}

function prHeadCacheOwner(repositoryKey: string, securityDigest: string, generationId: string): string {
  return `pr-head-cache:${repositoryKey}:${securityDigest}:${generationId}`;
}

function prHeadBaseCacheOwner(repositoryKey: string, securityDigest: string, generationId: string): string {
  return `pr-head-base-cache:${repositoryKey}:${securityDigest}:${generationId}`;
}

function prBaseCacheOwner(repositoryKey: string, securityDigest: string, generationId: string): string {
  return `pr-base-cache:${repositoryKey}:${securityDigest}:${generationId}`;
}

async function timed<T>(
  inputs: PrPreparationInputs,
  timings: PrPrepareTimings,
  stage: PrPrepareStage,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const result = await operation();
  const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
  timings[stage] = elapsedMs;
  await inputs.onProgress?.({ stage, elapsedMs });
  return result;
}

async function remoteRevisions(
  url: string,
  request: PrPrepareRequest,
  cwd: string,
  token?: string,
  signal?: AbortSignal,
): Promise<{ headSha: string; baseSha: string }> {
  const baseRef = `refs/heads/${request.baseRef}`;
  const headRef = `refs/pull/${request.prNumber}/head`;
  const output = await runGit(["ls-remote", "--exit-code", url, baseRef, headRef], {
    cwd,
    token,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  const rows = new Map(output.trim().split("\n").map((line) => {
    const [sha, ref] = line.trim().split(/\s+/, 2);
    return [ref, sha] as const;
  }));
  const baseSha = rows.get(baseRef);
  const headSha = rows.get(headRef);
  if (!baseSha || !headSha) throw new WebError(422, "pull request revisions were not found");
  return { baseSha: requireCommit(baseSha), headSha: requireCommit(headSha) };
}

async function extractHead(
  inputs: PrPreparationInputs,
  root: string,
  remoteUrl: string,
  headSha: string,
  mergeBaseSha: string,
  changedSinceRef: string,
  artifactOutputPath: string,
  empty?: { allowEmpty: true; hintedFiles: string[] },
): Promise<ExtractionWorkerResult> {
  if (!changedSinceRef) throw new WebError(500, "merge-base revision was not prepared");
  return inputs.runExtraction({
    absoluteRoot: root,
    cwd: root,
    depth: REPOSITORY_ANALYSIS_POLICY.depth,
    includeExternal: REPOSITORY_ANALYSIS_POLICY.includeExternal,
    includeUnresolved: REPOSITORY_ANALYSIS_POLICY.includeUnresolved,
    materializeBoundary: REPOSITORY_ANALYSIS_POLICY.materializeBoundary,
    excludeTests: REPOSITORY_ANALYSIS_POLICY.excludeTests,
    valueRefs: REPOSITORY_ANALYSIS_POLICY.valueRefs,
    targetName: `${inputs.request.owner}/${inputs.request.repo}`,
    changedSince: changedSinceRef,
    changedSinceLabel: mergeBaseSha,
    changedSinceTimeoutMs: GIT_TIMEOUT_MS,
    // Branch is request provenance, not immutable graph identity. The snapshot descriptor stores
    // it separately, allowing aliases for the same HEAD/merge-base pair to share this artifact.
    vcs: { repository: remoteUrl, commit: headSha },
    ...empty,
  }, workerOptions(inputs, artifactOutputPath));
}

async function extractSide(
  inputs: PrPreparationInputs,
  root: string,
  remoteUrl: string,
  mergeBaseSha: string,
  artifactOutputPath: string,
  empty?: { allowEmpty: true; hintedFiles: string[] },
  signal = inputs.signal,
): Promise<ExtractionWorkerResult> {
  return inputs.runExtraction({
    absoluteRoot: root,
    cwd: root,
    depth: REPOSITORY_ANALYSIS_POLICY.depth,
    includeExternal: REPOSITORY_ANALYSIS_POLICY.includeExternal,
    includeUnresolved: REPOSITORY_ANALYSIS_POLICY.includeUnresolved,
    materializeBoundary: REPOSITORY_ANALYSIS_POLICY.materializeBoundary,
    excludeTests: REPOSITORY_ANALYSIS_POLICY.excludeTests,
    valueRefs: REPOSITORY_ANALYSIS_POLICY.valueRefs,
    targetName: `${inputs.request.owner}/${inputs.request.repo}`,
    vcs: { repository: remoteUrl, commit: mergeBaseSha },
    ...empty,
  }, workerOptions(inputs, artifactOutputPath, signal));
}

function workerOptions(
  inputs: PrPreparationInputs,
  artifactOutputPath: string,
  signal = inputs.signal,
): {
  artifactOutputPath: string;
  token?: string;
  signal?: AbortSignal;
  admitted?: boolean;
  schedulingGroup?: string;
} {
  return {
    artifactOutputPath,
    ...(inputs.token ? { token: inputs.token } : {}),
    ...(signal ? { signal } : {}),
    ...(inputs.extractionAdmitted === true ? { admitted: true } : {}),
    ...(inputs.extractionSchedulingGroup ? { schedulingGroup: inputs.extractionSchedulingGroup } : {}),
  };
}

async function sharedBase(
  inputs: PrPreparationInputs,
  repositoryKey: string,
  securityDigest: string,
  root: string,
  remoteUrl: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
  lease: RepositoryDetachedWorktreeLease,
  options: {
    empty?: { allowEmpty: true; hintedFiles: string[] };
    onLeaseTransfer(): void;
  },
): Promise<SharedBaseSnapshot> {
  const entry = sharedBaseEntry(
    inputs.cacheRoot,
    repositoryKey,
    securityDigest,
    inputs.request.subdir,
    mergeBaseSha,
    analysisKey,
    variant,
  );
  if (!inputs.refresh) {
    const cached = await readSharedBase(
      inputs.cacheRoot,
      entry,
      repositoryKey,
      securityDigest,
      mergeBaseSha,
      analysisKey,
      variant,
      inputs.request.subdir,
      inputs.generationLifecycle,
      inputs.signal,
    );
    if (cached) return cached;
  }

  const flightKey = `${entry}:${inputs.refresh === true ? "refresh" : "normal"}`;
  const subscription = inputs.baseInspectionCoordinator.subscribe(
    flightKey,
    lease,
    inputs.signal,
    async (signal) => {
      // Recheck inside the winning flight: another process may have published after our first read.
      if (!inputs.refresh) {
        const cached = await readSharedBase(
          inputs.cacheRoot,
          entry,
          repositoryKey,
          securityDigest,
          mergeBaseSha,
          analysisKey,
          variant,
          inputs.request.subdir,
          inputs.generationLifecycle,
          signal,
        );
        if (cached) {
          return cached;
        }
      }
      return publishSharedBase(
        inputs,
        entry,
        repositoryKey,
        securityDigest,
        root,
        remoteUrl,
        mergeBaseSha,
        analysisKey,
        variant,
        lease,
        options.empty,
        signal,
      );
    },
  );
  // Transfer ownership before awaiting the subscriber. If this caller disconnects while another
  // subscriber still needs the shared flight, its outer finally must not release the live lease.
  if (subscription.leaseTransferred) options.onLeaseTransfer();
  return subscription.promise;
}

/**
 * Run two independent extractions concurrently without releasing their worktrees while a failed
 * peer is still draining. The shared worker scheduler remains the sole aggregate admission gate.
 */
async function parallelExtractionPair<Left, Right>(
  parentSignal: AbortSignal | undefined,
  left: (signal: AbortSignal) => Promise<Left>,
  right: (signal: AbortSignal) => Promise<Right>,
): Promise<[Left, Right]> {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(parentSignal));
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const leftPending = Promise.resolve().then(() => left(controller.signal));
  const rightPending = Promise.resolve().then(() => right(controller.signal));
  try {
    return await Promise.all([leftPending, rightPending]);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    const cancellationReason = controller.signal.reason;
    const settled = await Promise.allSettled([leftPending, rightPending]);
    const orderedFailures: unknown[] = [];
    let primaryRecorded = false;
    let independentPeerFailure = false;
    for (const result of settled) {
      if (result.status === "fulfilled") continue;
      if (result.reason === error) {
        if (primaryRecorded) continue;
        primaryRecorded = true;
        if (result.reason instanceof OwnershipCleanupError) {
          orderedFailures.push(...result.reason.errors);
        } else {
          orderedFailures.push(result.reason);
        }
        continue;
      }
      const peerFailures = result.reason instanceof OwnershipCleanupError
        ? result.reason.errors
        : [result.reason];
      for (const peerFailure of peerFailures) {
        // A peer that faithfully throws the shared abort reason adds no new failure. An ownership
        // cleanup wrapping that reason may still carry independent release failures after it.
        if (peerFailure === error || peerFailure === cancellationReason) continue;
        orderedFailures.push(peerFailure);
        independentPeerFailure = true;
      }
    }
    if (!independentPeerFailure) throw error;
    if (!primaryRecorded) orderedFailures.push(error);
    throw new AggregateError(
      orderedFailures,
      "parallel PR extraction failed on both sides",
    );
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function subscribeToBaseFlight(flight: BaseFlight, signal?: AbortSignal): Promise<SharedBaseSnapshot> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  flight.subscribers += 1;
  return new Promise<SharedBaseSnapshot>((resolveFlight, rejectFlight) => {
    let complete = false;
    const finish = (action: () => void) => {
      if (complete) return;
      complete = true;
      signal?.removeEventListener("abort", onAbort);
      flight.subscribers -= 1;
      if (flight.subscribers === 0 && (flight.state === "waiting" || flight.state === "active")) {
        flight.state = "draining";
        flight.controller.abort(clientAbortError());
      }
      action();
    };
    const onAbort = () => finish(() => rejectFlight(abortReason(signal)));
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(
      (value) => finish(() => resolveFlight(value)),
      (error) => finish(() => rejectFlight(error)),
    );
  });
}

async function publishSharedBase(
  inputs: PrPreparationInputs,
  entry: string,
  repositoryKey: string,
  securityDigest: string,
  root: string,
  remoteUrl: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
  lease: RepositoryDetachedWorktreeLease,
  empty: { allowEmpty: true; hintedFiles: string[] } | undefined,
  signal: AbortSignal,
): Promise<SharedBaseSnapshot> {
  const generationId = newGenerationId();
  const generationDirectory = finalizedGenerationDirectory(entry, generationId);
  createPrivateDirectory(dirname(generationDirectory));
  const stage = await inputs.generationLifecycle.reserveStage(signal);
  const artifactOutputPath = join(stage.directory, "merge-base", "artifact.json");
  mkdirSync(dirname(artifactOutputPath), { recursive: true, mode: 0o700 });
  let generationLease: GraphGenerationLease | undefined;
  let result: SharedBaseSnapshot | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const extracted = await extractSide(
      inputs,
      root,
      remoteUrl,
      mergeBaseSha,
      artifactOutputPath,
      empty,
      signal,
    );
    const hintedFiles = canonicalHintedFiles(extracted.hintedFiles);
    writePrivateJson(join(dirname(artifactOutputPath), "metadata.json"), {
      formatVersion: FORMAT_VERSION,
      repositoryKey,
      securityDigest,
      mergeBaseSha,
      analysisKey,
      variant,
      side: sideMetadata(inputs.cacheRoot, lease, extracted),
      hintedFiles,
      warnings: [...new Set(extracted.warnings)],
    } satisfies BaseMetadata);
    await verifyWorkerOutput(
      inputs.cacheRoot,
      stage,
      extracted,
      artifactOutputPath,
      mergeBaseSha,
      undefined,
      signal,
    );
    freezeGraphGenerationDirectory(inputs.cacheRoot, dirname(artifactOutputPath));
    generationLease = await inputs.generationLifecycle.acquire(generationDirectory, {
      purpose: "publication",
      allowMissing: true,
      signal,
    });
    if (!await stage.publish(generationLease, signal)) {
      throw new WebError(409, "merge-base cache generation already exists; retry");
    }
    freezeGraphGenerationDirectory(inputs.cacheRoot, generationDirectory);
    const published = await readSharedBaseGeneration(
      inputs.cacheRoot,
      generationLease,
      generationId,
      repositoryKey,
      securityDigest,
      mergeBaseSha,
      analysisKey,
      variant,
      inputs.request.subdir,
      signal,
    );
    if (!published) throw new WebError(422, "cached merge-base preparation failed verification");
    const baseOwner = prBaseCacheOwner(repositoryKey, securityDigest, generationId);
    const addedBaseOwner = await inputs.repositoryMirrors.retainSource(
      published.side.sourceLease,
      published.side.sourceRoot,
      baseOwner,
      Date.now() + PR_CACHE_SOURCE_TTL_MS,
    );
    try {
      await inputs.generationLifecycle.runExclusive(() => {
        writePrivateJson(join(entry, "current.json"), {
          formatVersion: CURRENT_FORMAT_VERSION,
          generationId,
        } satisfies PrCurrentPointer);
      }, signal);
    } catch (error) {
      return withOwnershipCleanup(
        async () => { throw error; },
        addedBaseOwner
          ? [() => inputs.repositoryMirrors.releaseSource(published.side.sourceLease, baseOwner)]
          : [],
        "merge-base cache source-owner publication",
      );
    }
    result = published;
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  await finishGenerationStage(
    stage,
    generationLease,
    operationFailed,
    operationError,
    "merge-base generation",
  );
  return result!;
}

async function finishGenerationStage(
  stage: GraphGenerationStage,
  generationLease: GraphGenerationLease | undefined,
  operationFailed: boolean,
  operationError: unknown,
  label: string,
): Promise<void> {
  await withOwnershipCleanup(
    async () => {
      if (operationFailed) throw operationError;
    },
    [
      () => stage.release(),
      ...generationLease ? [() => generationLease.release()] : [],
    ],
    label,
  );
}

async function verifyWorkerOutput(
  cacheRoot: string,
  stage: GraphGenerationStage,
  result: ExtractionWorkerResult,
  artifactOutputPath: string,
  expectedCommit: string,
  expectedChangedSinceBaseRef: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const expectedProjection = join(dirname(artifactOutputPath), GRAPH_PROJECTION_DIRECTORY);
  if (result.artifactPath !== artifactOutputPath || result.projectionDirectory !== expectedProjection) {
    throw new WebError(500, "extraction wrote outside its PR cache stage");
  }
  if (result.vcsCommit !== expectedCommit
    || result.changedSinceBaseRef !== expectedChangedSinceBaseRef) {
    throw new WebError(422, "extraction returned mismatched revision provenance");
  }
  const manifest = readGraphProjectionManifest(expectedProjection);
  const changedSince = readGraphProjectionChangedSinceMeta(expectedProjection);
  if (!manifest
    || !sameGraphSummary(manifest.graphSummary, result.graphSummary)
    || manifest.header.target.vcs?.commit !== expectedCommit
    || changedSince?.baseRef !== expectedChangedSinceBaseRef) {
    throw new WebError(422, "extraction returned mismatched projection provenance");
  }
  try {
    await sealGraphGeneration({
      cacheRoot,
      stage,
      artifactPath: result.artifactPath,
      projectionDirectory: result.projectionDirectory,
      artifactBytes: result.artifactBytes,
      artifactSha256: result.artifactSha256,
      projectionBytes: result.projectionBytes,
      projectionSha256: result.projectionSha256,
      projectionContentId: result.projectionContentId,
      graphSummary: result.graphSummary,
      revision: { kind: "git", commit: expectedCommit },
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new WebError(422, "extraction returned mismatched generation integrity metadata");
  }
}

function sideMetadata(
  cacheRoot: string,
  lease: Pick<RepositoryWorktreeLease, "leaseId" | "repositoryDigest" | "worktreeDir">
    | RepositoryDetachedWorktreeLease,
  extracted: ExtractionWorkerResult,
): SideMetadata {
  if (extracted.vcsCommit === undefined) {
    throw new WebError(422, "extraction omitted revision provenance");
  }
  return {
    sourceRoot: cacheRelativePath(cacheRoot, lease.worktreeDir),
    leaseMetadata: cacheRelativePath(
      cacheRoot,
      join(dirname(dirname(lease.worktreeDir)), "leases", `${lease.leaseId}.json`),
    ),
    sourceLease: { repositoryDigest: lease.repositoryDigest, leaseId: lease.leaseId },
    graphSummary: extracted.graphSummary,
    projectionContentId: extracted.projectionContentId,
    artifactBytes: extracted.artifactBytes,
    artifactSha256: extracted.artifactSha256,
    projectionBytes: extracted.projectionBytes,
    projectionSha256: extracted.projectionSha256,
    vcsCommit: extracted.vcsCommit,
    ...(extracted.changedSinceBaseRef !== undefined
      ? { changedSinceBaseRef: extracted.changedSinceBaseRef }
      : {}),
  };
}

async function readExactBaseLookup(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdir: string | undefined,
  revisions: { headSha: string; baseSha: string },
  analysisKey: string,
  generationLifecycle: GraphGenerationLifecycle,
  signal: AbortSignal | undefined,
): Promise<{ mergeBaseSha: string; entry: string; cached: CachedSnapshot } | null> {
  let generationLease: GraphGenerationLease | null = null;
  return withOwnershipCleanup(async () => {
    try {
    const path = exactBaseLookupPath(
      cacheRoot,
      repositoryKey,
      securityDigest,
      subdir,
      revisions.headSha,
      revisions.baseSha,
      analysisKey,
    );
    const resolution: {
      value?: { mergeBaseSha: string; entry: string; generationId: string };
    } = {};
    generationLease = await generationLifecycle.acquireResolvedGeneration(() => {
      const pointer = readJson(path) as Partial<ExactBasePointer>;
      if (pointer.formatVersion !== CURRENT_FORMAT_VERSION
        || pointer.repositoryKey !== repositoryKey
        || pointer.securityDigest !== securityDigest
        || pointer.headSha !== revisions.headSha
        || pointer.baseSha !== revisions.baseSha
        || pointer.analysisKey !== analysisKey
        || typeof pointer.mergeBaseSha !== "string" || !COMMIT.test(pointer.mergeBaseSha)
        || typeof pointer.generationId !== "string" || !GENERATION.test(pointer.generationId)) return null;
      const mergeBaseSha = pointer.mergeBaseSha.toLowerCase();
      const entry = prEntry(
        cacheRoot,
        repositoryKey,
        securityDigest,
        subdir,
        revisions.headSha,
        mergeBaseSha,
        analysisKey,
      );
      resolution.value = { mergeBaseSha, entry, generationId: pointer.generationId };
      return finalizedGenerationDirectory(entry, pointer.generationId);
    }, { purpose: "cache-read", signal });
    const resolved = resolution.value;
    if (!generationLease || !resolved) return null;
    const cached = await readCachedGeneration(
      cacheRoot,
      generationLifecycle,
      generationLease,
      resolved.generationId,
      repositoryKey,
      securityDigest,
      revisions.headSha,
      resolved.mergeBaseSha,
      analysisKey,
      subdir,
      signal,
    );
    if (!cached) return null;
    touchMetadata(path);
    return { mergeBaseSha: resolved.mergeBaseSha, entry: resolved.entry, cached };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof OwnershipCleanupError) throw error;
      if (error instanceof WebError && error.status === 429) throw error;
      return null;
    }
  }, [async () => { await generationLease?.release(); }], "exact-base cache read");
}

async function readCached(
  cacheRoot: string,
  entry: string,
  repositoryKey: string,
  securityDigest: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
  subdir: string | undefined,
  generationLifecycle: GraphGenerationLifecycle,
  signal: AbortSignal | undefined,
): Promise<CachedSnapshot | null> {
  let generationLease: GraphGenerationLease | null = null;
  return withOwnershipCleanup(async () => {
    try {
    let generationId: string | null = null;
    generationLease = await generationLifecycle.acquireResolvedGeneration(() => {
      const active = activeGeneration(entry);
      generationId = active?.generationId ?? null;
      return active?.directory ?? null;
    }, { purpose: "cache-read", signal });
    if (!generationLease || !generationId) return null;
    const cached = await readCachedGeneration(
      cacheRoot,
      generationLifecycle,
      generationLease,
      generationId,
      repositoryKey,
      securityDigest,
      headSha,
      mergeBaseSha,
      analysisKey,
      subdir,
      signal,
    );
    if (cached) touchMetadata(join(entry, "current.json"));
    return cached;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof OwnershipCleanupError) throw error;
      if (error instanceof WebError && error.status === 429) throw error;
      return null;
    }
  }, [async () => { await generationLease?.release(); }], "PR cache read");
}

async function readCachedGeneration(
  cacheRoot: string,
  generationLifecycle: GraphGenerationLifecycle,
  generationLease: GraphGenerationLease,
  generationId: string,
  repositoryKey: string,
  securityDigest: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
  subdir: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CachedSnapshot | null> {
  let mergeBaseLease: GraphGenerationLease | undefined;
  return withOwnershipCleanup(async () => {
    try {
    const directory = generationLease.generationDirectory;
    const metadataPath = join(directory, "head", "metadata.json");
    const metadata = readJson(metadataPath) as Partial<PrMetadata>;
    if (!validMetadata(
      metadata,
      repositoryKey,
      securityDigest,
      headSha,
      mergeBaseSha,
      analysisKey,
    )) return null;
    const head = await readSide(
      cacheRoot,
      directory,
      "head",
      metadata.head,
      headSha,
      mergeBaseSha,
      subdir,
      signal,
    );
    const baseDirectory = finalizedGenerationDirectory(
      sharedBaseEntry(
        cacheRoot,
        repositoryKey,
        securityDigest,
        subdir,
        mergeBaseSha,
        analysisKey,
        metadata.mergeBaseVariant,
      ),
      metadata.mergeBaseGenerationId,
    );
    mergeBaseLease = await generationLifecycle.acquire(baseDirectory, {
      purpose: "cache-read",
      signal,
    });
    const base = await readSharedBaseGeneration(
      cacheRoot,
      mergeBaseLease,
      metadata.mergeBaseGenerationId,
      repositoryKey,
      securityDigest,
      mergeBaseSha,
      analysisKey,
      metadata.mergeBaseVariant,
      subdir,
      signal,
    );
    if (!head || !base) return null;
    const reviewContext: ReviewComparisonContextReference = {
      path: join(directory, "head", REVIEW_COMPARISON_CONTEXT_FILE),
      sha256: metadata.reviewContext.sha256,
      bytes: metadata.reviewContext.bytes,
    };
    const comparison = readReviewComparisonContext(reviewContext);
    if (!comparison
      || comparison.headSha !== headSha
      || comparison.mergeBaseSha !== mergeBaseSha
      || comparison.analysisKey !== analysisKey
      || !sameChangedFiles(comparison.changedFiles, metadata.changedFiles)) return null;
    return {
      generationId,
      mergeBaseGenerationId: metadata.mergeBaseGenerationId,
      headSha,
      mergeBaseSha,
      changedFiles: metadata.changedFiles,
      reviewContext,
      head,
      mergeBase: base.side,
      warnings: metadata.warnings,
    };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof OwnershipCleanupError) throw error;
      if (error instanceof WebError && error.status === 429) throw error;
      return null;
    }
  }, [async () => { await mergeBaseLease?.release(); }], "two-sided PR cache read");
}

async function readSharedBase(
  cacheRoot: string,
  entry: string,
  repositoryKey: string,
  securityDigest: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
  subdir: string | undefined,
  generationLifecycle: GraphGenerationLifecycle,
  signal: AbortSignal | undefined,
): Promise<SharedBaseSnapshot | null> {
  let generationLease: GraphGenerationLease | null = null;
  return withOwnershipCleanup(async () => {
    try {
    let generationId: string | null = null;
    generationLease = await generationLifecycle.acquireResolvedGeneration(() => {
      const active = activeGeneration(entry);
      generationId = active?.generationId ?? null;
      return active?.directory ?? null;
    }, { purpose: "cache-read", signal });
    if (!generationLease || !generationId) return null;
    const cached = await readSharedBaseGeneration(
      cacheRoot,
      generationLease,
      generationId,
      repositoryKey,
      securityDigest,
      mergeBaseSha,
      analysisKey,
      variant,
      subdir,
      signal,
    );
    if (cached) touchMetadata(join(entry, "current.json"));
    return cached;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof OwnershipCleanupError) throw error;
      if (error instanceof WebError && error.status === 429) throw error;
      return null;
    }
  }, [async () => { await generationLease?.release(); }], "merge-base cache read");
}

async function readSharedBaseGeneration(
  cacheRoot: string,
  generationLease: GraphGenerationLease,
  generationId: string,
  repositoryKey: string,
  securityDigest: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
  subdir: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SharedBaseSnapshot | null> {
  try {
    const directory = generationLease.generationDirectory;
    const metadata = readJson(join(directory, "merge-base", "metadata.json")) as Partial<BaseMetadata>;
    if (!validBaseMetadata(metadata, repositoryKey, securityDigest, mergeBaseSha, analysisKey, variant)) return null;
    const side = await readSide(
      cacheRoot,
      directory,
      "merge-base",
      metadata.side,
      mergeBaseSha,
      undefined,
      subdir,
      signal,
    );
    if (!side) return null;
    return {
      generationId,
      side,
      hintedFiles: metadata.hintedFiles,
      warnings: metadata.warnings,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof WebError && error.status === 429) throw error;
    return null;
  }
}

async function readSide(
  cacheRoot: string,
  generationDirectory: string,
  side: "head" | "merge-base",
  metadata: SideMetadata,
  expectedCommit: string,
  expectedChangedSinceBaseRef: string | undefined,
  subdir: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CachedPrSide | null> {
  const sourceRoot = resolveCacheRelativePath(cacheRoot, metadata.sourceRoot);
  const leaseMetadata = resolveCacheRelativePath(cacheRoot, metadata.leaseMetadata);
  if (!sourceRoot || !leaseMetadata || !isDirectory(sourceRoot) || !existsSync(leaseMetadata)) return null;
  const actual = requireCommit((await runGit(["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })).trim());
  if (actual !== expectedCommit
    || metadata.vcsCommit !== expectedCommit
    || metadata.changedSinceBaseRef !== expectedChangedSinceBaseRef) return null;
  const artifactPath = join(generationDirectory, side, "artifact.json");
  const projectionDirectory = join(generationDirectory, side, GRAPH_PROJECTION_DIRECTORY);
  let verifiedGeneration: VerifiedGraphGeneration;
  try {
    verifiedGeneration = await verifyExistingGraphGeneration({
      cacheRoot,
      artifactPath,
      projectionDirectory,
      artifactBytes: metadata.artifactBytes,
      artifactSha256: metadata.artifactSha256,
      projectionBytes: metadata.projectionBytes,
      projectionSha256: metadata.projectionSha256,
      projectionContentId: metadata.projectionContentId,
      graphSummary: metadata.graphSummary,
      revision: { kind: "git", commit: expectedCommit },
    }, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
  const changedSince = readGraphProjectionChangedSinceMeta(projectionDirectory);
  if (changedSince?.baseRef !== expectedChangedSinceBaseRef) return null;
  touchMetadata(sourceRoot);
  touchMetadata(leaseMetadata);
  return {
    artifactPath,
    projectionDirectory,
    graphSummary: metadata.graphSummary,
    sourceDir: sanitizeSubdir(sourceRoot, subdir),
    sourceRoot,
    sourceLease: metadata.sourceLease,
    verifiedGeneration,
  };
}

function validMetadata(
  value: Partial<PrMetadata>,
  repositoryKey: string,
  securityDigest: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
): value is PrMetadata {
  return value.formatVersion === FORMAT_VERSION
    && value.repositoryKey === repositoryKey
    && value.securityDigest === securityDigest
    && value.headSha === headSha
    && value.mergeBaseSha === mergeBaseSha
    && typeof value.creationBaseSha === "string" && COMMIT.test(value.creationBaseSha)
    && value.analysisKey === analysisKey
    && validChangedFiles(value.changedFiles)
    && validReviewContextMetadata(value.reviewContext)
    && Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string")
    && validSideMetadata(value.head)
    && typeof value.mergeBaseGenerationId === "string" && GENERATION.test(value.mergeBaseGenerationId)
    && validBaseVariant(value.mergeBaseVariant);
}

function validReviewContextMetadata(
  value: PrMetadata["reviewContext"] | undefined,
): value is PrMetadata["reviewContext"] {
  return typeof value === "object"
    && value !== null
    && /^[0-9a-f]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0;
}

function validBaseMetadata(
  value: Partial<BaseMetadata>,
  repositoryKey: string,
  securityDigest: string,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
): value is BaseMetadata {
  return value.formatVersion === FORMAT_VERSION
    && value.repositoryKey === repositoryKey
    && value.securityDigest === securityDigest
    && value.mergeBaseSha === mergeBaseSha
    && value.analysisKey === analysisKey
    && value.variant === variant
    && validSideMetadata(value.side)
    && validHintedFiles(value.hintedFiles)
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === "string");
}

function validSideMetadata(value: unknown): value is SideMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const side = value as Partial<SideMetadata>;
  return typeof side.sourceRoot === "string"
    && typeof side.leaseMetadata === "string"
    && validSourceLease(side.sourceLease)
    && validGraphSummary(side.graphSummary)
    && typeof side.projectionContentId === "string" && /^[0-9a-f]{64}$/.test(side.projectionContentId)
    && Number.isSafeInteger(side.artifactBytes) && (side.artifactBytes as number) > 0
    && typeof side.artifactSha256 === "string" && /^[0-9a-f]{64}$/.test(side.artifactSha256)
    && Number.isSafeInteger(side.projectionBytes) && (side.projectionBytes as number) > 0
    && typeof side.projectionSha256 === "string" && /^[0-9a-f]{64}$/.test(side.projectionSha256)
    && typeof side.vcsCommit === "string" && COMMIT.test(side.vcsCommit)
    && (side.changedSinceBaseRef === undefined || typeof side.changedSinceBaseRef === "string");
}

function validSourceLease(value: unknown): value is RepositorySourceLeaseReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lease = value as Partial<RepositorySourceLeaseReference>;
  return typeof lease.repositoryDigest === "string" && /^[0-9a-f]{64}$/.test(lease.repositoryDigest)
    && typeof lease.leaseId === "string" && /^[0-9a-f]{64}$/.test(lease.leaseId);
}

function validGraphSummary(value: unknown): value is GraphGenerationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<GraphGenerationSummary>;
  return typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount as number) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount as number) >= 0;
}

function sameGraphSummary(left: GraphGenerationSummary, right: GraphGenerationSummary): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.generatedAt === right.generatedAt
    && left.nodeCount === right.nodeCount
    && left.edgeCount === right.edgeCount;
}

function canonicalChangedFiles(files: readonly ChangedFileManifestEntry[]): ChangedFileManifestEntry[] {
  const normalized = normalizePrPrepareChangedFiles(files);
  if (normalized === null) throw new WebError(422, "extraction returned an invalid changed-file manifest");
  return normalized.sort((left, right) => compareCanonicalPrPreparePaths(left.path, right.path));
}

function validChangedFiles(value: unknown): value is ChangedFileManifestEntry[] {
  return normalizePrPrepareChangedFiles(value) !== null;
}

function sameChangedFiles(
  left: readonly ChangedFileManifestEntry[],
  right: readonly ChangedFileManifestEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && candidate.path === entry.path
      && candidate.status === entry.status
      && candidate.previousPath === entry.previousPath;
  });
}

function safeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
    || value.includes("\0") || Buffer.byteLength(value) > PR_PREPARE_MAX_CHANGED_PATH_BYTES
    || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function canonicalHintedFiles(files: readonly string[]): string[] {
  const canonical = [...new Set(files)].sort();
  if (!validHintedFiles(canonical)) throw new WebError(422, "extraction returned invalid file hints");
  return canonical;
}

function validHintedFiles(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every(safeManifestPath)) return false;
  return value.every((file, index) => index === 0 || value[index - 1] < file);
}

function emptyBaseVariant(hintedFiles: readonly string[]): string {
  const canonical = canonicalHintedFiles(hintedFiles);
  return `empty-${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24)}`;
}

function validBaseVariant(value: unknown): value is string {
  return value === "populated" || (typeof value === "string" && /^empty-[0-9a-f]{24}$/.test(value));
}

function activeGeneration(entry: string): { directory: string; generationId: string } | null {
  try {
    const current = readJson(join(entry, "current.json")) as Partial<PrCurrentPointer>;
    if (current.formatVersion !== CURRENT_FORMAT_VERSION || typeof current.generationId !== "string"
      || !GENERATION.test(current.generationId)) return null;
    return {
      directory: finalizedGenerationDirectory(entry, current.generationId),
      generationId: current.generationId,
    };
  } catch {
    return null;
  }
}

function prEntry(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdir: string | undefined,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
): string {
  const subdirKey = createHash("sha256").update(subdir ?? "").digest("hex").slice(0, 24);
  return prHeadArtifactEntry(
    cacheRoot,
    repositoryKey,
    securityDigest,
    subdirKey,
    headSha,
    mergeBaseSha,
    analysisKey,
  );
}

function sharedBaseEntry(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdir: string | undefined,
  mergeBaseSha: string,
  analysisKey: string,
  variant: string,
): string {
  if (!validBaseVariant(variant)) throw new WebError(500, "merge-base cache variant is invalid");
  const subdirKey = createHash("sha256").update(subdir ?? "").digest("hex").slice(0, 24);
  return prBaseArtifactEntry(
    cacheRoot,
    repositoryKey,
    securityDigest,
    subdirKey,
    mergeBaseSha,
    analysisKey,
    variant,
  );
}

function exactBaseLookupPath(
  cacheRoot: string,
  repositoryKey: string,
  securityDigest: string,
  subdir: string | undefined,
  headSha: string,
  baseSha: string,
  analysisKey: string,
): string {
  const subdirKey = createHash("sha256").update(subdir ?? "").digest("hex").slice(0, 24);
  return prExactLookupFile(
    cacheRoot,
    repositoryKey,
    securityDigest,
    subdirKey,
    headSha,
    baseSha,
    analysisKey,
  );
}

function prPreparationKey(request: PrPrepareRequest): string {
  return createHash("sha256").update(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    analysisVersion: ANALYSIS_VERSION,
    repositoryAnalysisVersion: REPOSITORY_ANALYSIS_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: generatorVersion(),
    subdir: request.subdir ?? "",
    policy: REPOSITORY_ANALYSIS_POLICY,
  })).digest("hex").slice(0, 24);
}

type ExtractionRoots =
  | { head: string; headMaterialized: false }
  | { head: string; headMaterialized: true; mergeBase: string };

function extractionRoots(headRepo: string, mergeBaseRepo: string, subdir?: string): ExtractionRoots {
  const headCandidate = lexicalExtractionSubdir(headRepo, subdir);
  const mergeBaseCandidate = lexicalExtractionSubdir(mergeBaseRepo, subdir);
  const headExists = entryExists(headCandidate);
  const mergeBaseExists = entryExists(mergeBaseCandidate);
  if (headExists) return { head: sanitizeSubdir(headRepo, subdir), headMaterialized: false };
  if (!mergeBaseExists) {
    sanitizeSubdir(headRepo, subdir);
    throw new WebError(400, "source subfolder was not found in the repository");
  }
  const mergeBase = sanitizeSubdir(mergeBaseRepo, subdir);
  return { head: materializeEmptyExtractionRoot(headRepo, subdir), headMaterialized: true, mergeBase };
}

function resolveOrMaterializeComparisonRoot(
  mergeBaseRepo: string,
  subdir?: string,
): { root: string; materialized: boolean } {
  const candidate = lexicalExtractionSubdir(mergeBaseRepo, subdir);
  return entryExists(candidate)
    ? { root: sanitizeSubdir(mergeBaseRepo, subdir), materialized: false }
    : { root: materializeEmptyExtractionRoot(mergeBaseRepo, subdir), materialized: true };
}

function materializeEmptyExtractionRoot(repoDir: string, subdir?: string): string {
  const canonicalRepoDir = sanitizeSubdir(repoDir);
  const candidate = lexicalExtractionSubdir(repoDir, subdir);
  if (entryExists(candidate)) return sanitizeSubdir(repoDir, subdir);
  let ancestor = dirname(candidate);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new WebError(400, "source subfolder was not found in the repository");
    ancestor = parent;
  }
  sanitizeSubdir(canonicalRepoDir, relative(canonicalRepoDir, ancestor));
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return sanitizeSubdir(repoDir, subdir);
}

function lexicalExtractionSubdir(repoDir: string, subdir?: string): string {
  const root = sanitizeSubdir(repoDir);
  const clean = subdir?.trim();
  const candidate = clean ? resolve(root, clean) : root;
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WebError(400, "source subfolder escapes the repository");
  }
  return candidate;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function newGenerationId(): string {
  return `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
}

function cacheRelativePath(cacheRoot: string, path: string): string {
  const root = realpathSync(cacheRoot);
  const canonical = realpathSync(path);
  const portable = relative(root, canonical).split(sep).join("/");
  if (!portable || portable === ".." || portable.startsWith("../")) {
    throw new WebError(500, "repository worktree escaped the cache root");
  }
  return portable;
}

function resolveCacheRelativePath(cacheRoot: string, portable: string): string | null {
  if (!portable || portable.includes("\\") || portable.startsWith("/")) return null;
  const parts = portable.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const root = realpathSync(cacheRoot);
  const candidate = resolve(root, ...parts);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  try {
    const canonical = realpathSync(candidate);
    return canonical === root || canonical.startsWith(root + sep) ? canonical : null;
  } catch {
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return clientAbortError();
}

function clientAbortError(): Error {
  const error = new Error("The client closed the inspection request");
  error.name = "AbortError";
  return error;
}

function coordinatorClosedError(): Error {
  const error = new Error("The PR inspection service is closing");
  error.name = "AbortError";
  return error;
}

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}
