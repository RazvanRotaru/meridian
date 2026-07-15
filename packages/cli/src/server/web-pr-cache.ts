import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCHEMA_VERSION } from "@meridian/core";
import type { ChangedFileManifestEntry } from "@meridian/core";
import {
  REPOSITORY_ANALYSIS_POLICY,
  REPOSITORY_ANALYSIS_VERSION,
} from "../repository-analysis";
import { generatorVersion } from "../version";
import {
  canonicalRepositoryUrl,
  parseGitHubSource,
  resolveExtractionSubdir,
  sanitizeSubdir,
} from "./clone";
import { runGit } from "./git-exec";
import { prepareWebCache } from "./web-cache";
import { repositoryCacheKey } from "./web-cache-checkout";
import {
  createStageDirectory,
  isDirectory,
  publishImmutable,
  readJson,
  removeEntry,
  touchMetadata,
  writePrivateJson,
} from "./web-cache-storage";
import { WebError } from "./web-error";
import type { PrPrepareRequest } from "./web-pr-request";
import { repositoryMirrorSecurityKey } from "./repository-mirror";
import type {
  RepositoryDetachedWorktreeLease,
  RepositoryMirrorStore,
  RepositoryWorktreeLease,
} from "./repository-mirror";
import type {
  ExtractionWorkerResult,
  SerializablePipelineRequest,
} from "./extraction-worker";
import type { InspectionGraphSummary } from "./inspection-snapshot-store";
import {
  GRAPH_PROJECTION_DIRECTORY,
  readGraphProjectionChangedSinceMeta,
  readGraphProjectionManifest,
} from "./graph-projection-bundle";

export type PrPrepareStage = "resolve" | "git" | "extract-head" | "extract-merge-base" | "publish";

export interface PrPrepareProgress {
  stage: PrPrepareStage;
  elapsedMs: number;
}

export type PrPrepareTimings = Partial<Record<PrPrepareStage, number>>;

const FORMAT_VERSION = 6;
const ANALYSIS_VERSION = 5;
const CURRENT_FORMAT_VERSION = 1;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GENERATION = /^[a-z0-9][a-z0-9-]{0,95}$/;
const GIT_TIMEOUT_MS = 300_000;
const MAX_CHANGED_FILES = 100_000;
const MAX_CHANGED_PATH_BYTES = 4_096;
const MAX_CHANGED_MANIFEST_PATH_BYTES = 1024 * 1024;
const MAX_VERIFIED_ARTIFACTS = 128;

const verifiedArtifacts = new Map<string, string>();

interface SideMetadata {
  sourceRoot: string;
  leaseMetadata: string;
  graphSummary: InspectionGraphSummary;
  projectionContentId: string;
  artifactBytes: number;
  artifactSha256: string;
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
  graphSummary: InspectionGraphSummary;
  sourceDir: string;
  sourceRoot: string;
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
  settled: boolean;
}

const baseFlights = new Map<string, BaseFlight>();

export interface PrPreparationInputs {
  cacheRoot: string;
  request: PrPrepareRequest;
  cwd: string;
  token?: string;
  refresh?: boolean;
  signal?: AbortSignal;
  repositoryMirrors: RepositoryMirrorStore;
  runExtraction: PrExtractionRunner;
  /** Set only by the bounded lifecycle scheduler before invoking this operation. */
  extractionAdmitted?: boolean;
  onProgress?(progress: PrPrepareProgress): void | Promise<void>;
}

export type PrExtractionRunner = (
  request: SerializablePipelineRequest,
  options: { artifactOutputPath: string; token?: string; signal?: AbortSignal; admitted?: boolean },
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
  let keepHeadLease = false;
  let mergeBaseLeaseTransferred = false;

  try {
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
            inputs.signal,
          );
      return { mergeBaseSha, entry, cached };
    });

    if (prepared.cached) {
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
    const roots = extractionRoots(headLease.worktreeDir, mergeBaseLease.worktreeDir, inputs.request.subdir);
    const generationDir = join(prepared.entry, "generations", generationId);
    const stage = createStageDirectory(join(prepared.entry, "generations"));
    const headOutput = join(stage, "head", "artifact.json");
    mkdirSync(dirname(headOutput), { recursive: true, mode: 0o700 });
    let generationPublished = false;
    let currentPublished = false;

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
          { onLeaseTransfer: () => { mergeBaseLeaseTransferred = true; } },
        ));
        head = await timed(inputs, timings, "extract-head", () => extractHead(
          inputs,
          roots.head,
          remoteUrl,
          revisions.headSha,
          prepared.mergeBaseSha,
          mergeBaseLease?.ref ?? "",
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
            mergeBaseLease?.ref ?? "",
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
              onLeaseTransfer: () => { mergeBaseLeaseTransferred = true; },
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
                mergeBaseLease?.ref ?? "",
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
                { onLeaseTransfer: () => { mergeBaseLeaseTransferred = true; } },
              ));
            },
          );
        }
      }
      await verifyWorkerOutput(
        head,
        headOutput,
        revisions.headSha,
        prepared.mergeBaseSha,
        inputs.signal,
      );
      const changedFiles = canonicalChangedFiles(head.changedFiles);
      const warnings = [...new Set([...head.warnings, ...mergeBase.warnings])];
      const metadata: PrMetadata = {
        formatVersion: FORMAT_VERSION,
        repositoryKey,
        securityDigest,
        headSha: revisions.headSha,
        creationBaseSha: revisions.baseSha,
        mergeBaseSha: prepared.mergeBaseSha,
        analysisKey,
        changedFiles,
        warnings,
        head: sideMetadata(inputs.cacheRoot, headLease, head),
        mergeBaseGenerationId: mergeBase.generationId,
        mergeBaseVariant,
      };
      writePrivateJson(join(stage, "metadata.json"), metadata);

      const published = await timed(inputs, timings, "publish", async () => {
        throwIfAborted(inputs.signal);
        if (!publishImmutable(stage, generationDir)) {
          throw new WebError(409, "PR cache generation already exists; retry");
        }
        generationPublished = true;
        const snapshot = await readCachedGeneration(
          inputs.cacheRoot,
          generationDir,
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
        writePrivateJson(join(prepared.entry, "current.json"), {
          formatVersion: CURRENT_FORMAT_VERSION,
          generationId,
        } satisfies PrCurrentPointer);
        currentPublished = true;
        // This exact-base alias only avoids mirror preparation on the next request. The canonical
        // generation/current pointer above is complete correctness state, so an alias I/O failure
        // must never turn an already-published inspection into a failed request.
        try {
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
        } catch {
          // A later request safely falls back to the mirror-backed canonical lookup.
        }
        return snapshot;
      });
      keepHeadLease = true;
      return {
        ...published,
        analysisKey,
        repositoryKey,
        securityDigest,
        baseSha: revisions.baseSha,
        cache: "miss",
        timings,
      };
    } catch (error) {
      if (generationPublished && !currentPublished) removeEntry(generationDir);
      removeEntry(stage);
      throw error;
    }
  } finally {
    if (!mergeBaseLeaseTransferred) await mergeBaseLease?.release().catch(() => undefined);
    if (!keepHeadLease) await headLease?.release().catch(() => undefined);
  }
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
): { artifactOutputPath: string; token?: string; signal?: AbortSignal; admitted?: boolean } {
  return {
    artifactOutputPath,
    ...(inputs.token ? { token: inputs.token } : {}),
    ...(signal ? { signal } : {}),
    ...(inputs.extractionAdmitted === true ? { admitted: true } : {}),
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
      inputs.signal,
    );
    if (cached) return cached;
  }

  const flightKey = `${entry}:${inputs.refresh === true ? "refresh" : "normal"}`;
  const subscription = subscribeBaseFlight(flightKey, lease, inputs.signal, async (signal) => {
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
        signal,
      );
      if (cached) {
        await lease.release().catch(() => undefined);
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
  });
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
    await Promise.allSettled([leftPending, rightPending]);
    throw error;
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function subscribeBaseFlight(
  key: string,
  lease: RepositoryDetachedWorktreeLease,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<SharedBaseSnapshot>,
): { promise: Promise<SharedBaseSnapshot>; leaseTransferred: boolean } {
  // Do not transfer a detached lease into a zero-subscriber flight. The creator may arrive here
  // already cancelled (for example while mirror preparation was completing); starting the shared
  // operation before subscription would otherwise leave it running without an owner.
  if (signal?.aborted) {
    return { promise: Promise.reject(abortReason(signal)), leaseTransferred: false };
  }
  let flight = baseFlights.get(key);
  let leaseTransferred = false;
  if (!flight) {
    leaseTransferred = true;
    const controller = new AbortController();
    const created: BaseFlight = { controller, promise: Promise.resolve(null as never), subscribers: 0, settled: false };
    created.promise = operation(controller.signal)
      .catch(async (error) => {
        await lease.release().catch(() => undefined);
        throw error;
      })
      .finally(() => {
        created.settled = true;
        if (baseFlights.get(key) === created) baseFlights.delete(key);
      });
    flight = created;
    baseFlights.set(key, created);
  }
  return { promise: subscribeToBaseFlight(flight, signal), leaseTransferred };
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
      if (flight.subscribers === 0 && !flight.settled && !flight.controller.signal.aborted) {
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
  const generationDirectory = join(entry, "generations", generationId);
  const stage = createStageDirectory(join(entry, "generations"));
  const artifactOutputPath = join(stage, "merge-base", "artifact.json");
  mkdirSync(dirname(artifactOutputPath), { recursive: true, mode: 0o700 });
  let generationPublished = false;
  let currentPublished = false;
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
    await verifyWorkerOutput(extracted, artifactOutputPath, mergeBaseSha, undefined, signal);
    const hintedFiles = canonicalHintedFiles(extracted.hintedFiles);
    writePrivateJson(join(stage, "metadata.json"), {
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
    if (!publishImmutable(stage, generationDirectory)) {
      throw new WebError(409, "merge-base cache generation already exists; retry");
    }
    generationPublished = true;
    const published = await readSharedBaseGeneration(
      inputs.cacheRoot,
      generationDirectory,
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
    writePrivateJson(join(entry, "current.json"), {
      formatVersion: CURRENT_FORMAT_VERSION,
      generationId,
    } satisfies PrCurrentPointer);
    currentPublished = true;
    return published;
  } catch (error) {
    if (generationPublished && !currentPublished) removeEntry(generationDirectory);
    removeEntry(stage);
    throw error;
  }
}

async function verifyWorkerOutput(
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
  if (!await artifactIntegrityMatches(
    artifactOutputPath,
    result.artifactBytes,
    result.artifactSha256,
    signal,
  )) {
    throw new WebError(422, "extraction returned mismatched artifact integrity metadata");
  }
  const manifest = readGraphProjectionManifest(expectedProjection);
  const changedSince = readGraphProjectionChangedSinceMeta(expectedProjection);
  if (!manifest
    || !sameGraphSummary(manifest.graphSummary, result.graphSummary)
    || manifest.header.target.vcs?.commit !== expectedCommit
    || changedSince?.baseRef !== expectedChangedSinceBaseRef) {
    throw new WebError(422, "extraction returned mismatched projection provenance");
  }
}

function sideMetadata(
  cacheRoot: string,
  lease: Pick<RepositoryWorktreeLease, "leaseId" | "worktreeDir"> | RepositoryDetachedWorktreeLease,
  extracted: ExtractionWorkerResult,
): SideMetadata {
  if (extracted.vcsCommit === undefined) {
    throw new WebError(422, "extraction omitted revision provenance");
  }
  const manifest = readGraphProjectionManifest(extracted.projectionDirectory);
  if (!manifest) throw new WebError(422, "extraction omitted its projection manifest");
  return {
    sourceRoot: cacheRelativePath(cacheRoot, lease.worktreeDir),
    leaseMetadata: cacheRelativePath(
      cacheRoot,
      join(dirname(dirname(lease.worktreeDir)), "leases", `${lease.leaseId}.json`),
    ),
    graphSummary: extracted.graphSummary,
    projectionContentId: manifest.contentId,
    artifactBytes: extracted.artifactBytes,
    artifactSha256: extracted.artifactSha256,
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
  signal: AbortSignal | undefined,
): Promise<{ mergeBaseSha: string; entry: string; cached: CachedSnapshot } | null> {
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
    const entry = prEntry(cacheRoot, repositoryKey, securityDigest, subdir, revisions.headSha, mergeBaseSha, analysisKey);
    const cached = await readCachedGeneration(
      cacheRoot,
      join(entry, "generations", pointer.generationId),
      pointer.generationId,
      repositoryKey,
      securityDigest,
      revisions.headSha,
      mergeBaseSha,
      analysisKey,
      subdir,
      signal,
      revisions.baseSha,
    );
    if (!cached) return null;
    touchMetadata(path);
    return { mergeBaseSha, entry, cached };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof WebError && error.status === 429) throw error;
    return null;
  }
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
  signal: AbortSignal | undefined,
): Promise<CachedSnapshot | null> {
  const active = activeGeneration(entry);
  if (!active) return null;
  return readCachedGeneration(
    cacheRoot,
    active.directory,
    active.generationId,
    repositoryKey,
    securityDigest,
    headSha,
    mergeBaseSha,
    analysisKey,
    subdir,
    signal,
  );
}

async function readCachedGeneration(
  cacheRoot: string,
  directory: string,
  generationId: string,
  repositoryKey: string,
  securityDigest: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
  subdir: string | undefined,
  signal: AbortSignal | undefined,
  expectedCreationBaseSha?: string,
): Promise<CachedSnapshot | null> {
  try {
    const metadata = readJson(join(directory, "metadata.json")) as Partial<PrMetadata>;
    if (!validMetadata(
      metadata,
      repositoryKey,
      securityDigest,
      headSha,
      mergeBaseSha,
      analysisKey,
      expectedCreationBaseSha,
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
    const baseDirectory = join(sharedBaseEntry(
      cacheRoot,
      repositoryKey,
      securityDigest,
      subdir,
      mergeBaseSha,
      analysisKey,
      metadata.mergeBaseVariant,
    ), "generations", metadata.mergeBaseGenerationId);
    const base = await readSharedBaseGeneration(
      cacheRoot,
      baseDirectory,
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
    touchMetadata(join(directory, "metadata.json"));
    touchMetadata(join(dirname(dirname(directory)), "current.json"));
    return {
      generationId,
      mergeBaseGenerationId: metadata.mergeBaseGenerationId,
      headSha,
      mergeBaseSha,
      changedFiles: metadata.changedFiles,
      head,
      mergeBase: base.side,
      warnings: metadata.warnings,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error instanceof WebError && error.status === 429) throw error;
    return null;
  }
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
  signal: AbortSignal | undefined,
): Promise<SharedBaseSnapshot | null> {
  const active = activeGeneration(entry);
  if (!active) return null;
  return readSharedBaseGeneration(
    cacheRoot,
    active.directory,
    active.generationId,
    repositoryKey,
    securityDigest,
    mergeBaseSha,
    analysisKey,
    variant,
    subdir,
    signal,
  );
}

async function readSharedBaseGeneration(
  cacheRoot: string,
  directory: string,
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
    const metadata = readJson(join(directory, "metadata.json")) as Partial<BaseMetadata>;
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
    touchMetadata(join(directory, "metadata.json"));
    touchMetadata(join(dirname(dirname(directory)), "current.json"));
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
  if (!await artifactIntegrityMatches(
    artifactPath,
    metadata.artifactBytes,
    metadata.artifactSha256,
    signal,
  )) return null;
  const manifest = readGraphProjectionManifest(projectionDirectory);
  const changedSince = readGraphProjectionChangedSinceMeta(projectionDirectory);
  if (!manifest
    || manifest.contentId !== metadata.projectionContentId
    || !sameGraphSummary(manifest.graphSummary, metadata.graphSummary)
    || manifest.header.target.vcs?.commit !== expectedCommit
    || changedSince?.baseRef !== expectedChangedSinceBaseRef) return null;
  touchMetadata(sourceRoot);
  touchMetadata(leaseMetadata);
  return {
    artifactPath,
    projectionDirectory,
    graphSummary: metadata.graphSummary,
    sourceDir: resolveExtractionSubdir(sourceRoot, subdir),
    sourceRoot,
  };
}

function validMetadata(
  value: Partial<PrMetadata>,
  repositoryKey: string,
  securityDigest: string,
  headSha: string,
  mergeBaseSha: string,
  analysisKey: string,
  expectedCreationBaseSha?: string,
): value is PrMetadata {
  return value.formatVersion === FORMAT_VERSION
    && value.repositoryKey === repositoryKey
    && value.securityDigest === securityDigest
    && value.headSha === headSha
    && value.mergeBaseSha === mergeBaseSha
    && typeof value.creationBaseSha === "string" && COMMIT.test(value.creationBaseSha)
    && (expectedCreationBaseSha === undefined || value.creationBaseSha === expectedCreationBaseSha)
    && value.analysisKey === analysisKey
    && validChangedFiles(value.changedFiles)
    && Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === "string")
    && validSideMetadata(value.head)
    && typeof value.mergeBaseGenerationId === "string" && GENERATION.test(value.mergeBaseGenerationId)
    && validBaseVariant(value.mergeBaseVariant);
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
    && validGraphSummary(side.graphSummary)
    && typeof side.projectionContentId === "string" && /^[0-9a-f]{64}$/.test(side.projectionContentId)
    && Number.isSafeInteger(side.artifactBytes) && (side.artifactBytes as number) > 0
    && typeof side.artifactSha256 === "string" && /^[0-9a-f]{64}$/.test(side.artifactSha256)
    && typeof side.vcsCommit === "string" && COMMIT.test(side.vcsCommit)
    && (side.changedSinceBaseRef === undefined || typeof side.changedSinceBaseRef === "string");
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  const stream = createReadStream(path, {
    highWaterMark: 64 * 1024,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function artifactIntegrityMatches(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
    const canonical = realpathSync(path);
    const stats = statSync(canonical, { bigint: true });
    if (!stats.isFile() || stats.size !== BigInt(expectedBytes)) return false;
    const key = `${canonical}\0${expectedSha256}`;
    const signature = [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(":");
    if (verifiedArtifacts.get(key) === signature) {
      verifiedArtifacts.delete(key);
      verifiedArtifacts.set(key, signature);
      return true;
    }
    if (await sha256File(canonical, signal) !== expectedSha256) {
      verifiedArtifacts.delete(key);
      return false;
    }
    verifiedArtifacts.set(key, signature);
    while (verifiedArtifacts.size > MAX_VERIFIED_ARTIFACTS) {
      const oldest = verifiedArtifacts.keys().next().value;
      if (oldest === undefined) break;
      verifiedArtifacts.delete(oldest);
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return false;
  }
}

function validGraphSummary(value: unknown): value is InspectionGraphSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Partial<InspectionGraphSummary>;
  return typeof summary.schemaVersion === "string"
    && typeof summary.generatedAt === "string"
    && Number.isSafeInteger(summary.nodeCount) && (summary.nodeCount as number) >= 0
    && Number.isSafeInteger(summary.edgeCount) && (summary.edgeCount as number) >= 0;
}

function sameGraphSummary(left: InspectionGraphSummary, right: InspectionGraphSummary): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.generatedAt === right.generatedAt
    && left.nodeCount === right.nodeCount
    && left.edgeCount === right.edgeCount;
}

function canonicalChangedFiles(files: readonly ChangedFileManifestEntry[]): ChangedFileManifestEntry[] {
  if (!validChangedFiles(files)) throw new WebError(422, "extraction returned an invalid changed-file manifest");
  return [...files]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validChangedFiles(value: unknown): value is ChangedFileManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_FILES) return false;
  const seen = new Set<string>();
  let pathBytes = 0;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const entry = raw as Partial<ChangedFileManifestEntry>;
    if (!safeManifestPath(entry.path) || seen.has(entry.path)) return false;
    pathBytes += Buffer.byteLength(entry.path);
    seen.add(entry.path);
    if (entry.status === "renamed") {
      if (!safeManifestPath(entry.previousPath) || entry.previousPath === entry.path) return false;
      pathBytes += Buffer.byteLength(entry.previousPath);
    } else if (entry.status === "added" || entry.status === "modified" || entry.status === "deleted") {
      if (entry.previousPath !== undefined) return false;
    } else return false;
    if (pathBytes > MAX_CHANGED_MANIFEST_PATH_BYTES) return false;
  }
  return true;
}

function safeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")
    || value.includes("\0") || Buffer.byteLength(value) > MAX_CHANGED_PATH_BYTES
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
    touchMetadata(join(entry, "current.json"));
    return { directory: join(entry, "generations", current.generationId), generationId: current.generationId };
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
  return join(
    cacheRoot,
    "pr-artifacts",
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
  return join(
    cacheRoot,
    "pr-base-artifacts",
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
  return join(
    cacheRoot,
    "pr-exact-lookups",
    repositoryKey,
    securityDigest,
    subdirKey,
    headSha,
    baseSha,
    analysisKey,
    "current.json",
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
  if (headExists) return { head: resolveExtractionSubdir(headRepo, subdir), headMaterialized: false };
  if (!mergeBaseExists) {
    resolveExtractionSubdir(headRepo, subdir);
    throw new WebError(400, "source subfolder was not found in the repository");
  }
  const mergeBase = resolveExtractionSubdir(mergeBaseRepo, subdir);
  return { head: materializeEmptyExtractionRoot(headRepo, subdir), headMaterialized: true, mergeBase };
}

function resolveOrMaterializeComparisonRoot(
  mergeBaseRepo: string,
  subdir?: string,
): { root: string; materialized: boolean } {
  const candidate = lexicalExtractionSubdir(mergeBaseRepo, subdir);
  return entryExists(candidate)
    ? { root: resolveExtractionSubdir(mergeBaseRepo, subdir), materialized: false }
    : { root: materializeEmptyExtractionRoot(mergeBaseRepo, subdir), materialized: true };
}

function materializeEmptyExtractionRoot(repoDir: string, subdir?: string): string {
  const canonicalRepoDir = sanitizeSubdir(repoDir);
  const candidate = lexicalExtractionSubdir(repoDir, subdir);
  if (entryExists(candidate)) return resolveExtractionSubdir(repoDir, subdir);
  let ancestor = dirname(candidate);
  while (!entryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new WebError(400, "source subfolder was not found in the repository");
    ancestor = parent;
  }
  resolveExtractionSubdir(canonicalRepoDir, relative(canonicalRepoDir, ancestor));
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return resolveExtractionSubdir(repoDir, subdir);
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

function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new WebError(422, "git returned an invalid commit id");
  return value.toLowerCase();
}
