/**
 * Durable ownership authority for immutable graph capabilities.
 *
 * A capability descriptor is intentionally tiny: it maps an opaque graph id to an artifact and a
 * source binding. Artifacts and managed checkouts are cache-root-relative; a local source instead
 * records its canonical host path plus filesystem identity and is revalidated on every acquire.
 * That makes graph projections, `/api/meta`, `/view`, and `/api/source` recoverable after a restart
 * without rebuilding process-local registries. Descriptors are published as complete directories,
 * so a reader sees either the old absence or a complete descriptor, never a partial file.
 *
 * The referenced artifact and checkout are expected to live in immutable cache generations.  All
 * paths are checked lexically and canonically: a hand-edited descriptor or a symlink cannot escape
 * the configured cache root (or escape the source checkout through its extraction subdirectory).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import type { ArtifactSource } from "./web-source";
import {
  parseRepositoryMirrorSourceRoot,
  type RepositoryMirrorStore,
  type RepositorySourceLeaseReference,
} from "./repository-mirror";
import { CacheRootLifecycleLock } from "./cache-root-lifecycle-lock";
import {
  isVerifiedGraphGeneration,
  verifyGraphGeneration,
  type GraphRevisionIdentity,
  type VerifiedGraphGeneration,
} from "./graph-generation-verifier";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import {
  MAX_REVIEW_COMPARISON_CONTEXT_BYTES,
  readReviewComparisonContext,
  type ReviewComparisonContext,
  type ReviewComparisonContextReference,
  type ReviewComparisonSide,
} from "./review-comparison-context";
import {
  inspectSyntheticCapabilitySidecar,
  syntheticCapabilitySidecarPath,
  type SyntheticCapabilitySidecar,
} from "./synthetic-capability-sidecar";
import {
  claimPathForCleanup,
  claimedPathIsCurrent,
  removeClaimedPath,
  type ClaimedPath,
} from "./claimed-path-cleanup";

const FORMAT_VERSION = 10;
const CAPABILITY_ROOT_DIRECTORY = "graph-capabilities";
const CAPABILITY_VERSION_DIRECTORY = "v1";
const CAPABILITIES_DIRECTORY = "capabilities";
const DESCRIPTOR_FILE = "descriptor.json";
const DESCRIPTOR_INTEGRITY_FILE = "descriptor.sha256";
// Artifacts are produced inside Meridian's private cache and extraction itself has no 256 MiB
// output ceiling. A lower implicit read ceiling would let analysis report success and then make
// the resulting id permanently return 404. Deployments that need a stricter policy can still set
// `maxArtifactBytes`; graph bytes are streamed and never admitted to the descriptor LRU.
const DEFAULT_MAX_ARTIFACT_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_DESCRIPTOR_BYTES = 64 * 1024;
const DEFAULT_MAX_DISK_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_READER_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_READER_RENEW_MS = 60 * 1_000;
const OWNERS_DIRECTORY = "owners";
const READERS_DIRECTORY = "readers";
const QUARANTINE_DIRECTORY = "quarantine";
const GENERATION_ROOT_EPOCH_FILE = "generation-roots.epoch.json";
const OWNER_FORMAT_VERSION = 3;
const READER_FORMAT_VERSION = 3;
const GENERATION_ROOT_EPOCH_FORMAT_VERSION = 1;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;
const SHA256 = /^[0-9a-f]{64}$/;
const PREPARED_REVIEW_HANDOFF_OWNER_ID = /^prh-v1-[0-9a-f]{64}$/;

export interface GraphCapabilityDescriptor {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly id: string;
  readonly publishedAt: string;
  /** Compact graph metadata used by `/api/meta`. */
  readonly graphSummary: GraphGenerationSummary;
  readonly artifact: {
    /** Portable, cache-root-relative path to a GraphArtifact JSON file. */
    readonly path: string;
    /** Portable path to the exact immutable projection bundle beside the artifact. */
    readonly projectionPath: string;
    /** Portable root of the shared immutable cache generation. */
    readonly generationPath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly projectionBytes: number;
    readonly projectionSha256: string;
    readonly projectionContentId: string;
    readonly sealSha256: string;
    /** Explicit immutable semantic identity; never inferred from graph id or URL. */
    readonly revision: GraphRevisionIdentity;
    /** Request provenance associated with this immutable graph response. */
    readonly vcsBranch: string | null;
  };
  readonly source: GraphCapabilitySourceDescriptor;
  /** Optional immutable, digest-bound capability metadata. Graph bytes are never embedded here. */
  readonly synthetic: GraphSyntheticCapabilityReference | null;
  /** Optional bounded comparison context, physically owned by one sealed immutable generation. */
  readonly reviewContext: GraphReviewComparisonContextReference | null;
}

export interface GraphReviewComparisonContextReference {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly side: ReviewComparisonSide;
  readonly peerGraphId: string;
  readonly generationRoot: string;
}

export type GraphCapabilitySourceDescriptor =
  | {
      readonly kind: "managed-cache";
      /** Portable, cache-root-relative path to the immutable checkout/worktree root. */
      readonly rootPath: string;
      /** Canonical relative extraction directory below `rootPath`; empty means the root itself. */
      readonly subdir: string;
      /** Original source identity used by `/view` and PR-related routes. Never contains credentials. */
      readonly metadata: Exclude<ArtifactSource, { kind: "path" }>;
      /** Durable owner for mirror worktrees; null means independently retained source storage. */
      readonly owner: RepositorySourceLeaseReference | null;
    }
  | {
      readonly kind: "external-local";
      /** Canonical absolute host directory, rebound only when its exact filesystem identity survives. */
      readonly canonicalRoot: string;
      readonly rootIdentity: { readonly dev: string; readonly ino: string };
      readonly subdir: "";
      readonly metadata: Extract<ArtifactSource, { kind: "path" }>;
      readonly owner: null;
    };

export interface GraphSyntheticExecutionTrust {
  readonly mode: "sandboxed-pr";
  readonly provenance: { readonly repository: string; readonly headSha: string };
}

export interface GraphSyntheticCapabilityReference {
  /** Cache-root-relative path to the bounded sidecar adjacent to artifact.json. */
  readonly path: string;
  readonly sha256: string;
  /** Only prepared HEAD publication may provide this authority. */
  readonly executionTrust: GraphSyntheticExecutionTrust | null;
}

export interface ResolvedGraphSyntheticCapability {
  readonly capability: SyntheticCapabilitySidecar;
  readonly executionTrust: GraphSyntheticExecutionTrust | null;
}

/** Request-scoped, digest-verified review authority resolved while both generations are pinned. */
export interface ResolvedGraphReviewComparisonContext {
  readonly context: ReviewComparisonContext;
  readonly contextId: string;
  readonly side: ReviewComparisonSide;
  readonly peerGraphId: string;
}

export interface PublishGraphCapability {
  id: string;
  /** Digest-, projection-, and revision-verified immutable generation. */
  generation: VerifiedGraphGeneration;
  vcsBranch?: string;
  /** Absolute path, or a path relative to `cacheRoot`, to an already-published checkout/worktree. */
  sourceRoot: string;
  /** Extraction directory relative to `sourceRoot`. */
  sourceSubdir?: string;
  source: ArtifactSource;
  /** Required for source rooted in a scavenged repository-mirror worktree. */
  sourceLease?: RepositorySourceLeaseReference;
  /** Explicit server-authored authority. Ordinary GitHub graphs and merge-base sides omit it. */
  syntheticExecutionTrust?: GraphSyntheticExecutionTrust;
  /** The branded sealed generation is the trust boundary for a secondary comparison root. */
  reviewContext?: {
    readonly reference: ReviewComparisonContextReference;
    readonly side: ReviewComparisonSide;
    readonly peerGraphId: string;
    readonly generation: VerifiedGraphGeneration;
  };
  /** Primarily useful for deterministic publication/tests. Defaults to the current time. */
  publishedAt?: string;
}

export interface PublishGraphCapabilityOptions {
  readonly signal?: AbortSignal;
  /**
   * Content-addressed managed-cache publishers may keep an existing descriptor whose physical
   * generation and source lease differ, but whose complete immutable graph/source semantics match.
   * Every other publisher retains exact path identity by default.
   */
  readonly idempotence?: "exact" | "managed-cache-semantic";
}

export interface GraphCapabilitySource {
  /** Canonical checkout/worktree root. */
  rootDir: string;
  /** Canonical directory source files are served relative to. */
  sourceDir: string;
  subdir: string;
  metadata: ArtifactSource;
  owner: RepositorySourceLeaseReference | null;
}

export interface GraphCapabilityHandle {
  readonly descriptor: GraphCapabilityDescriptor;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly generationDirectory: string;
  readonly source: GraphCapabilitySource;
  readonly synthetic: ResolvedGraphSyntheticCapability | null;
  readonly review: ResolvedGraphReviewComparisonContext | null;
  /** Aborts if heartbeat renewal loses the persisted reader/source ownership. */
  readonly signal: AbortSignal;
  /** Renew this exact reader pin and the capability's intrinsic idle owner. */
  renew(): Promise<void>;
  /** Idempotently release this exact reader pin. */
  release(): Promise<void>;
}

export interface GraphCapabilityBinding {
  readonly id: string;
  readonly expectedVcsCommit: string;
}

export type GraphCapabilityExternalOwnerScope = "prepared-review-handoff";

/** Reversible durable authority; never replace this with a display string or one-way digest. */
export interface GraphCapabilityExternalOwnerKey {
  readonly scope: GraphCapabilityExternalOwnerScope;
  readonly id: string;
}

export interface GraphCapabilityOwnerExpectation {
  readonly owner: GraphCapabilityExternalOwnerKey;
  readonly bindings: readonly GraphCapabilityBinding[];
  readonly retainedUntilMs: number;
}

export interface GraphCapabilityOwnerReconcileFailure {
  readonly owner: GraphCapabilityExternalOwnerKey;
  readonly error: unknown;
}

export interface GraphCapabilityOwnerReconcileResult {
  readonly retainedOwners: readonly GraphCapabilityExternalOwnerKey[];
  readonly failures: readonly GraphCapabilityOwnerReconcileFailure[];
}

interface ResolvedGraphCapabilityPaths {
  readonly descriptor: GraphCapabilityDescriptor;
  readonly descriptorDirectory: string;
  readonly touchedAt: number;
  readonly descriptorBytes: number;
  readonly artifactPath: string;
  readonly projectionDirectory: string;
  readonly generationDirectory: string;
  readonly reviewContextPath: string | null;
  readonly reviewPeerDescriptor: GraphCapabilityDescriptor | null;
  readonly source: GraphCapabilitySource;
}

export interface GraphCapabilityStoreOptions {
  cacheRoot: string;
  repositoryMirrors: Pick<RepositoryMirrorStore, "retainSource" | "releaseSource">;
  /** Optional deployment ceiling for serving a single artifact. Unlimited by default. */
  maxArtifactBytes?: number;
  /** Refuse to read a descriptor above this size. */
  maxDescriptorBytes?: number;
  /** Total descriptor + external-owner metadata retained on disk. */
  maxDiskBytes?: number;
  /** Maximum descriptor directories retained on disk, excluding active owners/readers. */
  maxEntries?: number;
  /** Intrinsic idle lifetime renewed by successful publication and reads. */
  maxIdleMs?: number;
  /** Durable reader-pin deadline. */
  readerTtlMs?: number;
  /** Heartbeat cadence for active reader handles. */
  readerRenewMs?: number;
  now?: () => number;
  /** Test seam proving root discovery and physical quarantine cleanup do not hold admission. */
  beforeGenerationRootScan?: () => Promise<void>;
  beforePhysicalCleanup?: (paths: readonly string[]) => Promise<void>;
  /** Focused transaction seam invoked immediately before each new descriptor publication. */
  beforeDescriptorPublish?: (id: string, index: number) => void;
}

export interface GraphCapabilityScavengeResult {
  readonly entries: number;
  readonly bytes: number;
  readonly removed: number;
  readonly protectedEntries: number;
}

export interface GraphCapabilityGenerationRootSnapshot {
  /** Opaque durable seqlock epoch. */
  readonly revision: string;
  /** Union consumed by immutable-generation GC. */
  readonly generationPaths: ReadonlySet<string>;
  /** Cache-root-relative immutable generations named by every surviving descriptor. */
  readonly descriptorGenerationPaths: ReadonlySet<string>;
  /** Reader pins remain roots even after their descriptor has been quarantined. */
  readonly readerGenerationPaths: ReadonlySet<string>;
}

interface GraphCapabilityGenerationRootEpoch {
  readonly formatVersion: typeof GENERATION_ROOT_EPOCH_FORMAT_VERSION;
  readonly state: "stable" | "mutating";
  readonly revision: string;
}

interface GraphCapabilityQuarantineCandidate {
  readonly path: string;
  readonly identity: BigIntStats;
  readonly descriptor: GraphCapabilityDescriptor | null;
}

interface GraphCapabilityCleanupClaim extends ClaimedPath {
  readonly sourceRelease: {
    readonly reference: RepositorySourceLeaseReference;
    readonly owner: string;
  } | null;
}

interface GraphCapabilityOwnerRecord {
  readonly formatVersion: typeof OWNER_FORMAT_VERSION;
  readonly capabilityId: string;
  readonly ownerDigest: string;
  readonly owner: GraphCapabilityExternalOwnerKey;
  readonly state: "retaining" | "active" | "releasing";
  readonly retainedUntilMs: number;
  readonly sourceLease: RepositorySourceLeaseReference | null;
  readonly sourceRootPath: string | null;
}

interface GraphCapabilityReaderRecord {
  readonly formatVersion: typeof READER_FORMAT_VERSION;
  readonly token: string;
  readonly pid: number;
  readonly capabilityId: string;
  readonly state: "active" | "releasing";
  readonly generationPaths: readonly string[];
  readonly sourceLease: RepositorySourceLeaseReference | null;
  readonly sourceRootPath: string | null;
  readonly expiresAtMs: number;
}

export class GraphCapabilityStore {
  private readonly cacheRoot: string;
  private readonly capabilitiesRoot: string;
  private readonly ownersRoot: string;
  private readonly readersRoot: string;
  private readonly quarantineRoot: string;
  private readonly generationRootEpochPath: string;
  private readonly maxArtifactBytes: number;
  private readonly maxDescriptorBytes: number;
  private readonly maxDiskBytes: number;
  private readonly maxEntries: number;
  private readonly maxIdleMs: number;
  private readonly readerTtlMs: number;
  private readonly readerRenewMs: number;
  private readonly now: () => number;
  private readonly repositoryMirrors: GraphCapabilityStoreOptions["repositoryMirrors"];
  private readonly lifecycleLock: CacheRootLifecycleLock;
  private readonly beforeGenerationRootScan: () => Promise<void>;
  private readonly beforePhysicalCleanup: (paths: readonly string[]) => Promise<void>;
  private readonly beforeDescriptorPublish: (id: string, index: number) => void;
  private activeCleanupBatch: GraphCapabilityCleanupClaim[] | null = null;

  constructor(options: GraphCapabilityStoreOptions) {
    if (!options.cacheRoot.trim()) {
      throw new TypeError("graph capability cache root is required");
    }
    if (!options.repositoryMirrors
      || typeof options.repositoryMirrors.retainSource !== "function"
      || typeof options.repositoryMirrors.releaseSource !== "function") {
      throw new TypeError("graph capability repository ownership authority is required");
    }
    const cacheRoot = resolve(options.cacheRoot);
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    this.cacheRoot = realpathSync(cacheRoot);
    const graphRoot = requirePlainDirectory(join(this.cacheRoot, CAPABILITY_ROOT_DIRECTORY), this.cacheRoot);
    const versionRoot = requirePlainDirectory(join(graphRoot, CAPABILITY_VERSION_DIRECTORY), graphRoot);
    this.capabilitiesRoot = requirePlainDirectory(join(versionRoot, CAPABILITIES_DIRECTORY), versionRoot);
    this.ownersRoot = requirePlainDirectory(join(versionRoot, OWNERS_DIRECTORY), versionRoot);
    this.readersRoot = requirePlainDirectory(join(versionRoot, READERS_DIRECTORY), versionRoot);
    this.quarantineRoot = requirePlainDirectory(join(versionRoot, QUARANTINE_DIRECTORY), versionRoot);
    this.generationRootEpochPath = join(versionRoot, GENERATION_ROOT_EPOCH_FILE);
    this.maxArtifactBytes = byteLimit(options.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, false);
    this.maxDescriptorBytes = byteLimit(options.maxDescriptorBytes, DEFAULT_MAX_DESCRIPTOR_BYTES, false);
    this.maxDiskBytes = byteLimit(options.maxDiskBytes, DEFAULT_MAX_DISK_BYTES, false);
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "entry limit");
    this.maxIdleMs = positiveInteger(options.maxIdleMs, DEFAULT_MAX_IDLE_MS, "idle lifetime");
    this.readerTtlMs = positiveInteger(options.readerTtlMs, DEFAULT_READER_TTL_MS, "reader lifetime");
    this.readerRenewMs = positiveInteger(options.readerRenewMs, DEFAULT_READER_RENEW_MS, "reader renewal interval");
    if (this.readerRenewMs >= this.readerTtlMs) {
      throw new RangeError("graph capability reader renewal interval must be shorter than its lifetime");
    }
    this.now = options.now ?? Date.now;
    this.repositoryMirrors = options.repositoryMirrors;
    this.lifecycleLock = new CacheRootLifecycleLock(this.cacheRoot);
    this.beforeGenerationRootScan = options.beforeGenerationRootScan ?? (() => Promise.resolve());
    this.beforePhysicalCleanup = options.beforePhysicalCleanup ?? (() => Promise.resolve());
    this.beforeDescriptorPublish = options.beforeDescriptorPublish ?? (() => undefined);
    this.initializeGenerationRootEpoch();
  }

  /**
   * Adopt one fully verified generation and its exact source lease. The durable source owner is
   * established before the descriptor becomes visible, so a graph id can never name a reclaimed
   * worktree. Exact publication is the default; content-addressed managed publishers may opt into
   * semantic idempotence across equivalent immutable cache generations.
   */
  async publish(
    input: PublishGraphCapability,
    options: PublishGraphCapabilityOptions = {},
  ): Promise<GraphCapabilityDescriptor> {
    return (await this.publishMany([input], options))[0]!;
  }

  /** Publish a coherent set in one exception-transactional lifecycle operation. */
  async publishMany(
    inputs: readonly PublishGraphCapability[],
    options: PublishGraphCapabilityOptions = {},
  ): Promise<readonly GraphCapabilityDescriptor[]> {
    throwIfAborted(options.signal);
    const idempotence = requirePublicationIdempotence(options.idempotence);
    const prepared = inputs.map((input) => {
      requireCapabilityId(input.id);
      return this.prepareDescriptor(input);
    });
    if (new Set(prepared.map((entry) => entry.descriptor.id)).size !== prepared.length) {
      throw new TypeError("graph capability publication ids must be unique");
    }
    return this.runLifecycleOperation(async () => {
      throwIfAborted(options.signal);
      const existing = prepared.map((entry) => this.readDescriptorFromDisk(entry.descriptor.id)?.descriptor ?? null);
      for (let index = 0; index < prepared.length; index += 1) {
        const current = existing[index];
        const candidate = prepared[index]!;
        if (current && !samePublishedTarget(current, candidate.descriptor, idempotence)) {
          throw new Error(`graph capability id '${candidate.descriptor.id}' is already bound to another target`);
        }
      }
      const retained: number[] = [];
      const published: number[] = [];
      try {
        for (let index = 0; index < prepared.length; index += 1) {
          throwIfAborted(options.signal);
          const candidate = prepared[index]!;
          if (existing[index]) continue;
          const owner = candidate.descriptor.source.owner;
          if (!owner) continue;
          await this.repositoryMirrors.retainSource(
            owner,
            candidate.sourceRoot,
            intrinsicOwner(candidate.descriptor.id),
            this.now() + this.maxIdleMs,
            { signal: options.signal },
          );
          retained.push(index);
        }
        throwIfAborted(options.signal);
        const results: GraphCapabilityDescriptor[] = [];
        for (let index = 0; index < prepared.length; index += 1) {
          throwIfAborted(options.signal);
          const candidate = prepared[index]!;
          const current = existing[index];
          if (!current) this.beforeDescriptorPublish(candidate.descriptor.id, index);
          const descriptor = current
            ?? this.publishPreparedDescriptor(candidate.descriptor, candidate.serialized);
          if (!current) published.push(index);
          else await this.retainIntrinsicSource(current, undefined, options.signal);
          this.touchDescriptorInternal(descriptor.id, this.now());
          results.push(descriptor);
        }
        await this.scavengeLocked(
          undefined,
          new Set(results.map((descriptor) => descriptor.id)),
          options.signal,
        );
        return Object.freeze(results);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const index of published.reverse()) {
          try {
            await this.quarantineCapabilityLocked(
              prepared[index]!.descriptor.id,
              prepared[index]!.descriptor,
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        for (const index of retained) {
          if (published.includes(index)) continue;
          const candidate = prepared[index]!;
          try {
            await this.repositoryMirrors.releaseSource(
              candidate.descriptor.source.owner as RepositorySourceLeaseReference,
              intrinsicOwner(candidate.descriptor.id),
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], "graph capability batch publication rollback failed");
        }
        throw error;
      }
    }, options.signal);
  }

  /**
   * Acquire one coherent graph/source capability. Every route must hold this handle until its
   * response has finished; individual artifact/source resolvers intentionally do not exist.
   */
  async acquire(
    id: string | null | undefined,
    options: { signal?: AbortSignal } = {},
  ): Promise<GraphCapabilityHandle | null> {
    if (!isGraphCapabilityId(id)) return null;
    const token = randomUUID();
    const readerOwner = readerSourceOwner(id, token);
    let paths: ResolvedGraphCapabilityPaths | null = null;
    await this.runLifecycleOperation(async () => {
      throwIfAborted(options.signal);
      const resolved = this.resolveCapabilityPathsInternal(id);
      if (!resolved) return;
      const readerSource = durableSourceOwnership(resolved.descriptor.source);
      let readerPublished = false;
      try {
        // Persist cleanup authority before acquiring the mirror owner. Reconciliation can finish
        // either half after a crash without an untracked source-retention record.
        this.writeReaderRecord({
          formatVersion: READER_FORMAT_VERSION,
          token,
          pid: process.pid,
          capabilityId: id,
          state: "active",
          generationPaths: descriptorGenerationPathsFor(resolved.descriptor),
          sourceLease: readerSource.sourceLease,
          sourceRootPath: readerSource.sourceRootPath,
          expiresAtMs: this.now() + this.readerTtlMs,
        });
        readerPublished = true;
        if (readerSource.sourceLease) {
          await this.repositoryMirrors.retainSource(
            readerSource.sourceLease,
            resolved.source.rootDir,
            readerOwner,
            this.now() + this.readerTtlMs,
            { signal: options.signal },
          );
        }
        await this.retainIntrinsicSource(resolved.descriptor, resolved.source.rootDir, options.signal);
        this.touchDescriptorInternal(id, this.now());
        paths = resolved;
      } catch (error) {
        if (readerPublished) {
          try {
            await this.releaseReaderLocked(id, token, readerSource.sourceLease, readerOwner);
          } catch (releaseError) {
            throw new AggregateError(
              [error, releaseError],
              "graph capability acquisition and reader rollback both failed",
            );
          }
        }
        throw error;
      }
    }, options.signal);
    if (!paths) return null;

    const acquired = paths as ResolvedGraphCapabilityPaths;
    let review: ResolvedGraphReviewComparisonContext | null = null;
    try {
      await verifyGraphGeneration({
        cacheRoot: this.cacheRoot,
        artifactPath: acquired.artifactPath,
        projectionDirectory: acquired.projectionDirectory,
        artifactBytes: acquired.descriptor.artifact.bytes,
        artifactSha256: acquired.descriptor.artifact.sha256,
        projectionBytes: acquired.descriptor.artifact.projectionBytes,
        projectionSha256: acquired.descriptor.artifact.projectionSha256,
        projectionContentId: acquired.descriptor.artifact.projectionContentId,
        sealSha256: acquired.descriptor.artifact.sealSha256,
        graphSummary: acquired.descriptor.graphSummary,
        revision: acquired.descriptor.artifact.revision,
      }, options.signal);
      review = this.resolveReviewForPaths(
        acquired.descriptor,
        acquired.reviewContextPath,
        acquired.reviewPeerDescriptor,
      );
      if (acquired.descriptor.reviewContext !== null && review === null) {
        throw new Error("graph review comparison context failed immutable verification");
      }
    } catch (error) {
      const primary = options.signal?.aborted ? (options.signal.reason ?? error) : error;
      const cleanupErrors: unknown[] = [];
      try {
        await this.releaseReader(id, token, acquired.source.owner, readerOwner);
      } catch (releaseError) {
        appendDistinctErrors(cleanupErrors, releaseError);
      }
      if (!options.signal?.aborted) {
        try {
          await this.runLifecycleOperation(
            () => this.quarantineCapabilityLocked(id, acquired.descriptor),
          );
        } catch (quarantineError) {
          appendDistinctErrors(cleanupErrors, quarantineError);
        }
      }
      if (cleanupErrors.length > 0) {
        const failures: unknown[] = [];
        appendDistinctErrors(failures, primary);
        for (const cleanupError of cleanupErrors) appendDistinctErrors(failures, cleanupError);
        throw new AggregateError(
          failures,
          options.signal?.aborted
            ? "graph capability verification cancellation and cleanup failed"
            : "graph capability verification and cleanup failed",
        );
      }
      if (options.signal?.aborted) throw primary;
      return null;
    }

    const synthetic = this.resolveSyntheticForPaths(acquired.descriptor, acquired.artifactPath);
    const ownership = new AbortController();
    let released = false;
    let renewing: Promise<void> | null = null;
    let releasePromise: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (released) throw new Error("graph capability reader has been released");
      ownership.signal.throwIfAborted();
      if (renewing) return renewing;
      renewing = this.runLifecycleOperation(() => this.renewReaderLocked(
        id,
        token,
        acquired,
        readerOwner,
      )).finally(() => { renewing = null; });
      return renewing;
    };
    const heartbeat = setInterval(() => {
      void renew().catch((error: unknown) => {
        if (!ownership.signal.aborted) ownership.abort(error);
      });
    }, this.readerRenewMs);
    heartbeat.unref?.();
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      released = true;
      clearInterval(heartbeat);
      const pendingRenewal = renewing;
      releasePromise = (async () => {
        const failures: unknown[] = [];
        if (pendingRenewal) {
          try {
            await pendingRenewal;
          } catch (renewalError) {
            appendDistinctErrors(failures, renewalError);
          }
        }
        try {
          await this.releaseReader(id, token, acquired.source.owner, readerOwner);
        } catch (releaseError) {
          appendDistinctErrors(failures, releaseError);
        }
        throwDistinctErrors(failures, "graph capability reader renewal and release failed");
      })();
      return releasePromise;
    };
    return Object.freeze({
      descriptor: acquired.descriptor,
      artifactPath: acquired.artifactPath,
      projectionDirectory: acquired.projectionDirectory,
      generationDirectory: acquired.generationDirectory,
      source: acquired.source,
      synthetic,
      review,
      signal: ownership.signal,
      renew,
      release,
    });
  }

  /** Retain several exact revisions as one external owner, preflighting all before mutation. */
  async retainMany(
    bindings: readonly GraphCapabilityBinding[],
    ownerInput: GraphCapabilityExternalOwnerKey,
    retainedUntilMs: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const normalized = normalizeBindings(bindings);
    const owner = normalizeExternalOwnerKey(ownerInput);
    const ownerDigest = capabilityOwnerDigest(owner);
    if (!Number.isSafeInteger(retainedUntilMs) || retainedUntilMs <= this.now()) {
      throw new RangeError("graph capability retention deadline must be in the future");
    }
    await this.runLifecycleOperation(async () => {
      throwIfAborted(options.signal);
      const resolved = this.resolveBindingsLocked(normalized);
      const previous = new Map<string, GraphCapabilityOwnerRecord | null>();
      try {
        for (const paths of resolved) {
          throwIfAborted(options.signal);
          const recordPath = this.ownerRecordPath(paths.descriptor.id, ownerDigest);
          previous.set(
            paths.descriptor.id,
            this.readOwnerRecord(recordPath, paths.descriptor.id, ownerDigest),
          );
          await this.retainOwnerBindingLocked(
            paths,
            owner,
            ownerDigest,
            retainedUntilMs,
            options.signal,
          );
        }
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const paths of [...resolved].reverse()) {
          if (!previous.has(paths.descriptor.id)) continue;
          try {
            const prior = previous.get(paths.descriptor.id) ?? null;
            if (prior) await this.restoreOwnerRecordLocked(prior);
            else await this.releaseOwnerCapabilityLocked(owner, paths.descriptor.id);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "graph capability retention and rollback both failed",
          );
        }
        throw error;
      }
    }, options.signal);
  }

  /** Release every graph/source pin for one reversible external owner. */
  async releaseOwner(
    ownerInput: GraphCapabilityExternalOwnerKey,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    throwIfAborted(options.signal);
    const owner = normalizeExternalOwnerKey(ownerInput);
    await this.runLifecycleOperation(
      () => this.releaseOwnerLocked(owner, options.signal),
      options.signal,
    );
  }

  /**
   * Make one external-owner scope exactly equal an authoritative startup snapshot. Missing and
   * partial graph pairs are repaired; absent/extra/releasing owners are released. A failed exact
   * graph pair is returned to the authority so it can delete the corresponding navigation record.
   */
  async reconcileOwners(
    scopeInput: GraphCapabilityExternalOwnerScope,
    expectations: readonly GraphCapabilityOwnerExpectation[],
    options: { signal?: AbortSignal } = {},
  ): Promise<GraphCapabilityOwnerReconcileResult> {
    throwIfAborted(options.signal);
    const scope = normalizeExternalOwnerScope(scopeInput);
    const normalized = normalizeOwnerExpectations(scope, expectations, this.now());
    return this.runLifecycleOperation(async () => {
      const expectedIds = new Set(normalized.map((expectation) => ownerKeyIdentity(expectation.owner)));
      const failures: GraphCapabilityOwnerReconcileFailure[] = [];
      const retainedOwners: GraphCapabilityExternalOwnerKey[] = [];

      for (const expectation of normalized) {
        throwIfAborted(options.signal);
        try {
          const resolved = this.resolveBindingsLocked(expectation.bindings);
          await this.reconcileOwnerLocked(expectation, resolved, options.signal);
          retainedOwners.push(expectation.owner);
        } catch (error) {
          let releaseError: unknown | null = null;
          try {
            await this.releaseOwnerLocked(expectation.owner, options.signal);
          } catch (caught) {
            releaseError = caught;
          }
          if (options.signal?.aborted) {
            if (releaseError !== null) {
              throw new AggregateError(
                [error, releaseError],
                "cancelled graph owner reconciliation and failed-pair cleanup both failed",
              );
            }
            throwIfAborted(options.signal);
          }
          if (releaseError !== null) {
            throw new AggregateError(
              [error, releaseError],
              "graph owner reconciliation and failed-pair cleanup both failed",
            );
          }
          failures.push({ owner: expectation.owner, error });
        }
      }

      const orphanOwners = uniqueOwnerKeys(this.ownerRecords()
        .map((entry) => entry.record.owner)
        .filter((owner) => owner.scope === scope && !expectedIds.has(ownerKeyIdentity(owner))));
      for (const owner of orphanOwners) {
        // Observe cancellation before beginning a new owner transition. The release itself first
        // persists `releasing`, so an abort while waiting for source admission is restart-safe.
        throwIfAborted(options.signal);
        await this.releaseOwnerLocked(owner, options.signal);
      }
      return Object.freeze({
        retainedOwners: Object.freeze(retainedOwners.map((owner) => Object.freeze({ ...owner }))),
        failures: Object.freeze(failures.map((failure) => Object.freeze({
          owner: Object.freeze({ ...failure.owner }),
          error: failure.error,
        }))),
      });
    }, options.signal);
  }

  /** Repair persisted source owners and remove dead reader records after a restart. */
  async reconcile(options: { signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal);
    const residue = this.scanQuarantineResidue(options.signal);
    await this.runLifecycleOperation(async () => {
      throwIfAborted(options.signal);
      await this.claimQuarantineResidueLocked(residue, options.signal);
      throwIfAborted(options.signal);
      await this.reconcileLocked(options.signal);
    }, options.signal);
  }

  /** Enforce descriptor TTL/LRU/count/byte bounds without evicting live owners or readers. */
  async scavenge(options: { signal?: AbortSignal } = {}): Promise<GraphCapabilityScavengeResult> {
    throwIfAborted(options.signal);
    return this.runLifecycleOperation(() => this.scavengeLocked(undefined, new Set(), options.signal), options.signal);
  }

  /**
   * Discover exact durable roots without holding lifecycle admission. A two-phase on-disk epoch
   * makes descriptor/reader mutations observable across processes and survives a writer crash in
   * the `mutating` state. Generation GC accepts the snapshot only after a final same-lock epoch
   * comparison.
   */
  async snapshotGenerationRoots(signal?: AbortSignal): Promise<GraphCapabilityGenerationRootSnapshot> {
    while (true) {
      throwIfAborted(signal);
      const before = this.readGenerationRootEpoch();
      if (!before || before.state !== "stable") {
        await this.runLifecycleOperation(() => this.stabilizeGenerationRootEpochLocked(), signal);
        continue;
      }
      await this.beforeGenerationRootScan();
      throwIfAborted(signal);
      const descriptorGenerationPaths = new Set<string>();
      for (const id of this.listDescriptorIdsInternal()) {
        const descriptor = this.readDescriptorFromDisk(id)?.descriptor;
        if (descriptor) {
          for (const path of descriptorGenerationPathsFor(descriptor)) {
            descriptorGenerationPaths.add(path);
          }
        }
      }
      const readerGenerationPaths = new Set<string>();
      const now = this.now();
      for (const reader of this.generationRootReaderRecords()) {
        if (reader.state === "active" && reader.expiresAtMs > now) {
          for (const path of reader.generationPaths) readerGenerationPaths.add(path);
        }
      }
      const after = this.readGenerationRootEpoch();
      if (!after || after.state !== "stable" || after.revision !== before.revision) continue;
      const generationPaths = new Set([
        ...descriptorGenerationPaths,
        ...readerGenerationPaths,
      ]);
      return Object.freeze({
        revision: before.revision,
        generationPaths,
        descriptorGenerationPaths,
        readerGenerationPaths,
      });
    }
  }

  /** Must be called only inside the shared cache-root lifecycle transaction. */
  generationRootSnapshotIsCurrent(snapshot: GraphCapabilityGenerationRootSnapshot): boolean {
    const epoch = this.readGenerationRootEpoch();
    return epoch?.state === "stable" && epoch.revision === snapshot.revision;
  }

  private initializeGenerationRootEpoch(): void {
    if (!existsSync(this.generationRootEpochPath)) {
      try {
        writeFileSync(
          this.generationRootEpochPath,
          `${JSON.stringify(this.newGenerationRootEpoch("stable"))}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
      }
    }
    const entry = lstatSync(this.generationRootEpochPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("graph capability generation-root epoch is unsafe");
    }
  }

  private readGenerationRootEpoch(): GraphCapabilityGenerationRootEpoch | null {
    try {
      const entry = lstatSync(this.generationRootEpochPath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > 1_024) return null;
      const value: unknown = JSON.parse(readFileSync(this.generationRootEpochPath, "utf8"));
      if (!isRecord(value) || !hasExactKeys(value, ["formatVersion", "state", "revision"])
        || value.formatVersion !== GENERATION_ROOT_EPOCH_FORMAT_VERSION
        || (value.state !== "stable" && value.state !== "mutating")
        || typeof value.revision !== "string" || !isUuid(value.revision)) return null;
      return value as unknown as GraphCapabilityGenerationRootEpoch;
    } catch {
      return null;
    }
  }

  private newGenerationRootEpoch(
    state: GraphCapabilityGenerationRootEpoch["state"],
    revision = randomUUID(),
  ): GraphCapabilityGenerationRootEpoch {
    return {
      formatVersion: GENERATION_ROOT_EPOCH_FORMAT_VERSION,
      state,
      revision,
    };
  }

  private writeGenerationRootEpoch(epoch: GraphCapabilityGenerationRootEpoch): void {
    writeAtomicJson(this.generationRootEpochPath, epoch);
  }

  private stabilizeGenerationRootEpochLocked(): void {
    const current = this.readGenerationRootEpoch();
    if (current?.state === "stable") return;
    this.writeGenerationRootEpoch(this.newGenerationRootEpoch("stable"));
  }

  private mutateGenerationRootsLocked<T>(mutation: () => T): T {
    const revision = randomUUID();
    this.writeGenerationRootEpoch(this.newGenerationRootEpoch("mutating", revision));
    try {
      const result = mutation();
      this.writeGenerationRootEpoch(this.newGenerationRootEpoch("stable", revision));
      return result;
    } catch (error) {
      try {
        this.writeGenerationRootEpoch(this.newGenerationRootEpoch("stable", revision));
      } catch (epochError) {
        throw new AggregateError(
          [error, epochError],
          "graph capability mutation and generation-root epoch repair both failed",
        );
      }
      throw error;
    }
  }

  private generationRootReaderRecords(): GraphCapabilityReaderRecord[] {
    const records: GraphCapabilityReaderRecord[] = [];
    for (const entry of safeDirectoryEntries(this.readersRoot)) {
      const match = /^([0-9a-f-]{36})\.json$/.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      const record = this.readReaderRecord(join(this.readersRoot, entry.name), match[1] as string);
      if (record) records.push(record);
    }
    return records;
  }

  private async runLifecycleOperation<T>(
    operation: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const cleanup: GraphCapabilityCleanupClaim[] = [];
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await this.lifecycleLock.runExclusive(async () => {
        if (this.activeCleanupBatch) {
          throw new Error("graph capability lifecycle operation was nested");
        }
        this.activeCleanupBatch = cleanup;
        try {
          return await operation();
        } finally {
          this.activeCleanupBatch = null;
        }
      }, signal);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (cleanup.length > 0) {
      try {
        await this.beforePhysicalCleanup(Object.freeze(cleanup.map((claim) => claim.path)));
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const claim of cleanup) {
        try {
          // A quarantined descriptor is the durable release intent. Validate its claimed inode
          // before dropping the intrinsic mirror owner; a replacement is never trusted as that
          // intent. Cleanup/release happen after lifecycle admission has been returned.
          if (claim.sourceRelease && await claimedPathIsCurrent(claim)) {
            await this.repositoryMirrors.releaseSource(
              claim.sourceRelease.reference,
              claim.sourceRelease.owner,
            );
          }
          await removeClaimedPath(claim);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (operationFailed && cleanupErrors.length > 0) {
      throw new AggregateError(
        [
          ...(operationError instanceof AggregateError ? operationError.errors : [operationError]),
          ...cleanupErrors,
        ],
        "graph capability operation and quarantine cleanup both failed",
      );
    }
    if (operationFailed) throw operationError;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "graph capability quarantine cleanup failed");
    }
    return value;
  }

  private queuePhysicalCleanupLocked(
    path: string,
    sourceRelease: GraphCapabilityCleanupClaim["sourceRelease"] = null,
  ): void {
    if (!this.activeCleanupBatch) throw new Error("graph capability cleanup escaped lifecycle operation");
    if (!isContainedPath(path, this.quarantineRoot) || path === this.quarantineRoot) {
      throw new Error("graph capability cleanup path escaped quarantine");
    }
    this.activeCleanupBatch.push(Object.freeze({
      ...claimPathForCleanup(path),
      sourceRelease,
    }));
  }

  private scanQuarantineResidue(signal?: AbortSignal): GraphCapabilityQuarantineCandidate[] {
    const candidates: GraphCapabilityQuarantineCandidate[] = [];
    for (const entry of safeDirectoryEntries(this.quarantineRoot)) {
      throwIfAborted(signal);
      const path = join(this.quarantineRoot, entry.name);
      try {
        candidates.push({
          path,
          identity: lstatSync(path, { bigint: true }),
          descriptor: this.readQuarantinedDescriptor(path),
        });
      } catch {
        // A concurrent process may already have claimed this residue.
      }
    }
    return candidates;
  }

  private async claimQuarantineResidueLocked(
    candidates: readonly GraphCapabilityQuarantineCandidate[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const candidate of candidates) {
      // A prior candidate may already be a durable cleanup claim. runLifecycleOperation drains
      // every queued claim even when this check aborts the remainder of the bounded pass.
      throwIfAborted(signal);
      let current: BigIntStats;
      try {
        current = lstatSync(candidate.path, { bigint: true });
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) continue;
        throw error;
      }
      if (!sameFileIdentity(candidate.identity, current)) continue;
      const claimed = join(this.quarantineRoot, `reconcile-${this.now()}-${randomUUID()}`);
      renameSync(candidate.path, claimed);
      const descriptor = candidate.descriptor;
      const sourceRelease = descriptor?.source.kind === "managed-cache" && descriptor.source.owner
        ? Object.freeze({
          reference: descriptor.source.owner,
          owner: intrinsicOwner(descriptor.id),
        })
        : null;
      this.queuePhysicalCleanupLocked(claimed, sourceRelease);
    }
  }

  private readQuarantinedDescriptor(directory: string): GraphCapabilityDescriptor | null {
    try {
      if (!isExactPlainDirectory(directory, this.quarantineRoot)) return null;
      const directoryBefore = lstatSync(directory, { bigint: true });
      const raw = readPlainFileNoFollow(
        join(directory, DESCRIPTOR_FILE),
        directory,
        this.maxDescriptorBytes,
      );
      const integrity = readPlainFileNoFollow(
        join(directory, DESCRIPTOR_INTEGRITY_FILE),
        directory,
        65,
      );
      const directoryAfter = lstatSync(directory, { bigint: true });
      if (!raw || !integrity || integrity.byteLength !== 65
        || !sameFileIdentity(directoryBefore, directoryAfter)) return null;
      const parsed: unknown = JSON.parse(raw.toString("utf8"));
      if (!isRecord(parsed) || typeof parsed.id !== "string" || !isGraphCapabilityId(parsed.id)) return null;
      const expected = integrity.toString("utf8");
      if (!expected.endsWith("\n") || !SHA256.test(expected.slice(0, -1))
        || descriptorDigest(parsed.id, raw) !== expected.slice(0, -1)) return null;
      return parseDescriptor(parsed, parsed.id);
    } catch {
      return null;
    }
  }

  private quarantineEntryLocked(path: string, label: string): string | null {
    if (!isContainedPath(path, this.cacheRoot) || path === this.cacheRoot) {
      throw new Error("graph capability quarantine source escaped the cache root");
    }
    let before: BigIntStats;
    try {
      before = lstatSync(path, { bigint: true });
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    const current = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(before, current)) {
      throw new Error("graph capability quarantine source changed during claim");
    }
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48) || "entry";
    const destination = join(this.quarantineRoot, `${safeLabel}-${this.now()}-${randomUUID()}`);
    renameSync(path, destination);
    this.queuePhysicalCleanupLocked(destination);
    return destination;
  }

  private prepareDescriptor(
    input: PublishGraphCapability,
  ): { descriptor: GraphCapabilityDescriptor; serialized: string; sourceRoot: string } {
    const id = requireCapabilityId(input.id);
    // Validate the unforgeable finalized-generation brand before reading any paths. A sealed
    // mutable stage intentionally has similar integrity fields, but it must never be publishable.
    if (!validStoredGeneration(input.generation)) {
      throw new TypeError("graph capability generation identity is invalid");
    }
    const artifactPath = this.relativeExistingPath(input.generation.artifactPath, "file");
    const artifactAbsolutePath = this.resolveExistingRelativePath(artifactPath, "file");
    if (!artifactAbsolutePath) {
      throw new TypeError("graph capability artifact is unavailable");
    }
    const projectionPath = this.relativeExistingPath(input.generation.projectionDirectory, "directory");
    const generationPath = this.relativeExistingPath(input.generation.generationDirectory, "directory");
    const projectionAbsolutePath = this.resolveExistingRelativePath(projectionPath, "directory");
    const generationAbsolutePath = this.resolveExistingRelativePath(generationPath, "directory");
    if (!projectionAbsolutePath || !generationAbsolutePath
      || dirname(artifactAbsolutePath) !== dirname(projectionAbsolutePath)
      || !isContainedPath(artifactAbsolutePath, generationAbsolutePath)
      || !isContainedPath(projectionAbsolutePath, generationAbsolutePath)
      || statSync(artifactAbsolutePath).size !== input.generation.artifactBytes) {
      throw new TypeError("graph capability generation identity is invalid");
    }
    const source = normalizeArtifactSource(input.source);
    if (!source) {
      throw new TypeError("graph capability source metadata is invalid");
    }
    const sourceOwner = normalizeSourceOwner(input.sourceLease);
    if (input.sourceLease !== undefined && sourceOwner === null) {
      throw new TypeError("graph capability source lease is invalid");
    }
    let sourceRoot: string;
    let sourceDescriptor: GraphCapabilitySourceDescriptor;
    if (source.kind === "path") {
      if (input.generation.revision.kind !== "content"
        || input.sourceSubdir !== undefined
        || input.sourceLease !== undefined
        || input.vcsBranch !== undefined) {
        throw new TypeError("local graph capability requires content identity and an unowned source root");
      }
      const localRoot = requireExternalLocalRoot(input.sourceRoot);
      sourceRoot = localRoot.canonicalRoot;
      sourceDescriptor = {
        kind: "external-local",
        canonicalRoot: localRoot.canonicalRoot,
        rootIdentity: localRoot.rootIdentity,
        subdir: "",
        metadata: source,
        owner: null,
      };
    } else {
      if (input.generation.revision.kind !== "git") {
        throw new TypeError("managed graph capability requires an exact Git revision");
      }
      const sourceRootPath = this.relativeExistingPath(input.sourceRoot, "directory");
      const sourceSubdir = normalizeSubdir(input.sourceSubdir);
      if (sourceSubdir === null) {
        throw new TypeError("graph capability source subdirectory is unsafe");
      }
      const resolvedSourceRoot = this.resolveExistingRelativePath(sourceRootPath, "directory");
      if (!resolvedSourceRoot || !this.resolveManagedSourceSubdir(resolvedSourceRoot, sourceSubdir)) {
        throw new TypeError("graph capability source directory is unavailable or escapes its root");
      }
      assertMirrorSourceOwner(sourceRootPath, sourceOwner);
      sourceRoot = resolvedSourceRoot;
      sourceDescriptor = {
        kind: "managed-cache",
        rootPath: sourceRootPath,
        subdir: sourceSubdir,
        metadata: source,
        owner: sourceOwner,
      };
    }
    const publishedAt = input.publishedAt ?? new Date().toISOString();
    if (!validTimestamp(publishedAt)) {
      throw new TypeError("graph capability publication time is invalid");
    }
    const graphSummary = normalizeGraphSummary(input.generation.graphSummary);
    if (!graphSummary) {
      throw new TypeError("graph capability summary is invalid");
    }
    const inspectedSidecar = inspectSyntheticCapabilitySidecar(
      syntheticCapabilitySidecarPath(artifactAbsolutePath),
    );
    let synthetic: GraphSyntheticCapabilityReference | null = null;
    if (inspectedSidecar) {
      const sidecarPath = this.relativeExistingPath(inspectedSidecar.path, "file");
      const sidecarAbsolutePath = this.resolveExistingRelativePath(sidecarPath, "file");
      if (!sidecarAbsolutePath || dirname(sidecarAbsolutePath) !== dirname(artifactAbsolutePath)) {
        throw new TypeError("graph synthetic capability is not adjacent to its artifact");
      }
      const executionTrust = input.syntheticExecutionTrust === undefined
        ? null
        : normalizeSyntheticExecutionTrust(input.syntheticExecutionTrust, source, inspectedSidecar.capability);
      if (input.syntheticExecutionTrust !== undefined && executionTrust === null) {
        throw new TypeError("graph synthetic execution trust is invalid");
      }
      synthetic = {
        path: sidecarPath,
        sha256: inspectedSidecar.sha256,
        executionTrust,
      };
    } else if (input.syntheticExecutionTrust !== undefined) {
      throw new TypeError("graph synthetic execution trust requires a valid capability sidecar");
    }
    const reviewContext = this.prepareReviewContext(input, id, generationPath);

    const descriptor = freezeDescriptor({
      formatVersion: FORMAT_VERSION,
      id,
      publishedAt,
      graphSummary,
      artifact: {
        path: artifactPath,
        projectionPath,
        generationPath,
        bytes: input.generation.artifactBytes,
        sha256: input.generation.artifactSha256,
        projectionBytes: input.generation.projectionBytes,
        projectionSha256: input.generation.projectionSha256,
        projectionContentId: input.generation.projectionContentId,
        sealSha256: input.generation.sealSha256,
        revision: input.generation.revision,
        vcsBranch: source.kind === "path" ? null : normalizeBranch(input.vcsBranch),
      },
      source: sourceDescriptor,
      synthetic,
      reviewContext,
    });
    const serialized = `${JSON.stringify(descriptor, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > this.maxDescriptorBytes) {
      throw new RangeError("graph capability descriptor is too large");
    }

    return { descriptor, serialized, sourceRoot };
  }

  private prepareReviewContext(
    input: PublishGraphCapability,
    capabilityId: string,
    primaryGenerationRoot: string,
  ): GraphReviewComparisonContextReference | null {
    const review = input.reviewContext;
    if (review === undefined) return null;
    const peerGraphId = requireCapabilityId(review.peerGraphId);
    if (peerGraphId === capabilityId || (review.side !== "head" && review.side !== "mergeBase")) {
      throw new TypeError("graph review comparison binding is invalid");
    }
    if (!validStoredGeneration(review.generation)
      || input.generation.revision.kind !== "git"
      || review.generation.revision.kind !== "git") {
      throw new TypeError("graph review comparison generations are invalid");
    }
    const path = this.relativeExistingPath(review.reference.path, "file");
    const generationRoot = this.relativeExistingPath(review.generation.generationDirectory, "directory");
    const absolutePath = this.resolveExistingRelativePath(path, "file");
    const absoluteGenerationRoot = this.resolveExistingRelativePath(generationRoot, "directory");
    if (!absolutePath || !absoluteGenerationRoot
      || !isContainedPath(absolutePath, absoluteGenerationRoot)
      || (review.side === "head" && generationRoot !== primaryGenerationRoot)) {
      throw new TypeError("graph review comparison context escaped its sealed generation");
    }
    const context = readReviewComparisonContext({
      path: absolutePath,
      sha256: review.reference.sha256,
      bytes: review.reference.bytes,
    });
    if (!context
      || review.generation.revision.commit !== context.headSha
      || review.generation.projectionContentId !== context.headContentId
      || input.generation.revision.commit !== (review.side === "head" ? context.headSha : context.mergeBaseSha)
      || input.generation.projectionContentId !== (
        review.side === "head" ? context.headContentId : context.mergeBaseContentId
      )) {
      throw new TypeError("graph review comparison context does not match its revisions");
    }
    return {
      path,
      sha256: review.reference.sha256,
      bytes: review.reference.bytes,
      side: review.side,
      peerGraphId,
      generationRoot,
    };
  }

  private publishPreparedDescriptor(
    descriptor: GraphCapabilityDescriptor,
    serialized: string,
  ): GraphCapabilityDescriptor {
    const id = descriptor.id;
    const parent = requirePlainDirectory(join(this.capabilitiesRoot, shardFor(id)), this.capabilitiesRoot);
    const destination = join(parent, id);
    const stage = mkdtempSync(join(parent, ".stage-"));
    chmodSync(stage, 0o700);
    const descriptorPath = join(stage, DESCRIPTOR_FILE);
    const integrityPath = join(stage, DESCRIPTOR_INTEGRITY_FILE);
    const descriptorSha256 = descriptorDigest(id, Buffer.from(serialized, "utf8"));
    writeFileSync(descriptorPath, serialized, { encoding: "utf8", mode: 0o600 });
    writeFileSync(integrityPath, `${descriptorSha256}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(descriptorPath, 0o400);
    chmodSync(integrityPath, 0o400);
    chmodSync(stage, 0o500);

    let moved = false;
    try {
      this.mutateGenerationRootsLocked(() => {
        renameSync(stage, destination);
        moved = true;
      });
    } catch (error) {
      if (moved) throw error;
      this.quarantineEntryLocked(stage, "descriptor-stage");
      if (!existsSync(destination)) {
        throw error;
      }
      const existing = this.readDescriptorFromDisk(id);
      // Cross-process publication is serialized by the cache-root lifecycle lock. If a directory
      // nevertheless appeared after the preflight read, accept only the exact physical target;
      // semantic reuse here could strand the candidate source owner retained above.
      if (!existing || !sameCapabilityTarget(existing.descriptor, descriptor)) {
        throw new Error(`graph capability id '${id}' is already bound to another target`);
      }
      return existing.descriptor;
    }

    return descriptor;
  }

  /** Resolve every path named by one descriptor as a single non-renewing repository read. */
  private resolveCapabilityPathsInternal(id: string | null | undefined): ResolvedGraphCapabilityPaths | null {
    if (!isGraphCapabilityId(id)) return null;
    const loaded = this.readDescriptorFromDisk(id);
    if (!loaded) return null;
    const descriptor = loaded.descriptor;
    const artifactPath = this.resolveExistingRelativePath(descriptor.artifact.path, "file");
    const projectionDirectory = this.resolveExistingRelativePath(descriptor.artifact.projectionPath, "directory");
    const generationDirectory = this.resolveExistingRelativePath(descriptor.artifact.generationPath, "directory");
    const rootDir = descriptor.source.kind === "managed-cache"
      ? this.resolveExistingRelativePath(descriptor.source.rootPath, "directory")
      : resolveExternalLocalRoot(descriptor.source);
    const reviewContext = descriptor.reviewContext === null
      ? null
      : this.resolveReviewContextReference(descriptor.reviewContext);
    const reviewPeerDescriptor = descriptor.reviewContext === null
      ? null
      : this.resolveReviewPeerDescriptor(descriptor);
    if (!artifactPath || !projectionDirectory || !generationDirectory || !rootDir
      || (descriptor.reviewContext !== null && reviewContext === null)
      || (descriptor.reviewContext !== null && reviewPeerDescriptor === null)
      || (descriptor.reviewContext?.side === "head"
        && reviewContext?.generationRoot !== generationDirectory)
      || dirname(artifactPath) !== dirname(projectionDirectory)
      || !isContainedPath(artifactPath, generationDirectory)
      || !isContainedPath(projectionDirectory, generationDirectory)
      || descriptor.artifact.bytes > this.maxArtifactBytes
      || statSync(artifactPath).size !== descriptor.artifact.bytes) return null;
    const sourceDir = descriptor.source.kind === "managed-cache"
      ? this.resolveManagedSourceSubdir(rootDir, descriptor.source.subdir)
      : rootDir;
    if (!sourceDir) return null;
    const directory = this.descriptorDirectory(id);
    return {
      descriptor,
      descriptorDirectory: directory,
      touchedAt: statSync(directory).mtimeMs,
      descriptorBytes: loaded.bytes,
      artifactPath,
      projectionDirectory,
      generationDirectory,
      reviewContextPath: reviewContext?.path ?? null,
      reviewPeerDescriptor,
      source: {
        rootDir,
        sourceDir,
        subdir: descriptor.source.subdir,
        metadata: descriptor.source.metadata,
        owner: descriptor.source.owner,
      },
    };
  }

  private resolveReviewContextReference(
    reference: GraphReviewComparisonContextReference,
  ): { path: string; generationRoot: string } | null {
    const generationRoot = this.resolveExistingRelativePath(reference.generationRoot, "directory");
    if (!generationRoot || !isSafeRelativePath(reference.path)) return null;
    try {
      const candidate = resolve(this.cacheRoot, ...reference.path.split("/"));
      const parent = realpathSync(dirname(candidate));
      const path = join(parent, parsePath(candidate).base);
      return isContainedPath(path, generationRoot) ? { path, generationRoot } : null;
    } catch {
      return null;
    }
  }

  private resolveReviewForPaths(
    descriptor: GraphCapabilityDescriptor,
    path: string | null,
    peerDescriptor: GraphCapabilityDescriptor | null,
  ): ResolvedGraphReviewComparisonContext | null {
    const reference = descriptor.reviewContext;
    if (reference === null) return null;
    if (path === null || peerDescriptor === null) return null;
    const context = readReviewComparisonContext({
      path,
      sha256: reference.sha256,
      bytes: reference.bytes,
    });
    if (!context
      || !descriptorMatchesReviewContext(descriptor, context)
      || !descriptorMatchesReviewContext(peerDescriptor, context)) return null;
    return Object.freeze({
      context,
      contextId: reference.sha256,
      side: reference.side,
      peerGraphId: reference.peerGraphId,
    });
  }

  private resolveReviewPeerDescriptor(
    descriptor: GraphCapabilityDescriptor,
  ): GraphCapabilityDescriptor | null {
    const reference = descriptor.reviewContext;
    if (reference === null) return null;
    const peer = this.readDescriptorFromDisk(reference.peerGraphId)?.descriptor ?? null;
    const peerReference = peer?.reviewContext ?? null;
    if (!peer || !peerReference
      || peerReference.side === reference.side
      || peerReference.peerGraphId !== descriptor.id
      || peerReference.path !== reference.path
      || peerReference.sha256 !== reference.sha256
      || peerReference.bytes !== reference.bytes
      || peerReference.generationRoot !== reference.generationRoot
      || (peerReference.side === "head"
        && peerReference.generationRoot !== peer.artifact.generationPath)) return null;
    return peer;
  }

  private listDescriptorIdsInternal(): string[] {
    const ids: string[] = [];
    for (const shard of readdirSync(this.capabilitiesRoot, { withFileTypes: true })) {
      if (!shard.isDirectory() || shard.isSymbolicLink()) continue;
      for (const entry of readdirSync(join(this.capabilitiesRoot, shard.name), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && isGraphCapabilityId(entry.name)) {
          ids.push(entry.name);
        }
      }
    }
    return ids.sort();
  }

  private touchDescriptorInternal(id: string, atMs: number): void {
    const at = new Date(atMs);
    utimesSync(this.descriptorDirectory(requireCapabilityId(id)), at, at);
  }

  private removeDescriptorInternal(id: string): void {
    const normalized = requireCapabilityId(id);
    this.quarantineEntryLocked(this.descriptorDirectory(normalized), `invalid-descriptor-${normalized}`);
  }

  private descriptorDirectory(id: string): string {
    const path = join(this.capabilitiesRoot, shardFor(id), id);
    if (!isContainedPath(path, this.capabilitiesRoot)) {
      throw new TypeError("graph capability id escapes the descriptor root");
    }
    return path;
  }

  private readDescriptorFromDisk(
    id: string,
  ): { descriptor: GraphCapabilityDescriptor; bytes: number } | null {
    try {
      const directory = this.descriptorDirectory(id);
      const shardDirectory = dirname(directory);
      if (!isExactPlainDirectory(shardDirectory, this.capabilitiesRoot)
        || !isExactPlainDirectory(directory, shardDirectory)) return null;
      const directoryBefore = lstatSync(directory, { bigint: true });
      const descriptorPath = join(directory, DESCRIPTOR_FILE);
      const integrityPath = join(directory, DESCRIPTOR_INTEGRITY_FILE);
      const raw = readPlainFileNoFollow(descriptorPath, directory, this.maxDescriptorBytes);
      const integrity = readPlainFileNoFollow(integrityPath, directory, 65);
      const directoryAfter = lstatSync(directory, { bigint: true });
      if (!raw || !integrity || integrity.byteLength !== 65
        || !sameFileIdentity(directoryBefore, directoryAfter)) return null;
      const expected = integrity.toString("utf8");
      if (!expected.endsWith("\n") || !SHA256.test(expected.slice(0, -1))
        || descriptorDigest(id, raw) !== expected.slice(0, -1)) return null;
      const descriptor = parseDescriptor(JSON.parse(raw.toString("utf8")), id);
      return descriptor ? { descriptor, bytes: raw.byteLength + integrity.byteLength } : null;
    } catch {
      return null;
    }
  }

  private relativeExistingPath(path: string, expected: "file" | "directory"): string {
    if (!path.trim()) {
      throw new TypeError(`graph capability ${expected} path is required`);
    }
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.cacheRoot, path);
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
    } catch {
      throw new TypeError(`graph capability ${expected} does not exist`);
    }
    if (!isContainedPath(canonical, this.cacheRoot) || canonical === this.cacheRoot) {
      throw new TypeError(`graph capability ${expected} must be inside the cache root`);
    }
    const entry = statSync(canonical);
    if (expected === "file" ? !entry.isFile() : !entry.isDirectory()) {
      throw new TypeError(`graph capability path is not a ${expected}`);
    }
    return relative(this.cacheRoot, canonical).split(sep).join("/");
  }

  private resolveExistingRelativePath(path: string, expected: "file" | "directory"): string | null {
    if (!isSafeRelativePath(path)) return null;
    try {
      const candidate = resolve(this.cacheRoot, ...path.split("/"));
      if (!isContainedPath(candidate, this.cacheRoot)) return null;
      const canonical = realpathSync(candidate);
      if (!isContainedPath(canonical, this.cacheRoot)) return null;
      const entry = statSync(canonical);
      if (expected === "file" ? !entry.isFile() : !entry.isDirectory()) return null;
      return canonical;
    } catch {
      return null;
    }
  }

  private resolveManagedSourceSubdir(rootDir: string, subdir: string): string | null {
    if (subdir !== "" && !isSafeRelativePath(subdir)) return null;
    try {
      const candidate = subdir ? resolve(rootDir, ...subdir.split("/")) : rootDir;
      if (!isContainedPath(candidate, rootDir)) return null;
      const canonical = realpathSync(candidate);
      if (!isContainedPath(canonical, rootDir) || !isContainedPath(canonical, this.cacheRoot)) return null;
      return statSync(canonical).isDirectory() ? canonical : null;
    } catch {
      return null;
    }
  }

  private async retainIntrinsicSource(
    descriptor: GraphCapabilityDescriptor,
    resolvedRoot?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (descriptor.source.kind !== "managed-cache" || !descriptor.source.owner) return;
    const rootDir = resolvedRoot
      ?? this.resolveExistingRelativePath(descriptor.source.rootPath, "directory");
    if (!rootDir) throw new Error("graph capability source root is unavailable");
    await this.repositoryMirrors.retainSource(
      descriptor.source.owner,
      rootDir,
      intrinsicOwner(descriptor.id),
      this.now() + this.maxIdleMs,
      { signal },
    );
  }

  private resolveSyntheticForPaths(
    descriptor: GraphCapabilityDescriptor,
    artifactPath: string,
  ): ResolvedGraphSyntheticCapability | null {
    const reference = descriptor.synthetic;
    if (!reference) return null;
    const sidecarPath = this.resolveExistingRelativePath(reference.path, "file");
    if (!sidecarPath
      || dirname(sidecarPath) !== dirname(artifactPath)
      || sidecarPath !== syntheticCapabilitySidecarPath(artifactPath)) return null;
    const inspected = inspectSyntheticCapabilitySidecar(sidecarPath);
    if (!inspected || inspected.sha256 !== reference.sha256) return null;
    if (reference.executionTrust !== null
      && normalizeSyntheticExecutionTrust(
        reference.executionTrust,
        descriptor.source.metadata,
        inspected.capability,
      ) === null) return null;
    return { capability: inspected.capability, executionTrust: reference.executionTrust };
  }

  private async renewReaderLocked(
    id: string,
    token: string,
    paths: ResolvedGraphCapabilityPaths,
    sourceOwner: string,
  ): Promise<void> {
    const current = this.readReaderRecord(this.readerRecordPath(token), token);
    const descriptor = this.readDescriptorFromDisk(id)?.descriptor;
    if (!current || current.capabilityId !== id || current.state !== "active" || !descriptor
      || !sameCapabilityTarget(descriptor, paths.descriptor)) {
      throw new Error("graph capability reader is no longer valid");
    }
    const expiresAtMs = this.now() + this.readerTtlMs;
    if (paths.source.owner) {
      await this.repositoryMirrors.retainSource(
        paths.source.owner,
        paths.source.rootDir,
        sourceOwner,
        expiresAtMs,
      );
    }
    this.writeReaderRecord({ ...current, expiresAtMs });
    await this.retainIntrinsicSource(descriptor, paths.source.rootDir);
    this.touchDescriptorInternal(id, this.now());
  }

  private async releaseReader(
    id: string,
    token: string,
    sourceLease: RepositorySourceLeaseReference | null,
    sourceOwner: string,
  ): Promise<void> {
    await this.runLifecycleOperation(async () => {
      await this.releaseReaderLocked(id, token, sourceLease, sourceOwner);
    });
  }

  private async releaseReaderLocked(
    id: string,
    token: string,
    sourceLease: RepositorySourceLeaseReference | null,
    sourceOwner: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const path = this.readerRecordPath(token);
    const current = this.readReaderRecord(path, token);
    if (current?.capabilityId === id && current.state !== "releasing") {
      this.writeReaderRecord({ ...current, state: "releasing" });
    }
    const retainedLease = current?.capabilityId === id ? current.sourceLease : sourceLease;
    if (retainedLease) {
      await this.repositoryMirrors.releaseSource(retainedLease, sourceOwner, { signal });
    }
    if (current?.capabilityId === id) this.removeReaderRecord(token);
  }

  private writeReaderRecord(record: GraphCapabilityReaderRecord): void {
    this.mutateGenerationRootsLocked(() => {
      writeAtomicJson(this.readerRecordPath(record.token), record);
    });
  }

  private readReaderRecord(path: string, token: string): GraphCapabilityReaderRecord | null {
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > this.maxDescriptorBytes) {
        return null;
      }
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed) || !hasExactKeys(parsed, [
        "formatVersion",
        "token",
        "pid",
        "capabilityId",
        "state",
        "generationPaths",
        "sourceLease",
        "sourceRootPath",
        "expiresAtMs",
      ])) return null;
      const value = parsed as Partial<GraphCapabilityReaderRecord>;
      if (value.formatVersion !== READER_FORMAT_VERSION
        || value.token !== token
        || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
        || !isGraphCapabilityId(value.capabilityId)
        || (value.state !== "active" && value.state !== "releasing")
        || !validGenerationPaths(value.generationPaths)
        || !validOptionalSourceOwner(value.sourceLease)
        || !validDurableSourceOwnership(value.sourceLease, value.sourceRootPath)
        || !Number.isSafeInteger(value.expiresAtMs) || (value.expiresAtMs as number) <= 0) return null;
      return { ...value, generationPaths: [...value.generationPaths] } as GraphCapabilityReaderRecord;
    } catch {
      return null;
    }
  }

  private readerRecordPath(token: string): string {
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new TypeError("graph capability reader token is invalid");
    return join(this.readersRoot, `${token}.json`);
  }

  private removeReaderRecord(token: string): void {
    this.mutateGenerationRootsLocked(() => {
      rmSync(this.readerRecordPath(token), { force: true });
    });
  }

  private resolveBindingsLocked(
    bindings: readonly GraphCapabilityBinding[],
  ): ResolvedGraphCapabilityPaths[] {
    return bindings.map((binding) => {
      const paths = this.resolveCapabilityPathsInternal(binding.id);
      if (!paths
        || paths.descriptor.artifact.revision.kind !== "git"
        || paths.descriptor.artifact.revision.commit !== binding.expectedVcsCommit) {
        throw new Error(`graph capability '${binding.id}' does not match its required revision`);
      }
      return paths;
    });
  }

  private async retainOwnerBindingLocked(
    paths: ResolvedGraphCapabilityPaths,
    owner: GraphCapabilityExternalOwnerKey,
    ownerDigest: string,
    retainedUntilMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const capabilityId = paths.descriptor.id;
    const path = this.ownerRecordPath(capabilityId, ownerDigest);
    const current = this.readOwnerRecord(path, capabilityId, ownerDigest);
    const sourceLease = paths.source.owner;
    const sourceRootPath = sourceLease && paths.descriptor.source.kind === "managed-cache"
      ? paths.descriptor.source.rootPath
      : null;
    if (current && !sameOwnerSource(current, sourceLease, sourceRootPath)) {
      await this.releaseOwnerRecordLocked(path, current, signal);
    }
    const retaining: GraphCapabilityOwnerRecord = {
      formatVersion: OWNER_FORMAT_VERSION,
      capabilityId,
      ownerDigest,
      owner,
      state: "retaining",
      retainedUntilMs,
      sourceLease,
      sourceRootPath,
    };
    // Persist complete cleanup authority before mirror retention. A crash on either side of the
    // retain call leaves a reversible record that scoped startup reconciliation can converge.
    this.writeOwnerRecord(path, retaining);
    if (sourceLease) {
      await this.repositoryMirrors.retainSource(
        sourceLease,
        paths.source.rootDir,
        externalSourceOwner(capabilityId, owner),
        retainedUntilMs,
        { signal },
      );
    }
    this.writeOwnerRecord(path, { ...retaining, state: "active" });
  }

  private async restoreOwnerRecordLocked(record: GraphCapabilityOwnerRecord): Promise<void> {
    if (record.state !== "active" || record.retainedUntilMs <= this.now()) {
      await this.releaseOwnerCapabilityLocked(record.owner, record.capabilityId);
      return;
    }
    const path = this.ownerRecordPath(record.capabilityId, record.ownerDigest);
    const current = this.readOwnerRecord(path, record.capabilityId, record.ownerDigest);
    if (current && !sameOwnerRecordSource(current, record)) {
      await this.releaseOwnerRecordLocked(path, current);
    }
    this.writeOwnerRecord(path, { ...record, state: "retaining" });
    if (record.sourceLease) {
      const rootDir = record.sourceRootPath === null
        ? null
        : this.resolveExistingRelativePath(record.sourceRootPath, "directory");
      if (!rootDir) throw new Error("graph capability owner source is unavailable during rollback");
      await this.repositoryMirrors.retainSource(
        record.sourceLease,
        rootDir,
        externalSourceOwner(record.capabilityId, record.owner),
        record.retainedUntilMs,
      );
    }
    this.writeOwnerRecord(path, { ...record, state: "active" });
  }

  private async reconcileOwnerLocked(
    expectation: GraphCapabilityOwnerExpectation,
    resolved: readonly ResolvedGraphCapabilityPaths[],
    signal?: AbortSignal,
  ): Promise<void> {
    const expectedIds = new Set(resolved.map((paths) => paths.descriptor.id));
    for (const entry of this.ownerRecords().filter(
      (candidate) => sameOwnerKey(candidate.record.owner, expectation.owner)
        && !expectedIds.has(candidate.record.capabilityId),
    )) {
      // releaseOwnerRecordLocked persists `releasing` before its abortable source-lock wait.
      throwIfAborted(signal);
      await this.releaseOwnerRecordLocked(entry.path, entry.record, signal);
    }
    const ownerDigest = capabilityOwnerDigest(expectation.owner);
    for (const paths of resolved) {
      throwIfAborted(signal);
      await this.retainOwnerBindingLocked(
        paths,
        expectation.owner,
        ownerDigest,
        expectation.retainedUntilMs,
        signal,
      );
    }
    throwIfAborted(signal);
    const active = this.ownerRecords().filter(
      (entry) => sameOwnerKey(entry.record.owner, expectation.owner),
    );
    if (active.length !== resolved.length
      || active.some((entry) => entry.record.state !== "active" || !expectedIds.has(entry.record.capabilityId))) {
      throw new Error("graph capability owner did not converge to its exact graph pair");
    }
  }

  private async releaseOwnerLocked(
    owner: GraphCapabilityExternalOwnerKey,
    signal?: AbortSignal,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of this.ownerRecords().filter(
      (candidate) => sameOwnerKey(candidate.record.owner, owner),
    )) {
      try {
        await this.releaseOwnerRecordLocked(entry.path, entry.record, signal);
      } catch (error) {
        appendDistinctErrors(errors, error);
      }
    }
    throwDistinctErrors(errors, "one or more graph capability owner records could not be released");
  }

  private async releaseOwnerCapabilityLocked(
    owner: GraphCapabilityExternalOwnerKey,
    capabilityId: string,
  ): Promise<void> {
    const ownerDigest = capabilityOwnerDigest(owner);
    const path = this.ownerRecordPath(capabilityId, ownerDigest);
    const record = this.readOwnerRecord(path, capabilityId, ownerDigest);
    if (record && sameOwnerKey(record.owner, owner)) await this.releaseOwnerRecordLocked(path, record);
  }

  private async releaseOwnerRecordLocked(
    path: string,
    record: GraphCapabilityOwnerRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (record.state !== "releasing") this.writeOwnerRecord(path, { ...record, state: "releasing" });
    if (record.sourceLease) {
      await this.repositoryMirrors.releaseSource(
        record.sourceLease,
        externalSourceOwner(record.capabilityId, record.owner),
        { signal },
      );
    }
    this.removeOwnerRecord(path);
  }

  private ownerRecordPath(id: string, ownerDigest: string): string {
    const capabilityId = requireCapabilityId(id);
    if (!SHA256.test(ownerDigest)) throw new TypeError("graph capability owner digest is invalid");
    return join(this.ownersRoot, shardFor(capabilityId), capabilityId, `${ownerDigest}.json`);
  }

  private writeOwnerRecord(path: string, record: GraphCapabilityOwnerRecord): void {
    const parent = dirname(path);
    requirePlainDirectory(dirname(parent), this.ownersRoot);
    requirePlainDirectory(parent, this.ownersRoot);
    writeAtomicJson(path, record);
  }

  private readOwnerRecord(
    path: string,
    capabilityId: string,
    ownerDigest: string,
  ): GraphCapabilityOwnerRecord | null {
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0 || entry.size > this.maxDescriptorBytes) {
        return null;
      }
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed) || !hasExactKeys(parsed, [
        "formatVersion",
        "capabilityId",
        "ownerDigest",
        "owner",
        "state",
        "retainedUntilMs",
        "sourceLease",
        "sourceRootPath",
      ])) return null;
      const value = parsed as Partial<GraphCapabilityOwnerRecord>;
      const owner = normalizeExternalOwnerKeyOrNull(value.owner);
      if (value.formatVersion !== OWNER_FORMAT_VERSION
        || value.capabilityId !== capabilityId
        || value.ownerDigest !== ownerDigest
        || !owner
        || value.ownerDigest !== capabilityOwnerDigest(owner)
        || (value.state !== "retaining" && value.state !== "active" && value.state !== "releasing")
        || !Number.isSafeInteger(value.retainedUntilMs) || (value.retainedUntilMs as number) <= 0
        || !validOptionalSourceOwner(value.sourceLease)
        || !validDurableSourceOwnership(value.sourceLease, value.sourceRootPath)) return null;
      return { ...value, owner } as GraphCapabilityOwnerRecord;
    } catch {
      return null;
    }
  }

  private removeOwnerRecord(path: string): void {
    rmSync(path, { force: true });
    removeEmptyParents(dirname(path), this.ownersRoot);
  }

  private ownerRecords(): Array<{ path: string; bytes: number; record: GraphCapabilityOwnerRecord }> {
    const records: Array<{ path: string; bytes: number; record: GraphCapabilityOwnerRecord }> = [];
    for (const shard of safeDirectoryEntries(this.ownersRoot)) {
      const shardPath = join(this.ownersRoot, shard.name);
      if (!shard.isDirectory() || shard.isSymbolicLink()) {
        this.quarantineEntryLocked(shardPath, "invalid-owner-shard");
        continue;
      }
      for (const capability of safeDirectoryEntries(shardPath)) {
        const capabilityPath = join(shardPath, capability.name);
        if (!capability.isDirectory() || capability.isSymbolicLink() || !isGraphCapabilityId(capability.name)) {
          this.quarantineEntryLocked(capabilityPath, "invalid-owner-capability");
          continue;
        }
        for (const owner of safeDirectoryEntries(capabilityPath)) {
          const path = join(capabilityPath, owner.name);
          const match = /^([0-9a-f]{64})\.json$/.exec(owner.name);
          if (!match || !owner.isFile() || owner.isSymbolicLink()) {
            this.quarantineEntryLocked(path, "invalid-owner-record");
            continue;
          }
          const record = this.readOwnerRecord(path, capability.name, match[1] as string);
          if (!record) {
            this.quarantineEntryLocked(path, "invalid-owner-record");
            continue;
          }
          records.push({ path, bytes: statSync(path).size, record });
        }
      }
    }
    return records;
  }

  private readerRecords(): Array<{ path: string; bytes: number; record: GraphCapabilityReaderRecord }> {
    const records: Array<{ path: string; bytes: number; record: GraphCapabilityReaderRecord }> = [];
    for (const entry of safeDirectoryEntries(this.readersRoot)) {
      const path = join(this.readersRoot, entry.name);
      const match = /^([0-9a-f-]{36})\.json$/.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        this.quarantineEntryLocked(path, "invalid-reader-record");
        continue;
      }
      const record = this.readReaderRecord(path, match[1] as string);
      if (!record) {
        this.quarantineEntryLocked(path, "invalid-reader-record");
        continue;
      }
      records.push({ path, bytes: statSync(path).size, record });
    }
    return records;
  }

  private async reconcileLocked(signal?: AbortSignal): Promise<void> {
    const now = this.now();
    for (const owner of this.ownerRecords()) {
      throwIfAborted(signal);
      // Prepared-review handoffs are the sole authority for this scope. Repairing their sources
      // here would let an orphan or missing worktree fail startup before handoff reconciliation can
      // release it. The immediately following scoped pass supplies the exact live owner set.
      if (owner.record.owner.scope === "prepared-review-handoff") continue;
      if (owner.record.state !== "active" || owner.record.retainedUntilMs <= now) {
        await this.releaseOwnerRecordLocked(owner.path, owner.record, signal);
        continue;
      }
      if (owner.record.sourceLease) {
        const rootDir = owner.record.sourceRootPath === null
          ? null
          : this.resolveExistingRelativePath(owner.record.sourceRootPath, "directory");
        if (!rootDir) throw new Error("retained graph capability source is unavailable during reconciliation");
        await this.repositoryMirrors.retainSource(
          owner.record.sourceLease,
          rootDir,
          externalSourceOwner(owner.record.capabilityId, owner.record.owner),
          owner.record.retainedUntilMs,
          { signal },
        );
      }
    }

    for (const reader of this.readerRecords()) {
      throwIfAborted(signal);
      const active = reader.record.state === "active" && reader.record.expiresAtMs > now;
      if (!active) {
        await this.releaseReaderLocked(
          reader.record.capabilityId,
          reader.record.token,
          reader.record.sourceLease,
          readerSourceOwner(reader.record.capabilityId, reader.record.token),
          signal,
        );
        continue;
      }
      const expiresAtMs = reader.record.expiresAtMs;
      if (reader.record.sourceLease) {
        const rootDir = reader.record.sourceRootPath === null
          ? null
          : this.resolveExistingRelativePath(reader.record.sourceRootPath, "directory");
        if (!rootDir) throw new Error("active graph capability reader source is unavailable during reconciliation");
        await this.repositoryMirrors.retainSource(
          reader.record.sourceLease,
          rootDir,
          readerSourceOwner(reader.record.capabilityId, reader.record.token),
          expiresAtMs,
          { signal },
        );
      }
      if (expiresAtMs !== reader.record.expiresAtMs) {
        this.writeReaderRecord({ ...reader.record, expiresAtMs });
      }
    }

    const protectedIds = this.protectedCapabilityIds(now);
    for (const id of this.listDescriptorIdsInternal()) {
      throwIfAborted(signal);
      const paths = this.resolveCapabilityPathsInternal(id);
      if (!paths) continue;
      if (now - paths.touchedAt < this.maxIdleMs || protectedIds.has(id)) {
        await this.retainIntrinsicSource(paths.descriptor, paths.source.rootDir, signal);
      }
    }
  }

  private async scavengeLocked(
    protectedId?: string,
    protectedBatch: ReadonlySet<string> = new Set(),
    signal?: AbortSignal,
  ): Promise<GraphCapabilityScavengeResult> {
    const now = this.now();
    const activeOwners = new Set<string>();
    let ownerBytes = 0;
    for (const owner of this.ownerRecords()) {
      throwIfAborted(signal);
      if (owner.record.state !== "active" || owner.record.retainedUntilMs <= now) {
        await this.releaseOwnerRecordLocked(owner.path, owner.record, signal);
      } else {
        activeOwners.add(owner.record.capabilityId);
        ownerBytes += owner.bytes;
      }
    }
    const activeReaders = new Set<string>();
    let readerBytes = 0;
    for (const reader of this.readerRecords()) {
      throwIfAborted(signal);
      if (reader.record.state === "active" && reader.record.expiresAtMs > now) {
        const expiresAtMs = reader.record.expiresAtMs;
        if (reader.record.sourceLease) {
          const rootDir = reader.record.sourceRootPath === null
            ? null
            : this.resolveExistingRelativePath(reader.record.sourceRootPath, "directory");
          if (!rootDir) throw new Error("active graph capability reader source is unavailable during scavenging");
          await this.repositoryMirrors.retainSource(
            reader.record.sourceLease,
            rootDir,
            readerSourceOwner(reader.record.capabilityId, reader.record.token),
            expiresAtMs,
            { signal },
          );
        }
        if (expiresAtMs !== reader.record.expiresAtMs) {
          this.writeReaderRecord({ ...reader.record, expiresAtMs });
        }
        readerBytes += reader.bytes;
        activeReaders.add(reader.record.capabilityId);
        continue;
      }
      await this.releaseReaderLocked(
        reader.record.capabilityId,
        reader.record.token,
        reader.record.sourceLease,
        readerSourceOwner(reader.record.capabilityId, reader.record.token),
        signal,
      );
    }

    const entries: Array<ResolvedGraphCapabilityPaths & { protected: boolean }> = [];
    let removed = 0;
    for (const id of this.listDescriptorIdsInternal()) {
      throwIfAborted(signal);
      const paths = this.resolveCapabilityPathsInternal(id);
      if (!paths) {
        const descriptor = this.readDescriptorFromDisk(id)?.descriptor;
        if (descriptor) await this.quarantineCapabilityLocked(id, descriptor, signal);
        else this.removeDescriptorInternal(id);
        removed += 1;
        continue;
      }
      const isProtected = id === protectedId || protectedBatch.has(id)
        || activeOwners.has(id) || activeReaders.has(id);
      if (!isProtected && now - paths.touchedAt >= this.maxIdleMs) {
        await this.quarantineCapabilityLocked(id, paths.descriptor, signal);
        removed += 1;
        continue;
      }
      entries.push({ ...paths, protected: isProtected });
    }

    entries.sort((left, right) => left.touchedAt - right.touchedAt
      || compareUtf8(left.descriptor.id, right.descriptor.id));
    let descriptorBytes = entries.reduce((sum, entry) => sum + entry.descriptorBytes, 0);
    let count = entries.length;
    for (const entry of entries) {
      throwIfAborted(signal);
      if (count <= this.maxEntries && descriptorBytes + ownerBytes + readerBytes <= this.maxDiskBytes) break;
      if (entry.protected) continue;
      await this.quarantineCapabilityLocked(entry.descriptor.id, entry.descriptor, signal);
      descriptorBytes -= entry.descriptorBytes;
      count -= 1;
      removed += 1;
    }
    removeEmptyCapabilityShards(this.capabilitiesRoot);
    return {
      entries: count,
      bytes: descriptorBytes + ownerBytes + readerBytes,
      removed,
      protectedEntries: entries.filter((entry) => entry.protected).length,
    };
  }

  private protectedCapabilityIds(now: number): Set<string> {
    const protectedIds = new Set<string>();
    for (const owner of this.ownerRecords()) {
      if (owner.record.state === "active" && owner.record.retainedUntilMs > now) {
        protectedIds.add(owner.record.capabilityId);
      }
    }
    for (const reader of this.readerRecords()) {
      if (reader.record.state === "active" && reader.record.expiresAtMs > now) {
        protectedIds.add(reader.record.capabilityId);
      }
    }
    return protectedIds;
  }

  private async quarantineCapabilityLocked(
    id: string,
    descriptor: GraphCapabilityDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    const sourceOwner = descriptor.source.kind === "managed-cache" ? descriptor.source.owner : null;
    const directory = this.descriptorDirectory(id);
    let quarantined: string | null = null;
    if (existsSync(directory)) {
      const entry = lstatSync(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory) {
        throw new Error("graph capability quarantine target is unsafe");
      }
      // The published directory is immutable (0500). Claim write permission only while holding the
      // lifecycle lock and immediately before the atomic quarantine rename.
      chmodSync(directory, 0o700);
      const destination = join(this.quarantineRoot, `${id}-${this.now()}-${randomUUID()}`);
      this.mutateGenerationRootsLocked(() => renameSync(directory, destination));
      quarantined = destination;
    }
    for (const owner of this.ownerRecords().filter((entry) => entry.record.capabilityId === id)) {
      await this.releaseOwnerRecordLocked(owner.path, owner.record, signal);
    }
    // Existing acquired readers are independent capabilities. Revocation prevents new acquisition,
    // but their exact generation/source pins remain until the handle releases or its TTL expires.
    // The quarantined descriptor durably carries the intrinsic source release intent. Execute it
    // with identity-bound physical cleanup after returning cache-root lifecycle admission.
    if (quarantined) {
      this.queuePhysicalCleanupLocked(quarantined, sourceOwner
        ? Object.freeze({ reference: sourceOwner, owner: intrinsicOwner(id) })
        : null);
    }
  }

}

function descriptorDigest(id: string, bytes: Buffer): string {
  return createHash("sha256").update(id).update("\0").update(bytes).digest("hex");
}

function isExactPlainDirectory(path: string, parent: string): boolean {
  try {
    if (dirname(path) !== parent) return false;
    const entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function readPlainFileNoFollow(path: string, expectedParent: string, maxBytes: number): Buffer | null {
  if (dirname(path) !== expectedParent) return null;
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink()
      || pathBefore.size <= 0n || pathBefore.size > BigInt(maxBytes)) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorBefore = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(pathBefore, descriptorBefore)) return null;
    const bytes = readFileSync(fd);
    const descriptorAfter = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (bytes.byteLength > maxBytes
      || !sameFileIdentity(descriptorBefore, descriptorAfter)
      || !sameFileIdentity(descriptorAfter, pathAfter)) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function intrinsicOwner(id: string): string {
  return `capability:${id}`;
}

function readerSourceOwner(id: string, token: string): string {
  return `reader:${id}:${token}`;
}

function externalSourceOwner(id: string, owner: GraphCapabilityExternalOwnerKey): string {
  return `capability-owner:${owner.scope}:${owner.id}:${id}`;
}

function capabilityOwnerDigest(owner: GraphCapabilityExternalOwnerKey): string {
  return createHash("sha256").update(JSON.stringify([owner.scope, owner.id])).digest("hex");
}

function normalizeExternalOwnerScope(value: unknown): GraphCapabilityExternalOwnerScope {
  if (value !== "prepared-review-handoff") {
    throw new TypeError("graph capability external owner scope is invalid");
  }
  return value;
}

function normalizeExternalOwnerKey(value: unknown): GraphCapabilityExternalOwnerKey {
  if (!isRecord(value)) throw new TypeError("graph capability external owner is invalid");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("scope") || !keys.includes("id")) {
    throw new TypeError("graph capability external owner is invalid");
  }
  const scope = normalizeExternalOwnerScope(value.scope);
  if (scope === "prepared-review-handoff"
    && (typeof value.id !== "string" || !PREPARED_REVIEW_HANDOFF_OWNER_ID.test(value.id))) {
    throw new TypeError("prepared-review graph owner id is invalid");
  }
  return Object.freeze({ scope, id: value.id as string });
}

function normalizeExternalOwnerKeyOrNull(value: unknown): GraphCapabilityExternalOwnerKey | null {
  try {
    return normalizeExternalOwnerKey(value);
  } catch {
    return null;
  }
}

function normalizeOwnerExpectations(
  scope: GraphCapabilityExternalOwnerScope,
  expectations: readonly GraphCapabilityOwnerExpectation[],
  now: number,
): GraphCapabilityOwnerExpectation[] {
  if (!Array.isArray(expectations)) throw new TypeError("graph capability owner expectations are invalid");
  const seen = new Set<string>();
  return expectations.map((expectation) => {
    if (!isRecord(expectation)) throw new TypeError("graph capability owner expectation is invalid");
    const owner = normalizeExternalOwnerKey(expectation.owner);
    if (owner.scope !== scope) throw new TypeError("graph capability owner expectation has the wrong scope");
    const identity = ownerKeyIdentity(owner);
    if (seen.has(identity)) throw new TypeError("graph capability owner expectation is duplicated");
    seen.add(identity);
    const bindings = normalizeBindings(expectation.bindings as readonly GraphCapabilityBinding[]);
    const retainedUntilMs = expectation.retainedUntilMs;
    if (typeof retainedUntilMs !== "number"
      || !Number.isSafeInteger(retainedUntilMs)
      || retainedUntilMs <= now) {
      throw new RangeError("graph capability owner retention deadline must be in the future");
    }
    return Object.freeze({ owner, bindings, retainedUntilMs });
  }).sort((left, right) => compareUtf8(ownerKeyIdentity(left.owner), ownerKeyIdentity(right.owner)));
}

function ownerKeyIdentity(owner: GraphCapabilityExternalOwnerKey): string {
  return `${owner.scope}\0${owner.id}`;
}

function sameOwnerKey(
  left: GraphCapabilityExternalOwnerKey,
  right: GraphCapabilityExternalOwnerKey,
): boolean {
  return left.scope === right.scope && left.id === right.id;
}

function uniqueOwnerKeys(owners: readonly GraphCapabilityExternalOwnerKey[]): GraphCapabilityExternalOwnerKey[] {
  const unique = new Map<string, GraphCapabilityExternalOwnerKey>();
  for (const owner of owners) unique.set(ownerKeyIdentity(owner), owner);
  return [...unique.values()].sort((left, right) => (
    compareUtf8(ownerKeyIdentity(left), ownerKeyIdentity(right))
  ));
}

function sameOwnerSource(
  record: GraphCapabilityOwnerRecord,
  sourceLease: RepositorySourceLeaseReference | null,
  sourceRootPath: string | null,
): boolean {
  return sameSourceLease(record.sourceLease, sourceLease) && record.sourceRootPath === sourceRootPath;
}

function sameOwnerRecordSource(
  left: GraphCapabilityOwnerRecord,
  right: GraphCapabilityOwnerRecord,
): boolean {
  return sameSourceLease(left.sourceLease, right.sourceLease)
    && left.sourceRootPath === right.sourceRootPath;
}

function sameSourceLease(
  left: RepositorySourceLeaseReference | null,
  right: RepositorySourceLeaseReference | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.repositoryDigest === right.repositoryDigest
      && left.leaseId === right.leaseId;
}

function normalizeBindings(bindings: readonly GraphCapabilityBinding[]): GraphCapabilityBinding[] {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new TypeError("at least one graph capability binding is required");
  }
  const byId = new Map<string, string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") throw new TypeError("graph capability binding is invalid");
    const id = requireCapabilityId(binding.id);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(binding.expectedVcsCommit)) {
      throw new TypeError("graph capability binding revision is invalid");
    }
    const existing = byId.get(id);
    if (existing && existing !== binding.expectedVcsCommit) {
      throw new TypeError(`graph capability '${id}' has conflicting revision requirements`);
    }
    byId.set(id, binding.expectedVcsCommit);
  }
  return [...byId].sort(([left], [right]) => compareUtf8(left, right))
    .map(([id, expectedVcsCommit]) => ({ id, expectedVcsCommit }));
}

function validOptionalSourceOwner(value: unknown): value is RepositorySourceLeaseReference | null {
  return value === null || parseSourceOwner(value) !== null;
}

function durableSourceOwnership(source: GraphCapabilitySourceDescriptor): {
  sourceLease: RepositorySourceLeaseReference | null;
  sourceRootPath: string | null;
} {
  return source.kind === "managed-cache" && source.owner
    ? { sourceLease: source.owner, sourceRootPath: source.rootPath }
    : { sourceLease: null, sourceRootPath: null };
}

function descriptorMatchesReviewContext(
  descriptor: GraphCapabilityDescriptor,
  context: ReviewComparisonContext,
): boolean {
  const reference = descriptor.reviewContext;
  if (reference === null || descriptor.artifact.revision.kind !== "git") return false;
  const expectedCommit = reference.side === "head" ? context.headSha : context.mergeBaseSha;
  const expectedContentId = reference.side === "head"
    ? context.headContentId
    : context.mergeBaseContentId;
  return descriptor.artifact.revision.commit === expectedCommit
    && descriptor.artifact.projectionContentId === expectedContentId;
}

function validDurableSourceOwnership(
  sourceLease: unknown,
  sourceRootPath: unknown,
): boolean {
  return sourceLease === null
    ? sourceRootPath === null
    : parseSourceOwner(sourceLease) !== null && isSafeRelativePath(sourceRootPath);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective <= 0) {
    throw new RangeError(`graph capability ${label} must be a positive safe integer`);
  }
  return effective;
}

function appendDistinctErrors(target: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendDistinctErrors(target, nested);
    return;
  }
  if (!target.includes(error)) target.push(error);
}

function throwDistinctErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("graph capability operation aborted");
  error.name = "AbortError";
  throw error;
}

function writeAtomicJson(path: string, value: unknown): void {
  const parent = dirname(path);
  const stage = join(parent, `.stage-${randomUUID()}`);
  try {
    writeFileSync(stage, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(stage, path);
  } finally {
    rmSync(stage, { force: true });
  }
}

function safeDirectoryEntries(path: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function removeEmptyParents(start: string, root: string): void {
  let current = start;
  while (current !== root && isContainedPath(current, root)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmSync(current, { recursive: false });
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function removeEmptyCapabilityShards(root: string): void {
  for (const entry of safeDirectoryEntries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      if (readdirSync(path).length === 0) rmSync(path, { recursive: false });
    } catch {
      // A concurrent publisher may have populated it between enumeration and removal.
    }
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function descriptorGenerationPathsFor(descriptor: GraphCapabilityDescriptor): readonly string[] {
  return Object.freeze([...new Set([
    descriptor.artifact.generationPath,
    ...(descriptor.reviewContext ? [descriptor.reviewContext.generationRoot] : []),
  ])].sort(compareUtf8));
}

function validGenerationPaths(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 2
    && value.every((path) => typeof path === "string" && isSafeRelativePath(path))
    && value.every((path, index) => index === 0 || compareUtf8(value[index - 1], path) < 0);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** Opaque ids become directory names, so the accepted alphabet intentionally excludes separators. */
export function isGraphCapabilityId(value: string | null | undefined): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function requireCapabilityId(value: string): string {
  if (!isGraphCapabilityId(value)) {
    throw new TypeError("graph capability id must be 1-128 URL-safe opaque characters");
  }
  return value;
}

function shardFor(id: string): string {
  return id.slice(0, 2).padEnd(2, "_");
}

function byteLimit(value: number | undefined, fallback: number, allowZero: boolean): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective < (allowZero ? 0 : 1)) {
    throw new RangeError("graph capability byte limits must be safe positive integers");
  }
  return effective;
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function normalizeBranch(value: string | undefined): string | null {
  if (value === undefined) return null;
  const branch = value.trim();
  if (!branch || branch.length > 1_024 || branch.includes("\0")) {
    throw new TypeError("graph capability branch provenance is invalid");
  }
  return branch;
}

function normalizeSubdir(value: string | undefined): string | null {
  if (value === undefined || value === "") return "";
  if (value.includes("\0")) return null;
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("/") || WINDOWS_ABSOLUTE.test(portable)) return null;
  const parts = portable.split("/");
  if (parts.includes("..")) return null;
  return parts.filter((part) => part.length > 0 && part !== ".").join("/");
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || WINDOWS_ABSOLUTE.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isContainedPath(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function validCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value)
    && resolve(value) === value;
}

function requireExternalLocalRoot(path: string): {
  canonicalRoot: string;
  rootIdentity: { dev: string; ino: string };
} {
  if (!validCanonicalAbsolutePath(path)) {
    throw new TypeError("local graph capability source root must be an absolute directory");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(path);
  } catch {
    throw new TypeError("local graph capability source root is unavailable");
  }
  if (!validCanonicalAbsolutePath(canonicalRoot)) {
    throw new TypeError("local graph capability source root is invalid");
  }
  const filesystemRoot = parsePath(canonicalRoot).root;
  let cursor = filesystemRoot;
  const components = relative(filesystemRoot, canonicalRoot).split(sep).filter(Boolean);
  try {
    const rootEntry = lstatSync(cursor, { bigint: true });
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("unsafe root");
    for (const component of components) {
      cursor = join(cursor, component);
      const entry = lstatSync(cursor, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe component");
    }
    if (cursor !== canonicalRoot || realpathSync(canonicalRoot) !== canonicalRoot) {
      throw new Error("non-canonical source root");
    }
    const identity = lstatSync(canonicalRoot, { bigint: true });
    return {
      canonicalRoot,
      rootIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
    };
  } catch {
    throw new TypeError("local graph capability source root contains an unsafe path component");
  }
}

function resolveExternalLocalRoot(
  source: Extract<GraphCapabilitySourceDescriptor, { kind: "external-local" }>,
): string | null {
  try {
    const resolved = requireExternalLocalRoot(source.canonicalRoot);
    return resolved.canonicalRoot === source.canonicalRoot
      && resolved.rootIdentity.dev === source.rootIdentity.dev
      && resolved.rootIdentity.ino === source.rootIdentity.ino
      ? resolved.canonicalRoot
      : null;
  } catch {
    return null;
  }
}

/** Create/read one resolver-owned directory without following an injected directory symlink. */
function requirePlainDirectory(path: string, root: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new TypeError("graph capability descriptor path is not a private directory");
  }
  const canonical = realpathSync(path);
  if (!isContainedPath(canonical, root)) {
    throw new TypeError("graph capability descriptor path escapes the cache root");
  }
  return canonical;
}

function normalizeArtifactSource(value: ArtifactSource): ArtifactSource | null {
  if (value.kind === "path") return { kind: "path" };
  if (value.kind === "other") return { kind: "other" };
  if (value.kind !== "github" || !safeSourcePart(value.owner) || !safeSourcePart(value.repo)) return null;
  const subdir = normalizeSubdir(value.subdir);
  if (subdir === null) return null;
  return {
    kind: "github",
    owner: value.owner,
    repo: value.repo,
    ...(subdir ? { subdir } : {}),
  };
}

function safeSourcePart(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\0/\\]/.test(value) && value !== "." && value !== "..";
}

function normalizeSourceOwner(
  value: RepositorySourceLeaseReference | undefined,
): RepositorySourceLeaseReference | null {
  return value === undefined ? null : parseSourceOwner(value);
}

function parseSourceOwner(value: unknown): RepositorySourceLeaseReference | null {
  if (value === null) return null;
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.repositoryDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.repositoryDigest)
    || typeof value.leaseId !== "string"
    || !/^[0-9a-f]{64}$/.test(value.leaseId)) return null;
  return { repositoryDigest: value.repositoryDigest, leaseId: value.leaseId };
}

function parseDescriptor(value: unknown, expectedId: string): GraphCapabilityDescriptor | null {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "formatVersion",
      "id",
      "publishedAt",
      "graphSummary",
      "artifact",
      "source",
      "synthetic",
      "reviewContext",
    ])
    || value.formatVersion !== FORMAT_VERSION
    || value.id !== expectedId) return null;
  if (typeof value.publishedAt !== "string" || !validTimestamp(value.publishedAt)) return null;
  const graphSummary = normalizeGraphSummary(value.graphSummary);
  if (!graphSummary) return null;
  if (!isRecord(value.artifact)
    || Object.keys(value.artifact).length !== 11
    || !isSafeRelativePath(value.artifact.path)
    || !isSafeRelativePath(value.artifact.projectionPath)
    || !isSafeRelativePath(value.artifact.generationPath)
    || !Number.isSafeInteger(value.artifact.bytes) || (value.artifact.bytes as number) <= 0
    || typeof value.artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.artifact.sha256)
    || !Number.isSafeInteger(value.artifact.projectionBytes) || (value.artifact.projectionBytes as number) <= 0
    || typeof value.artifact.projectionSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.artifact.projectionSha256)
    || typeof value.artifact.projectionContentId !== "string"
    || !/^[0-9a-f]{64}$/.test(value.artifact.projectionContentId)
    || typeof value.artifact.sealSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.artifact.sealSha256)
    || !validGraphRevision(value.artifact.revision)) return null;
  if (value.artifact.vcsBranch !== null && typeof value.artifact.vcsBranch !== "string") return null;
  if (typeof value.artifact.vcsBranch === "string"
    && normalizeBranch(value.artifact.vcsBranch) !== value.artifact.vcsBranch) return null;
  const source = parseCapabilitySourceDescriptor(value.source, value.artifact.revision);
  if (!source) return null;
  const metadata = source.metadata;
  const synthetic = parseSyntheticCapabilityReference(value.synthetic, metadata);
  if (value.synthetic !== null && synthetic === null) return null;
  const reviewContext = parseReviewContextReference(value.reviewContext, expectedId);
  if (value.reviewContext !== null && reviewContext === null) return null;
  return freezeDescriptor({
    formatVersion: value.formatVersion,
    id: expectedId,
    publishedAt: value.publishedAt,
    graphSummary,
    artifact: {
      path: value.artifact.path,
      projectionPath: value.artifact.projectionPath,
      generationPath: value.artifact.generationPath,
      bytes: value.artifact.bytes as number,
      sha256: value.artifact.sha256,
      projectionBytes: value.artifact.projectionBytes as number,
      projectionSha256: value.artifact.projectionSha256,
      projectionContentId: value.artifact.projectionContentId,
      sealSha256: value.artifact.sealSha256,
      revision: value.artifact.revision,
      vcsBranch: value.artifact.vcsBranch,
    },
    source,
    synthetic,
    reviewContext,
  });
}

function parseReviewContextReference(
  value: unknown,
  capabilityId: string,
): GraphReviewComparisonContextReference | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "path",
    "sha256",
    "bytes",
    "side",
    "peerGraphId",
    "generationRoot",
  ])
    || !isSafeRelativePath(value.path)
    || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0
    || (value.bytes as number) > MAX_REVIEW_COMPARISON_CONTEXT_BYTES
    || (value.side !== "head" && value.side !== "mergeBase")
    || typeof value.peerGraphId !== "string"
    || !isGraphCapabilityId(value.peerGraphId) || value.peerGraphId === capabilityId
    || !isSafeRelativePath(value.generationRoot)) return null;
  return {
    path: value.path,
    sha256: value.sha256,
    bytes: value.bytes as number,
    side: value.side,
    peerGraphId: value.peerGraphId,
    generationRoot: value.generationRoot,
  };
}

function parseCapabilitySourceDescriptor(
  value: unknown,
  revision: unknown,
): GraphCapabilitySourceDescriptor | null {
  if (!isRecord(value) || !validGraphRevision(revision)) return null;
  if (value.kind === "managed-cache") {
    if (revision.kind !== "git"
      || Object.keys(value).length !== 5
      || !isSafeRelativePath(value.rootPath)
      || typeof value.subdir !== "string"
      || normalizeSubdir(value.subdir) !== value.subdir) return null;
    const metadata = parseArtifactSource(value.metadata);
    if (!metadata || metadata.kind === "path") return null;
    const owner = parseSourceOwner(value.owner);
    if (value.owner !== null && owner === null) return null;
    try {
      assertMirrorSourceOwner(value.rootPath, owner);
    } catch {
      return null;
    }
    return {
      kind: "managed-cache",
      rootPath: value.rootPath,
      subdir: value.subdir,
      metadata,
      owner,
    };
  }
  if (value.kind !== "external-local"
    || revision.kind !== "content"
    || Object.keys(value).length !== 6
    || !validCanonicalAbsolutePath(value.canonicalRoot)
    || value.subdir !== ""
    || value.owner !== null
    || !isRecord(value.rootIdentity)
    || Object.keys(value.rootIdentity).length !== 2
    || !decimalIdentity(value.rootIdentity.dev)
    || !decimalIdentity(value.rootIdentity.ino)) return null;
  const metadata = parseArtifactSource(value.metadata);
  if (metadata?.kind !== "path") return null;
  return {
    kind: "external-local",
    canonicalRoot: value.canonicalRoot,
    rootIdentity: { dev: value.rootIdentity.dev, ino: value.rootIdentity.ino },
    subdir: "",
    metadata,
    owner: null,
  };
}

function decimalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function parseSyntheticCapabilityReference(
  value: unknown,
  source: ArtifactSource,
): GraphSyntheticCapabilityReference | null {
  if (value === null) return null;
  if (!isRecord(value)
    || Object.keys(value).some((key) => !["path", "sha256", "executionTrust"].includes(key))
    || Object.keys(value).length !== 3
    || !isSafeRelativePath(value.path)
    || typeof value.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  const executionTrust = parseStoredSyntheticExecutionTrust(value.executionTrust, source);
  if (value.executionTrust !== null && executionTrust === null) return null;
  return { path: value.path, sha256: value.sha256, executionTrust };
}

function parseStoredSyntheticExecutionTrust(
  value: unknown,
  source: ArtifactSource,
): GraphSyntheticExecutionTrust | null {
  if (value === null) return null;
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || value.mode !== "sandboxed-pr"
    || !isRecord(value.provenance)
    || Object.keys(value.provenance).length !== 2
    || typeof value.provenance.repository !== "string"
    || typeof value.provenance.headSha !== "string") return null;
  if (source.kind !== "github"
    || value.provenance.repository !== `${source.owner}/${source.repo}`
    || !/^[0-9a-f]{40,64}$/.test(value.provenance.headSha)) return null;
  return {
    mode: "sandboxed-pr",
    provenance: {
      repository: value.provenance.repository,
      headSha: value.provenance.headSha,
    },
  };
}

function normalizeSyntheticExecutionTrust(
  value: GraphSyntheticExecutionTrust,
  source: ArtifactSource,
  capability: SyntheticCapabilitySidecar,
): GraphSyntheticExecutionTrust | null {
  const trust = parseStoredSyntheticExecutionTrust(value, source);
  if (!trust
    || capability.state !== "ready"
    || capability.scenarios.length === 0
    || capability.sourceFingerprint === null
    || capability.artifactCommit !== trust.provenance.headSha) return null;
  return trust;
}

function parseArtifactSource(value: unknown): ArtifactSource | null {
  if (!isRecord(value)) return null;
  if (value.kind === "path" && Object.keys(value).length === 1) return { kind: "path" };
  if (value.kind === "other") return { kind: "other" };
  if (value.kind !== "github" || typeof value.owner !== "string" || typeof value.repo !== "string") return null;
  if (value.subdir !== undefined && typeof value.subdir !== "string") return null;
  return normalizeArtifactSource({
    kind: "github",
    owner: value.owner,
    repo: value.repo,
    ...(value.subdir === undefined ? {} : { subdir: value.subdir }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeGraphSummary(value: unknown): GraphGenerationSummary | null {
  if (!isRecord(value)
    || typeof value.schemaVersion !== "string" || value.schemaVersion.length === 0 || value.schemaVersion.length > 64
    || typeof value.generatedAt !== "string" || !validTimestamp(value.generatedAt)
    || !Number.isSafeInteger(value.nodeCount) || (value.nodeCount as number) < 0
    || !Number.isSafeInteger(value.edgeCount) || (value.edgeCount as number) < 0) {
    return null;
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    nodeCount: value.nodeCount as number,
    edgeCount: value.edgeCount as number,
  });
}

function validStoredGeneration(value: VerifiedGraphGeneration): boolean {
  return isVerifiedGraphGeneration(value)
    && Number.isSafeInteger(value.artifactBytes) && value.artifactBytes > 0
    && /^[0-9a-f]{64}$/.test(value.artifactSha256)
    && Number.isSafeInteger(value.projectionBytes) && value.projectionBytes > 0
    && /^[0-9a-f]{64}$/.test(value.projectionSha256)
    && /^[0-9a-f]{64}$/.test(value.projectionContentId)
    && /^[0-9a-f]{64}$/.test(value.sealSha256)
    && validGraphRevision(value.revision);
}

function validGraphRevision(value: unknown): value is GraphRevisionIdentity {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  return value.kind === "git"
    ? typeof value.commit === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.commit)
    : value.kind === "content"
      && typeof value.contentId === "string"
      && /^[0-9a-f]{64}$/.test(value.contentId);
}

function assertMirrorSourceOwner(
  sourceRootPath: string,
  owner: RepositorySourceLeaseReference | null,
): void {
  const binding = parseRepositoryMirrorSourceRoot(sourceRootPath);
  if (!binding) {
    if (owner !== null) {
      throw new TypeError("graph capability source lease does not match its source root");
    }
    return;
  }
  if (!owner
    || owner.repositoryDigest !== binding.repositoryDigest
    || owner.leaseId !== binding.leaseId) {
    throw new TypeError("graph capability mirror source requires its exact source lease");
  }
}

function freezeDescriptor(descriptor: GraphCapabilityDescriptor): GraphCapabilityDescriptor {
  Object.freeze(descriptor.source.metadata);
  if (descriptor.source.owner) Object.freeze(descriptor.source.owner);
  if (descriptor.source.kind === "external-local") Object.freeze(descriptor.source.rootIdentity);
  Object.freeze(descriptor.graphSummary);
  Object.freeze(descriptor.artifact.revision);
  Object.freeze(descriptor.artifact);
  Object.freeze(descriptor.source);
  if (descriptor.synthetic) {
    if (descriptor.synthetic.executionTrust) {
      Object.freeze(descriptor.synthetic.executionTrust.provenance);
      Object.freeze(descriptor.synthetic.executionTrust);
    }
    Object.freeze(descriptor.synthetic);
  }
  if (descriptor.reviewContext) Object.freeze(descriptor.reviewContext);
  return Object.freeze(descriptor);
}

function sameCapabilityTarget(left: GraphCapabilityDescriptor, right: GraphCapabilityDescriptor): boolean {
  return left.id === right.id
    && JSON.stringify(left.graphSummary) === JSON.stringify(right.graphSummary)
    && JSON.stringify(left.artifact) === JSON.stringify(right.artifact)
    && JSON.stringify(left.source) === JSON.stringify(right.source)
    && JSON.stringify(left.synthetic) === JSON.stringify(right.synthetic)
    && JSON.stringify(left.reviewContext) === JSON.stringify(right.reviewContext);
}

function samePublishedTarget(
  left: GraphCapabilityDescriptor,
  right: GraphCapabilityDescriptor,
  idempotence: NonNullable<PublishGraphCapabilityOptions["idempotence"]>,
): boolean {
  return sameCapabilityTarget(left, right)
    || (idempotence === "managed-cache-semantic" && sameManagedCacheSemantics(left, right));
}

function sameManagedCacheSemantics(
  left: GraphCapabilityDescriptor,
  right: GraphCapabilityDescriptor,
): boolean {
  if (left.id !== right.id
    || left.source.kind !== "managed-cache"
    || right.source.kind !== "managed-cache") return false;
  return JSON.stringify(left.graphSummary) === JSON.stringify(right.graphSummary)
    && sameGraphContent(left.artifact, right.artifact)
    && left.source.subdir === right.source.subdir
    && JSON.stringify(left.source.metadata) === JSON.stringify(right.source.metadata)
    && sameSyntheticAuthority(left.synthetic, right.synthetic)
    && sameReviewContextAuthority(left.reviewContext, right.reviewContext);
}

function sameGraphContent(
  left: GraphCapabilityDescriptor["artifact"],
  right: GraphCapabilityDescriptor["artifact"],
): boolean {
  // Paths and the seal digest bind one physical generation. The verified artifact/projection
  // digests, revision, and separately-compared summary are the portable graph identity.
  return left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.projectionBytes === right.projectionBytes
    && left.projectionSha256 === right.projectionSha256
    && left.projectionContentId === right.projectionContentId
    && JSON.stringify(left.revision) === JSON.stringify(right.revision)
    && left.vcsBranch === right.vcsBranch;
}

function sameSyntheticAuthority(
  left: GraphSyntheticCapabilityReference | null,
  right: GraphSyntheticCapabilityReference | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.sha256 === right.sha256
    && JSON.stringify(left.executionTrust) === JSON.stringify(right.executionTrust);
}

function sameReviewContextAuthority(
  left: GraphReviewComparisonContextReference | null,
  right: GraphReviewComparisonContextReference | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.sha256 === right.sha256
    && left.bytes === right.bytes
    && left.side === right.side
    && left.peerGraphId === right.peerGraphId;
}

function requirePublicationIdempotence(
  value: PublishGraphCapabilityOptions["idempotence"],
): NonNullable<PublishGraphCapabilityOptions["idempotence"]> {
  if (value === undefined || value === "exact") return "exact";
  if (value === "managed-cache-semantic") return value;
  throw new TypeError("graph capability publication idempotence is invalid");
}
