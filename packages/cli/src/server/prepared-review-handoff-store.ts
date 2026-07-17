/**
 * Immutable, restart-safe navigation handoffs for prepared pull-request reviews.
 *
 * Handoffs contain only bounded JSON metadata. Graph artifacts and source files remain behind the
 * existing per-graph projection/source endpoints. Every URL id content-addresses the exact canonical
 * v1 JSON bytes served after restart; comparison reuse remains keyed independently by HEAD +
 * merge-base in the PR cache, so moving-base provenance and diagnostics cannot alias immutable
 * navigation bytes. Reads retain no in-memory registry.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  type Dirent,
  type BigIntStats,
} from "node:fs";
import {
  chmod as chmodAsync,
  lstat as lstatAsync,
  opendir,
  rm as rmAsync,
  rmdir as rmdirAsync,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PR_PREPARE_MAX_LINE_BYTES,
  PR_PREPARE_PROTOCOL_VERSION,
  PR_PREPARE_V1_FIELDS,
  hasExactPrPrepareFields,
  normalizePrPrepareChangedFiles,
  normalizePrPrepareTimings,
  normalizePrPrepareWarnings,
  type ChangedFileManifestEntry,
  type PrPrepareTimings,
} from "@meridian/core";
import type { GraphGenerationSummary } from "./graph-generation-contract";
import type {
  GraphCapabilityExternalOwnerKey,
  GraphCapabilityOwnerExpectation,
  GraphCapabilityStore,
} from "./graph-capability-store";
import { CacheRootLifecycleLock } from "./cache-root-lifecycle-lock";
import { parsePrPrepareRequest, type PrPrepareRequest } from "./web-pr-request";

export const PREPARED_REVIEW_HANDOFF_VERSION = PR_PREPARE_PROTOCOL_VERSION;
export const MAX_PREPARED_REVIEW_HANDOFF_BYTES = PR_PREPARE_MAX_LINE_BYTES;

const HANDOFF_DIRECTORY = "prepared-review-handoffs";
const VERSION_DIRECTORY = `v${PREPARED_REVIEW_HANDOFF_VERSION}`;
const QUARANTINE_DIRECTORY = `quarantine-${VERSION_DIRECTORY}`;
const HANDOFF_FILE = "handoff.json";
const INTEGRITY_FILE = "sha256";
const HANDOFF_ID = /^prh-v1-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_SCAN_BATCH = 32;
const MAINTENANCE_SORT_BATCH = 256;
const MAX_MAINTENANCE_SCAN_ENTRIES = 100_000;

export interface PreparedReviewGraphDescriptor {
  readonly graphId: string;
  readonly manifestUrl: string;
  readonly projectionUrl: string;
  readonly searchUrl: string;
  readonly sourceUrl: string;
  readonly metaUrl: string;
  readonly graphSummary: GraphGenerationSummary;
}

export interface PreparedReviewHandoffDocument {
  readonly version: typeof PREPARED_REVIEW_HANDOFF_VERSION;
  readonly request: PrPrepareRequest;
  readonly headSha: string;
  /** Request provenance only. The immutable comparison identity is `mergeBaseSha`. */
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly changedFiles: ChangedFileManifestEntry[];
  readonly head: PreparedReviewGraphDescriptor;
  readonly mergeBase: PreparedReviewGraphDescriptor;
  readonly cache: "hit" | "miss";
  readonly timings: PrPrepareTimings;
  readonly warnings: string[];
}

export type PreparedReviewHandoffInput = Omit<PreparedReviewHandoffDocument, "version">;

export interface PreparedReviewHandoffReference {
  readonly id: string;
  readonly url: string;
  readonly viewUrl: string;
}

export interface PreparedReviewHandoffCandidate {
  readonly id: string;
  readonly document: PreparedReviewHandoffDocument;
  readonly serialized: string;
  readonly contentSha256: string;
  readonly reference: PreparedReviewHandoffReference;
}

export interface PreparedReviewHandoffPublication {
  readonly signal?: AbortSignal;
  /** Synchronous transport delivery while lifecycle admission still protects this exact entry. */
  readonly deliver: (reference: PreparedReviewHandoffReference) => undefined;
}

export interface ResolvedPreparedReviewHandoff {
  readonly document: PreparedReviewHandoffDocument;
  /** Exact digest-validated bytes that the HTTP route must serve; never graph/artifact bytes. */
  readonly bytes: Buffer;
  readonly size: number;
  /** Digest of `bytes`, used as the representation ETag. */
  readonly sha256: string;
}

export type PreparedReviewHandoffQuarantineCleanup = (
  path: string,
  removeIdentityBoundTree: () => Promise<void>,
) => Promise<void>;

interface PreparedReviewHandoffEntry {
  readonly document: PreparedReviewHandoffDocument;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
  readonly touchedAt: number;
  readonly identity: BigIntStats;
}

export interface PreparedReviewHandoffStoreOptions {
  readonly cacheRoot: string;
  /** Single graph/source/generation authority for every side named by restart-safe handoffs. */
  readonly graphCapabilities: Pick<GraphCapabilityStore, "retainMany" | "releaseOwner" | "reconcileOwners">;
  /** Tests/deployments may lower, but never raise, the protocol's 2 MiB ceiling. */
  readonly maxDocumentBytes?: number;
  /** Maximum immutable handoff directories retained on disk. */
  readonly maxEntries?: number;
  /** Maximum JSON + integrity bytes retained on disk. */
  readonly maxCacheBytes?: number;
  /** Idle TTL renewed by publication and successful navigation reads. */
  readonly maxAgeMs?: number;
  /** Deterministic clock injection for pruning tests. */
  readonly now?: () => number;
  /** Cleanup executor; the default awaits identity-bound asynchronous physical removal. */
  readonly quarantineCleanup?: PreparedReviewHandoffQuarantineCleanup;
  /** Test seam after a cooperative startup-maintenance boundary. */
  readonly afterMaintenanceCheckpoint?: (
    phase: "scan" | "reconcile" | "release",
  ) => Promise<void> | void;
}

export interface PreparedReviewHandoffScavengeOptions {
  readonly protectedId?: string;
  readonly signal?: AbortSignal;
}

export interface PreparedReviewHandoffReconcileOptions {
  readonly signal?: AbortSignal;
}

export interface PreparedReviewHandoffResolveOptions {
  readonly signal?: AbortSignal;
}

export interface PreparedReviewHandoffScavengeResult {
  readonly entries: number;
  readonly bytes: number;
  readonly removed: number;
}

export class PreparedReviewHandoffStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedReviewHandoffStoreError";
  }
}

interface QuarantineCleanupFailure {
  readonly path: string;
  readonly error: unknown;
}

interface QuarantineCleanupResult {
  readonly removed: number;
  readonly failures: readonly QuarantineCleanupFailure[];
}

interface MaintenanceScanBudget {
  remaining: number;
}

class QuarantineCleanupBatch {
  private readonly entries = new Map<string, BigIntStats>();
  private delivered = false;

  add(path: string, identity: BigIntStats): void {
    const existing = this.entries.get(path);
    if (existing && !sameNodeIdentity(existing, identity)) {
      throw new PreparedReviewHandoffStoreError("prepared-review quarantine identity changed");
    }
    this.entries.set(path, identity);
  }

  markDelivered(): void {
    this.delivered = true;
  }

  wasDelivered(): boolean {
    return this.delivered;
  }

  async flush(
    executor: PreparedReviewHandoffQuarantineCleanup,
    signal?: AbortSignal,
  ): Promise<QuarantineCleanupResult> {
    let removed = 0;
    const failures: QuarantineCleanupFailure[] = [];
    if (signal?.aborted) {
      return Object.freeze({ removed, failures: Object.freeze(failures) });
    }
    const entries = await cooperativeSort(
      [...this.entries],
      ([left], [right]) => compareUtf8(left, right),
      signal,
    );
    for (const [path, identity] of entries) {
      if (signal?.aborted) break;
      try {
        let removal: Promise<void> | undefined;
        await executor(path, () => {
          removal ??= removeQuarantinedTree(path, identity, signal);
          return removal;
        });
        if (!removal) {
          throw new PreparedReviewHandoffStoreError(
            "prepared-review quarantine cleanup did not request physical removal",
          );
        }
        await removal;
        removed += 1;
      } catch (error) {
        failures.push(Object.freeze({ path, error }));
        if (signal?.aborted) break;
      }
    }
    return Object.freeze({ removed, failures: Object.freeze(failures) });
  }
}

export class PreparedReviewHandoffStore {
  private readonly root: string;
  private readonly quarantineRoot: string;
  private readonly maxDocumentBytes: number;
  private readonly maxEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly graphCapabilities: PreparedReviewHandoffStoreOptions["graphCapabilities"];
  private readonly quarantineCleanup: PreparedReviewHandoffQuarantineCleanup;
  private readonly afterMaintenanceCheckpoint: NonNullable<
    PreparedReviewHandoffStoreOptions["afterMaintenanceCheckpoint"]
  >;
  private readonly lifecycleLock: CacheRootLifecycleLock;

  constructor(options: PreparedReviewHandoffStoreOptions) {
    if (!options.cacheRoot.trim()) throw new TypeError("prepared-review cache root is required");
    if (!options.graphCapabilities
      || typeof options.graphCapabilities.retainMany !== "function"
      || typeof options.graphCapabilities.releaseOwner !== "function"
      || typeof options.graphCapabilities.reconcileOwners !== "function") {
      throw new TypeError("prepared-review graph capability authority is required");
    }
    const configured = options.maxDocumentBytes ?? MAX_PREPARED_REVIEW_HANDOFF_BYTES;
    if (!Number.isSafeInteger(configured) || configured <= 0 || configured > MAX_PREPARED_REVIEW_HANDOFF_BYTES) {
      throw new RangeError("prepared-review document limit must be between 1 byte and 2 MiB");
    }
    this.maxDocumentBytes = configured;
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "entry limit");
    this.maxCacheBytes = positiveInteger(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES, "cache byte limit");
    if (this.maxCacheBytes < this.maxDocumentBytes + 65) {
      throw new RangeError("prepared-review cache byte limit must fit one maximum document and digest");
    }
    this.maxAgeMs = positiveInteger(options.maxAgeMs, DEFAULT_MAX_AGE_MS, "maximum age");
    this.now = options.now ?? Date.now;
    this.graphCapabilities = options.graphCapabilities;
    this.quarantineCleanup = options.quarantineCleanup
      ?? (async (_path, removeIdentityBoundTree) => removeIdentityBoundTree());
    this.afterMaintenanceCheckpoint = options.afterMaintenanceCheckpoint ?? (() => undefined);
    requireNoFollowFlag();
    requireDirectoryFlag();

    const requestedCacheRoot = resolve(options.cacheRoot);
    mkdirSync(requestedCacheRoot, { recursive: true, mode: 0o700 });
    const cacheRoot = realpathSync(requestedCacheRoot);
    this.lifecycleLock = new CacheRootLifecycleLock(cacheRoot);
    const handoffRoot = requirePlainDirectory(join(cacheRoot, HANDOFF_DIRECTORY), cacheRoot);
    this.root = requirePlainDirectory(join(handoffRoot, VERSION_DIRECTORY), handoffRoot);
    this.quarantineRoot = requirePlainDirectory(join(handoffRoot, QUARANTINE_DIRECTORY), handoffRoot);
  }

  private async runLifecycleOperation<T>(
    operation: (cleanup: QuarantineCleanupBatch) => Promise<T> | T,
    options: {
      signal?: AbortSignal;
      drainQuarantine?: boolean;
      interruptibleCleanup?: boolean;
    } = {},
  ): Promise<T> {
    const cleanup = new QuarantineCleanupBatch();
    let value!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      value = await this.lifecycleLock.runExclusive(async () => {
        throwIfAborted(options.signal);
        if (options.drainQuarantine) {
          await this.collectQuarantineBacklog(cleanup, options.signal);
        }
        throwIfAborted(options.signal);
        return operation(cleanup);
      }, options.signal);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    if (!operationFailed && options.interruptibleCleanup) {
      try {
        throwIfAborted(options.signal);
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
    }
    const cleanupResult = await cleanup.flush(
      this.quarantineCleanup,
      options.interruptibleCleanup ? options.signal : undefined,
    );
    if (options.interruptibleCleanup && options.signal?.aborted) {
      throwIfAborted(options.signal);
    }
    if (operationFailed) {
      if (cleanupResult.failures.length > 0) {
        throw new AggregateError(
          [operationError, ...cleanupResult.failures.map((failure) => failure.error)],
          "prepared-review operation and quarantine cleanup both failed",
        );
      }
      throw operationError;
    }
    if (cleanupResult.failures.length > 0 && !cleanup.wasDelivered()) {
      throw new AggregateError(
        cleanupResult.failures.map((failure) => failure.error),
        "one or more prepared-review quarantine entries could not be removed",
      );
    }
    // Once delivery has returned, the immutable handoff is externally committed. A failed physical
    // cleanup must not turn one terminal `done` record into a second terminal error; the isolated,
    // identity-bound quarantine entry remains durable for the next startup reconciliation.
    return value;
  }

  /**
   * Build the exact immutable record and URLs without touching disk. Callers use this preview to
   * enforce the terminal NDJSON line bound before atomically publishing the handoff.
   */
  prepare(input: PreparedReviewHandoffInput): PreparedReviewHandoffCandidate {
    const document = normalizeDocument({ version: PREPARED_REVIEW_HANDOFF_VERSION, ...input });
    if (!document) throw new PreparedReviewHandoffStoreError("prepared-review handoff is invalid");
    const serialized = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(serialized) > this.maxDocumentBytes) {
      throw new PreparedReviewHandoffStoreError("PR preparation result exceeds the 2 MiB handoff limit");
    }
    const id = handoffId(document);
    const contentSha256 = createHash("sha256").update(serialized).digest("hex");
    const encodedId = encodeURIComponent(id);
    return {
      id,
      document,
      serialized,
      contentSha256,
      reference: {
        id,
        url: `/api/pr/prepared?id=${encodedId}`,
        viewUrl: `/view?id=${encodeURIComponent(document.head.graphId)}`
          + `&view=modules&prn=${document.request.prNumber}&rev=1&prepared=${encodedId}`,
      },
    };
  }

  /** Atomically publish a bounded candidate. The same exact representation is idempotent. */
  async publish(
    candidate: PreparedReviewHandoffCandidate,
    publication: PreparedReviewHandoffPublication,
  ): Promise<PreparedReviewHandoffReference> {
    return this.runLifecycleOperation(
      (cleanup) => this.publishAdmitted(candidate, publication, cleanup),
      { signal: publication.signal },
    );
  }

  private async publishAdmitted(
    candidate: PreparedReviewHandoffCandidate,
    publication: PreparedReviewHandoffPublication,
    cleanup: QuarantineCleanupBatch,
  ): Promise<PreparedReviewHandoffReference> {
    throwIfAborted(publication.signal);
    const verified = this.prepare(candidate.document);
    if (verified.id !== candidate.id
      || verified.serialized !== candidate.serialized
      || verified.contentSha256 !== candidate.contentSha256) {
      throw new PreparedReviewHandoffStoreError("prepared-review handoff candidate was modified");
    }
    const retention = this.retentionWindow();
    let handoffAvailable = false;
    let ownsDestination = false;
    let delivered = false;
    let stage: string | undefined;
    let destination: string | undefined;
    let ownedIdentity: BigIntStats | undefined;
    try {
      await retainGraphCapabilities(
        this.graphCapabilities,
        verified.document,
        verified.id,
        retention.retainedUntilMs,
        publication.signal,
      );
      throwIfAborted(publication.signal);
      const shard = requirePlainDirectory(join(this.root, shardFor(candidate.id)), this.root);
      destination = join(shard, candidate.id);
      const allocatedStage = mkdtempSync(join(shard, ".stage-"));
      stage = allocatedStage;
      chmodSync(allocatedStage, 0o700);
      const handoffPath = join(allocatedStage, HANDOFF_FILE);
      const integrityPath = join(allocatedStage, INTEGRITY_FILE);
      writeFileSync(handoffPath, candidate.serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      writeFileSync(integrityPath, `${candidate.contentSha256}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(handoffPath, 0o400);
      chmodSync(integrityPath, 0o400);
      chmodSync(allocatedStage, 0o500);
      try {
        renameSync(allocatedStage, destination);
        ownsDestination = true;
        ownedIdentity = lstatSync(destination, { bigint: true });
        stage = undefined;
      } catch (error) {
        if (!existsSync(destination)) throw error;
        const existing = await this.readEntry(candidate.id, publication.signal);
        if (existing
          && existing.sha256 === verified.contentSha256
          && existing.bytes.equals(Buffer.from(verified.serialized, "utf8"))) {
          const stageIdentity = lstatSync(allocatedStage, { bigint: true });
          if (!this.quarantine(allocatedStage, stageIdentity, cleanup)) {
            throw new PreparedReviewHandoffStoreError(
              "prepared-review handoff stage changed during idempotent publication",
            );
          }
          stage = undefined;
        } else {
          const observed = lstatOrNull(destination);
          if (!observed || !this.quarantine(destination, observed, cleanup)) {
            throw new PreparedReviewHandoffStoreError(
              "prepared-review handoff changed while repairing its immutable destination",
            );
          }
          renameSync(allocatedStage, destination);
          ownsDestination = true;
          ownedIdentity = lstatSync(destination, { bigint: true });
          stage = undefined;
        }
      }
      const published = await this.readEntry(candidate.id, publication.signal);
      if (!published
        || published.sha256 !== verified.contentSha256
        || !published.bytes.equals(Buffer.from(verified.serialized, "utf8"))) {
        throw new PreparedReviewHandoffStoreError("prepared-review handoff publication is not immutable");
      }
      ownedIdentity = this.touch(published, retention.renewedAtMs);
      handoffAvailable = true;
      await this.scavengeEntries(candidate.id, false, cleanup, publication.signal);
      const retained = await this.readEntry(candidate.id, publication.signal);
      if (!retained
        || retained.sha256 !== verified.contentSha256
        || !retained.bytes.equals(Buffer.from(verified.serialized, "utf8"))) {
        throw new PreparedReviewHandoffStoreError("published prepared-review handoff was not retained");
      }
      throwIfAborted(publication.signal);
      const deliveryResult: unknown = publication.deliver(candidate.reference);
      if (isThenable(deliveryResult)) {
        throw new TypeError("prepared-review publication delivery must be synchronous");
      }
      delivered = true;
      cleanup.markDelivered();
      return candidate.reference;
    } catch (error) {
      if (!delivered) {
        const rollbackErrors: unknown[] = [];
        if (stage) {
          try {
            const stageIdentity = lstatOrNull(stage);
            if (stageIdentity && !this.quarantine(stage, stageIdentity, cleanup)) {
              rollbackErrors.push(new PreparedReviewHandoffStoreError(
                "prepared-review stage rollback lost ownership",
              ));
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (ownsDestination && destination && ownedIdentity) {
          try {
            if (!this.quarantine(destination, ownedIdentity, cleanup)) {
              rollbackErrors.push(new PreparedReviewHandoffStoreError(
                "prepared-review destination rollback lost ownership",
              ));
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        // A racing idempotent publisher may have completed the same representation. Its handoff
        // owns the shared per-id pins, so rollback only when no valid destination survived.
        if (!handoffAvailable || ownsDestination) {
          handoffAvailable = await this.readEntry(verified.id) !== null;
        }
        if (!handoffAvailable) {
          try {
            await releaseGraphOwner(this.graphCapabilities, verified.id);
          } catch (releaseError) {
            rollbackErrors.push(releaseError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "prepared-review publication and rollback both failed",
          );
        }
      }
      throw error;
    }
  }

  /** Resolve and validate one immutable JSON file. No result is retained in process memory. */
  async resolve(
    id: string | null | undefined,
    options: PreparedReviewHandoffResolveOptions = {},
  ): Promise<ResolvedPreparedReviewHandoff | null> {
    return this.runLifecycleOperation(
      (cleanup) => this.resolveAdmitted(id, cleanup, options.signal),
      { signal: options.signal, interruptibleCleanup: true },
    );
  }

  private async resolveAdmitted(
    id: string | null | undefined,
    cleanup: QuarantineCleanupBatch,
    signal: AbortSignal | undefined,
  ): Promise<ResolvedPreparedReviewHandoff | null> {
    throwIfAborted(signal);
    if (!isPreparedReviewHandoffId(id)) return null;
    const resolved = await this.readEntry(id, signal);
    if (!resolved) return null;
    if (this.now() - resolved.touchedAt >= this.maxAgeMs) {
      if (!this.quarantine(resolved.path, resolved.identity, cleanup)) {
        throw new PreparedReviewHandoffStoreError(
          "prepared-review handoff changed while expiring its immutable destination",
        );
      }
      await this.removeEmptyShards(signal);
      throwIfAborted(signal);
      await releaseGraphOwner(this.graphCapabilities, id, signal);
      throwIfAborted(signal);
      return null;
    }
    const retention = this.retentionWindow();
    await retainGraphCapabilities(
      this.graphCapabilities,
      resolved.document,
      id,
      retention.retainedUntilMs,
      signal,
    );
    throwIfAborted(signal);
    this.touch(resolved, retention.renewedAtMs);
    throwIfAborted(signal);
    return {
      document: resolved.document,
      bytes: resolved.bytes,
      size: resolved.bytes.byteLength,
      sha256: resolved.sha256,
    };
  }

  /** Deterministically remove malformed, expired, least-recently-used, and excess-byte entries. */
  async scavenge(
    options: PreparedReviewHandoffScavengeOptions = {},
  ): Promise<PreparedReviewHandoffScavengeResult> {
    return this.runLifecycleOperation(
      (cleanup) => this.scavengeEntries(
        options.protectedId,
        false,
        cleanup,
        options.signal,
      ),
      { signal: options.signal, interruptibleCleanup: true },
    );
  }

  /** Explicit startup reconciliation; construction never launches maintenance out of order. */
  async reconcile(
    options: PreparedReviewHandoffReconcileOptions = {},
  ): Promise<PreparedReviewHandoffScavengeResult> {
    return this.runLifecycleOperation(
      (cleanup) => this.reconcileEntries(cleanup, options.signal),
      {
        signal: options.signal,
        drainQuarantine: true,
        interruptibleCleanup: true,
      },
    );
  }

  private async reconcileEntries(
    cleanup: QuarantineCleanupBatch,
    signal: AbortSignal | undefined,
  ): Promise<PreparedReviewHandoffScavengeResult> {
    throwIfAborted(signal);
    return this.scavengeEntries(undefined, true, cleanup, signal);
  }

  private async scavengeEntries(
    protectedId: string | undefined,
    reconcileSurvivors: boolean,
    cleanup: QuarantineCleanupBatch,
    signal: AbortSignal | undefined,
  ): Promise<PreparedReviewHandoffScavengeResult> {
    throwIfAborted(signal);
    const now = this.now();
    if (!Number.isSafeInteger(now)) {
      throw new PreparedReviewHandoffStoreError("prepared-review cache clock is invalid");
    }
    let removed = 0;
    const removedOwnerIds = new Set<string>();
    let requiresAuthoritativeReconcile = reconcileSurvivors;
    const entries: Array<{
      id: string;
      path: string;
      bytes: number;
      touchedAt: number;
      document: PreparedReviewHandoffDocument;
      identity: BigIntStats;
    }> = [];
    const scanBudget: MaintenanceScanBudget = { remaining: MAX_MAINTENANCE_SCAN_ENTRIES };
    await this.forEachMaintenanceEntry(this.root, scanBudget, signal, async (shardEntry) => {
      const shardPath = join(this.root, shardEntry.name);
      const shardIdentity = lstatOrNull(shardPath);
      if (!SHARD.test(shardEntry.name)
        || !shardEntry.isDirectory()
        || shardEntry.isSymbolicLink()
        || !shardIdentity?.isDirectory()
        || shardIdentity.isSymbolicLink()
        || realpathOrNull(shardPath) !== shardPath) {
        if (shardIdentity && !this.quarantine(shardPath, shardIdentity, cleanup)) {
          throw changedDuringScavenge();
        }
        requiresAuthoritativeReconcile = true;
        removed += 1;
        return;
      }
      await this.forEachMaintenanceEntry(shardPath, scanBudget, signal, async (handoffEntry) => {
        const path = join(shardPath, handoffEntry.name);
        const observed = lstatOrNull(path);
        if (!isPreparedReviewHandoffId(handoffEntry.name)
          || shardFor(handoffEntry.name) !== shardEntry.name
          || !handoffEntry.isDirectory()
          || handoffEntry.isSymbolicLink()
          || !observed?.isDirectory()
          || observed.isSymbolicLink()) {
          if (observed && !this.quarantine(path, observed, cleanup)) throw changedDuringScavenge();
          if (isPreparedReviewHandoffId(handoffEntry.name)) removedOwnerIds.add(handoffEntry.name);
          removed += 1;
          return;
        }
        const resolved = await this.readEntry(handoffEntry.name, signal);
        if (!resolved) {
          if (!this.quarantine(path, observed, cleanup)) throw changedDuringScavenge();
          removedOwnerIds.add(handoffEntry.name);
          removed += 1;
          return;
        }
        const touchedAt = resolved.touchedAt;
        if (now - touchedAt >= this.maxAgeMs) {
          if (!this.quarantine(path, resolved.identity, cleanup)) throw changedDuringScavenge();
          removedOwnerIds.add(handoffEntry.name);
          removed += 1;
          return;
        }
        entries.push({
          id: handoffEntry.name,
          path,
          bytes: resolved.bytes.byteLength + 65,
          touchedAt,
          document: resolved.document,
          identity: resolved.identity,
        });
      });
    });
    await this.maintenanceCheckpoint("scan", signal, false);
    const sortedEntries = await cooperativeSort(entries, (left, right) => {
      if (left.id === protectedId) return 1;
      if (right.id === protectedId) return -1;
      return left.touchedAt - right.touchedAt
        || Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8"));
    }, signal);
    let bytes = 0;
    for (let index = 0; index < sortedEntries.length; index += 1) {
      bytes += sortedEntries[index]!.bytes;
      if (!Number.isSafeInteger(bytes)) {
        throw new PreparedReviewHandoffStoreError("prepared-review cache byte total overflowed");
      }
      if ((index + 1) % MAINTENANCE_SORT_BATCH === 0) {
        await this.maintenanceCheckpoint("scan", signal);
      }
    }
    let retained = sortedEntries.length;
    const evicted = new Set<string>();
    for (const entry of sortedEntries) {
      throwIfAborted(signal);
      if (retained <= this.maxEntries && bytes <= this.maxCacheBytes) break;
      if (!this.quarantine(entry.path, entry.identity, cleanup)) throw changedDuringScavenge();
      removedOwnerIds.add(entry.id);
      evicted.add(entry.id);
      retained -= 1;
      bytes -= entry.bytes;
      removed += 1;
    }
    await this.removeEmptyShards(signal);
    const retainedEntries: typeof sortedEntries = [];
    for (let index = 0; index < sortedEntries.length; index += 1) {
      const candidate = sortedEntries[index]!;
      if (!evicted.has(candidate.id)) retainedEntries.push(candidate);
      if ((index + 1) % MAINTENANCE_SORT_BATCH === 0) {
        await this.maintenanceCheckpoint("scan", signal);
      }
    }
    const survivors = await cooperativeSort(
      retainedEntries,
      (left, right) => compareUtf8(left.id, right.id),
      signal,
    );

    if (requiresAuthoritativeReconcile) {
      const expectations: GraphCapabilityOwnerExpectation[] = [];
      const byId = new Map<string, (typeof survivors)[number]>();
      for (let index = 0; index < survivors.length; index += 1) {
        const entry = survivors[index]!;
        expectations.push(graphOwnerExpectation(entry, entry.id, this.maxAgeMs));
        byId.set(entry.id, entry);
        if ((index + 1) % MAINTENANCE_SORT_BATCH === 0) {
          await this.maintenanceCheckpoint("reconcile", signal);
        }
      }
      await this.maintenanceCheckpoint("reconcile", signal, false);
      const reconciliation = await this.graphCapabilities.reconcileOwners(
        "prepared-review-handoff",
        expectations,
        { signal },
      );
      await this.maintenanceCheckpoint("reconcile", signal, false);
      for (let index = 0; index < reconciliation.failures.length; index += 1) {
        const failure = reconciliation.failures[index]!;
        throwIfAborted(signal);
        const entry = byId.get(failure.owner.id);
        if (!entry) {
          throw new PreparedReviewHandoffStoreError("graph owner reconciliation returned an unknown handoff");
        }
        if (!this.quarantine(entry.path, entry.identity, cleanup)) throw changedDuringScavenge();
        evicted.add(entry.id);
        retained -= 1;
        bytes -= entry.bytes;
        removed += 1;
        if ((index + 1) % MAINTENANCE_SCAN_BATCH === 0) {
          await this.maintenanceCheckpoint("reconcile", signal);
        }
      }
      await this.removeEmptyShards(signal);
    } else {
      const errors: unknown[] = [];
      const ownersToRelease = await cooperativeSort([...removedOwnerIds], compareUtf8, signal);
      for (let index = 0; index < ownersToRelease.length; index += 1) {
        const id = ownersToRelease[index]!;
        throwIfAborted(signal);
        try {
          await releaseGraphOwner(this.graphCapabilities, id, signal);
        } catch (error) {
          errors.push(error);
        }
        throwIfAborted(signal);
        if ((index + 1) % MAINTENANCE_SCAN_BATCH === 0) {
          await this.maintenanceCheckpoint("release", signal);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "one or more prepared-review graph owners could not be released");
      }
    }
    let retainedIndex = 0;
    for (const entry of survivors) {
      if (evicted.has(entry.id)) continue;
      throwIfAborted(signal);
      const current = lstatOrNull(entry.path);
      if (!current || !sameFileIdentity(entry.identity, current)) throw changedDuringScavenge();
      retainedIndex += 1;
      if (retainedIndex % MAINTENANCE_SCAN_BATCH === 0) {
        await this.maintenanceCheckpoint("scan", signal);
      }
    }
    return { entries: retained, bytes, removed };
  }

  /** Validate immutable bytes without mutating lifecycle state. Callers own removal and release. */
  private async readEntry(
    id: string | null | undefined,
    signal?: AbortSignal,
  ): Promise<PreparedReviewHandoffEntry | null> {
    if (!isPreparedReviewHandoffId(id)) return null;
    try {
      throwIfAborted(signal);
      const directory = join(this.root, shardFor(id), id);
      if (!isContainedPath(directory, this.root)) return null;
      const directoryEntry = lstatSync(directory, { bigint: true });
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()
        || fileMode(directoryEntry) !== 0o500) return null;
      const canonicalDirectory = realpathSync(directory);
      if (canonicalDirectory !== directory || !isContainedPath(canonicalDirectory, this.root)) return null;
      const names = (await readDirectoryNamesBounded(canonicalDirectory, 3, signal))
        .sort(compareUtf8);
      if (names.length !== 2 || names[0] !== HANDOFF_FILE || names[1] !== INTEGRITY_FILE) return null;
      const raw = readPlainFileNoFollow(
        join(canonicalDirectory, HANDOFF_FILE),
        canonicalDirectory,
        this.maxDocumentBytes,
        0o400,
      );
      if (!raw || raw.byteLength <= 0) return null;
      const integrityPath = join(canonicalDirectory, INTEGRITY_FILE);
      const integrityBytes = readPlainFileNoFollow(integrityPath, canonicalDirectory, 65, 0o400);
      if (!integrityBytes || integrityBytes.byteLength !== 65) return null;
      const integrity = integrityBytes.toString("utf8");
      const expectedSha256 = integrity.endsWith("\n") ? integrity.slice(0, -1) : "";
      if (!SHA256.test(expectedSha256)
        || createHash("sha256").update(raw).digest("hex") !== expectedSha256) return null;
      const document = normalizeDocument(JSON.parse(raw.toString("utf8")));
      if (!document || handoffId(document) !== id) return null;
      const canonical = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
      if (expectedSha256 !== id.slice("prh-v1-".length) || !raw.equals(canonical)) return null;
      throwIfAborted(signal);
      const directoryAfter = lstatSync(directory, { bigint: true });
      if (!sameFileIdentity(directoryEntry, directoryAfter)
        || realpathSync(directory) !== directory) return null;
      return {
        document,
        bytes: raw,
        sha256: expectedSha256,
        path: directory,
        touchedAt: Number(directoryEntry.mtimeNs / 1_000_000n),
        identity: directoryEntry,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return null;
    }
  }

  private touch(entry: PreparedReviewHandoffEntry, atMs = this.now()): BigIntStats {
    let descriptor: number | undefined;
    try {
      if (!Number.isSafeInteger(atMs)) throw new Error("cache clock is invalid");
      const path = entry.path;
      const before = lstatSync(path, { bigint: true });
      if (!sameFileIdentity(entry.identity, before) || realpathSync(path) !== path) {
        throw new Error("immutable directory changed before renewal");
      }
      descriptor = openSync(
        path,
        constants.O_RDONLY | requireNoFollowFlag() | requireDirectoryFlag(),
      );
      const opened = fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(before, opened)) throw new Error("immutable directory changed before open");
      const at = new Date(atMs);
      futimesSync(descriptor, at, at);
      const afterDescriptor = fstatSync(descriptor, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (!sameNodeIdentity(opened, afterDescriptor)
        || !sameFileIdentity(afterDescriptor, afterPath)
        || realpathSync(path) !== path) {
        throw new Error("immutable directory changed during renewal");
      }
      return afterPath;
    } catch (error) {
      throw new PreparedReviewHandoffStoreError(
        `prepared-review lifetime renewal failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private async forEachMaintenanceEntry(
    path: string,
    budget: MaintenanceScanBudget,
    signal: AbortSignal | undefined,
    visitor: (entry: Dirent) => Promise<void> | void,
  ): Promise<void> {
    const directory = await opendir(path);
    let visited = 0;
    for await (const entry of directory) {
      throwIfAborted(signal);
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw new PreparedReviewHandoffStoreError(
          "prepared-review maintenance scan exceeded its entry limit",
        );
      }
      await visitor(entry);
      visited += 1;
      if (visited % MAINTENANCE_SCAN_BATCH === 0) {
        await this.maintenanceCheckpoint("scan", signal);
      }
    }
    throwIfAborted(signal);
  }

  private async maintenanceCheckpoint(
    phase: "scan" | "reconcile" | "release",
    signal: AbortSignal | undefined,
    yieldToLoop = true,
  ): Promise<void> {
    throwIfAborted(signal);
    if (yieldToLoop) await cooperativeYield(signal);
    await this.afterMaintenanceCheckpoint(phase);
    throwIfAborted(signal);
  }

  private async removeEmptyShards(signal: AbortSignal | undefined): Promise<void> {
    const budget: MaintenanceScanBudget = { remaining: MAX_MAINTENANCE_SCAN_ENTRIES };
    await this.forEachMaintenanceEntry(this.root, budget, signal, async (entry) => {
      if (!SHARD.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) return;
      const path = join(this.root, entry.name);
      try {
        if (realpathSync(path) === path
          && (await readDirectoryNamesBounded(path, 1, signal)).length === 0) rmdirSync(path);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // A concurrent publisher may have populated the shard after the empty check.
      }
    });
  }

  private async collectQuarantineBacklog(
    cleanup: QuarantineCleanupBatch,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const budget: MaintenanceScanBudget = { remaining: MAX_MAINTENANCE_SCAN_ENTRIES };
    await this.forEachMaintenanceEntry(this.quarantineRoot, budget, signal, (entry) => {
      const path = join(this.quarantineRoot, entry.name);
      const identity = lstatOrNull(path);
      const match = /^quarantine-([0-9a-f]{64})-[0-9a-f-]{36}$/.exec(entry.name);
      if (!identity || !match || match[1] !== quarantineIdentityDigest(identity)) {
        throw new PreparedReviewHandoffStoreError(
          "prepared-review quarantine contains an unowned entry",
        );
      }
      cleanup.add(path, identity);
    });
  }

  private quarantine(
    path: string,
    expected: BigIntStats,
    cleanup: QuarantineCleanupBatch,
  ): boolean {
    if (!isContainedPath(path, this.root) || path === this.root) {
      throw new PreparedReviewHandoffStoreError("prepared-review quarantine path escapes its root");
    }
    return quarantinePath(path, expected, this.quarantineRoot, cleanup);
  }

  private retentionWindow(): { renewedAtMs: number; retainedUntilMs: number } {
    const renewedAtMs = this.now();
    const retainedUntilMs = renewedAtMs + this.maxAgeMs;
    if (!Number.isSafeInteger(renewedAtMs) || !Number.isSafeInteger(retainedUntilMs)) {
      throw new PreparedReviewHandoffStoreError("prepared-review source retention deadline is invalid");
    }
    return { renewedAtMs, retainedUntilMs };
  }
}

export function isPreparedReviewHandoffId(value: string | null | undefined): value is string {
  return typeof value === "string" && HANDOFF_ID.test(value);
}

function handoffId(document: PreparedReviewHandoffDocument): string {
  // This is a representation address, deliberately not the PR comparison/cache identity. The
  // latter excludes moving baseSha provenance and observational diagnostics; this digest includes
  // them so one immutable URL can never serve different bytes after LRU/TTL eviction and republish.
  const digest = createHash("sha256").update(`${JSON.stringify(document)}\n`).digest("hex");
  return `prh-v1-${digest}`;
}

function shardFor(id: string): string {
  return id.slice("prh-v1-".length, "prh-v1-".length + 2);
}

function normalizeDocument(value: unknown): PreparedReviewHandoffDocument | null {
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.handoffDocument)) return null;
  if (value.version !== PREPARED_REVIEW_HANDOFF_VERSION) return null;
  const request = normalizeRequest(value.request);
  const head = normalizeDescriptor(value.head);
  const mergeBase = normalizeDescriptor(value.mergeBase);
  const changedFiles = normalizeChangedFiles(value.changedFiles);
  const timings = normalizeTimings(value.timings);
  const warnings = normalizeWarnings(value.warnings);
  if (!request || !head || !mergeBase || !changedFiles || !timings || !warnings
    || !isCommit(value.headSha) || !isCommit(value.baseSha) || !isCommit(value.mergeBaseSha)
    || (value.cache !== "hit" && value.cache !== "miss")) return null;
  return {
    version: PREPARED_REVIEW_HANDOFF_VERSION,
    request,
    headSha: value.headSha,
    baseSha: value.baseSha,
    mergeBaseSha: value.mergeBaseSha,
    changedFiles,
    head,
    mergeBase,
    cache: value.cache,
    timings,
    warnings,
  };
}

function normalizeRequest(value: unknown): PrPrepareRequest | null {
  if (!isRecord(value)) return null;
  const expected = value.subdir === undefined
    ? PR_PREPARE_V1_FIELDS.request
    : PR_PREPARE_V1_FIELDS.requestWithSubdir;
  if (!hasExactPrPrepareFields(value, expected)) return null;
  try {
    const parsed = parsePrPrepareRequest(value);
    if (JSON.stringify(parsed) !== JSON.stringify(value)) return null;
    return { ...parsed };
  } catch {
    return null;
  }
}

function normalizeDescriptor(value: unknown): PreparedReviewGraphDescriptor | null {
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.descriptor)) return null;
  if (typeof value.graphId !== "string" || !GRAPH_ID.test(value.graphId)) return null;
  const encoded = encodeURIComponent(value.graphId);
  if (value.manifestUrl !== `/api/graph/manifest?id=${encoded}`
    || value.projectionUrl !== `/api/graph/projection?id=${encoded}`
    || value.searchUrl !== `/api/graph/search?id=${encoded}`
    || value.sourceUrl !== `/api/source?id=${encoded}`
    || value.metaUrl !== `/api/meta?id=${encoded}`) return null;
  const graphSummary = normalizeGraphSummary(value.graphSummary);
  if (!graphSummary) return null;
  return {
    graphId: value.graphId,
    manifestUrl: value.manifestUrl,
    projectionUrl: value.projectionUrl,
    searchUrl: value.searchUrl,
    sourceUrl: value.sourceUrl,
    metaUrl: value.metaUrl,
    graphSummary,
  };
}

function normalizeGraphSummary(value: unknown): GraphGenerationSummary | null {
  if (!hasExactPrPrepareFields(value, PR_PREPARE_V1_FIELDS.graphSummary)) return null;
  if (typeof value.schemaVersion !== "string" || value.schemaVersion.length === 0 || value.schemaVersion.length > 128
    || typeof value.generatedAt !== "string" || value.generatedAt.length > 64 || !Number.isFinite(Date.parse(value.generatedAt))
    || !Number.isSafeInteger(value.nodeCount) || (value.nodeCount as number) < 0
    || !Number.isSafeInteger(value.edgeCount) || (value.edgeCount as number) < 0) return null;
  return {
    schemaVersion: value.schemaVersion,
    generatedAt: value.generatedAt,
    nodeCount: value.nodeCount as number,
    edgeCount: value.edgeCount as number,
  };
}

function normalizeChangedFiles(value: unknown): ChangedFileManifestEntry[] | null {
  return normalizePrPrepareChangedFiles(value);
}

function normalizeTimings(value: unknown): PrPrepareTimings | null {
  return normalizePrPrepareTimings(value);
}

function normalizeWarnings(value: unknown): string[] | null {
  return normalizePrPrepareWarnings(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlainDirectory(path: string, allowedParent: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!existsSync(path)) throw error;
  }
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new PreparedReviewHandoffStoreError("prepared-review cache contains an unsafe directory");
  }
  const canonical = realpathSync(path);
  if (!isContainedPath(canonical, allowedParent)) {
    throw new PreparedReviewHandoffStoreError("prepared-review cache directory escapes its root");
  }
  return canonical;
}

function isContainedPath(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const effective = value ?? fallback;
  if (!Number.isSafeInteger(effective) || effective <= 0) {
    throw new RangeError(`prepared-review ${label} must be a positive safe integer`);
  }
  return effective;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("prepared-review operation aborted");
  error.name = "AbortError";
  throw error;
}

async function cooperativeYield(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
  throwIfAborted(signal);
}

async function cooperativeSort<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  throwIfAborted(signal);
  if (values.length < 2) return [...values];
  let source = [...values];
  let target = new Array<T>(source.length);
  let operations = 0;
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let left = start;
      let right = middle;
      let output = start;
      while (left < middle || right < end) {
        if (right >= end || (left < middle && compare(source[left]!, source[right]!) <= 0)) {
          target[output] = source[left]!;
          left += 1;
        } else {
          target[output] = source[right]!;
          right += 1;
        }
        output += 1;
        operations += 1;
        if (operations % MAINTENANCE_SORT_BATCH === 0) await cooperativeYield(signal);
      }
    }
    [source, target] = [target, source];
  }
  throwIfAborted(signal);
  return source;
}

async function readDirectoryNamesBounded(
  path: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    throwIfAborted(signal);
    names.push(entry.name);
    if (names.length >= maxEntries) break;
  }
  throwIfAborted(signal);
  return names;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return "then" in value && typeof (value as { then?: unknown }).then === "function";
}

async function retainGraphCapabilities(
  graphCapabilities: PreparedReviewHandoffStoreOptions["graphCapabilities"],
  document: PreparedReviewHandoffDocument,
  ownerId: string,
  retainedUntilMs: number,
  signal?: AbortSignal,
): Promise<void> {
  await graphCapabilities.retainMany([
    { id: document.head.graphId, expectedVcsCommit: document.headSha },
    { id: document.mergeBase.graphId, expectedVcsCommit: document.mergeBaseSha },
  ], preparedReviewOwner(ownerId), retainedUntilMs, { signal });
}

async function releaseGraphOwner(
  graphCapabilities: PreparedReviewHandoffStoreOptions["graphCapabilities"],
  ownerId: string,
  signal?: AbortSignal,
): Promise<void> {
  await graphCapabilities.releaseOwner(preparedReviewOwner(ownerId), { signal });
}

function preparedReviewOwner(id: string): GraphCapabilityExternalOwnerKey {
  if (!isPreparedReviewHandoffId(id)) throw new TypeError("prepared-review graph owner id is invalid");
  return Object.freeze({ scope: "prepared-review-handoff", id });
}

function graphOwnerExpectation(
  entry: Pick<PreparedReviewHandoffEntry, "document" | "touchedAt">,
  id: string,
  maxAgeMs: number,
): GraphCapabilityOwnerExpectation {
  return Object.freeze({
    owner: preparedReviewOwner(id),
    bindings: Object.freeze([
      Object.freeze({ id: entry.document.head.graphId, expectedVcsCommit: entry.document.headSha }),
      Object.freeze({
        id: entry.document.mergeBase.graphId,
        expectedVcsCommit: entry.document.mergeBaseSha,
      }),
    ]),
    retainedUntilMs: entry.touchedAt + maxAgeMs,
  });
}

function readPlainFileNoFollow(
  path: string,
  expectedParent: string,
  maxBytes: number,
  expectedMode: number,
): Buffer | null {
  if (dirname(path) !== expectedParent) return null;
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()
      || before.size <= 0n || before.size > BigInt(maxBytes)
      || fileMode(before) !== expectedMode
      || realpathSync(path) !== path) return null;
    descriptor = openSync(path, constants.O_RDONLY | requireNoFollowFlag());
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened)) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (offset <= 0 || offset > maxBytes
      || offset !== Number(opened.size)
      || !sameFileIdentity(opened, afterDescriptor)
      || !sameFileIdentity(afterDescriptor, afterPath)
      || realpathSync(path) !== path) return null;
    return Buffer.from(buffer.subarray(0, offset));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function quarantinePath(
  path: string,
  expected: BigIntStats,
  quarantineRoot: string,
  cleanup: QuarantineCleanupBatch,
): boolean {
  const parent = dirname(path);
  if (realpathOrNull(parent) !== parent || realpathOrNull(quarantineRoot) !== quarantineRoot) return false;
  let descriptor: number | undefined;
  let claimed = false;
  let openedIdentity: BigIntStats | undefined;
  let originalMode: number | undefined;
  // The sibling cache-local quarantine root is on the same filesystem, so rename remains the
  // atomic logical-removal commit. The identity digest makes crash leftovers self-authenticating:
  // startup only deletes an entry whose current inode/type still matches its claim name.
  const destination = join(
    quarantineRoot,
    `quarantine-${quarantineIdentityDigest(expected)}-${randomUUID()}`,
  );
  try {
    const before = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(expected, before)) return false;
    if (before.isDirectory() && !before.isSymbolicLink()) {
      descriptor = openSync(
        path,
        constants.O_RDONLY | requireNoFollowFlag() | requireDirectoryFlag(),
      );
      if (!sameFileIdentity(before, fstatSync(descriptor, { bigint: true }))) return false;
      openedIdentity = before;
      originalMode = fileMode(before);
      // Darwin requires write/search permission on a directory for a cross-parent rename. The
      // descriptor pins the exact inode while the lifecycle lock excludes cooperative mutation.
      fchmodSync(descriptor, 0o700);
    }
    renameSync(path, destination);
    const moved = lstatSync(destination, { bigint: true });
    const authoritative = descriptor === undefined
      ? before
      : fstatSync(descriptor, { bigint: true });
    if (!sameNodeIdentity(authoritative, moved)) {
      if (lstatOrNull(path) === null) {
        try {
          renameSync(destination, path);
        } catch {
          // Preserve the unexpected replacement in owner-only quarantine and fail closed. Its
          // identity cannot match the claim name, so startup will never delete it as owned data.
        }
      }
      return false;
    }
    claimed = true;
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    cleanup.add(destination, lstatSync(destination, { bigint: true }));
    return true;
  } catch (error) {
    const moved = lstatOrNull(destination);
    if (moved && sameNodeIdentity(expected, moved)) {
      try {
        if (!claimed && lstatOrNull(path) === null) renameSync(destination, path);
      } catch {
        // The expected object remains isolated; the identity-bound cleanup batch may safely retry.
      }
      const isolated = lstatOrNull(destination);
      if (isolated && sameNodeIdentity(expected, isolated)) cleanup.add(destination, isolated);
    }
    throw error;
  } finally {
    if (!claimed && descriptor !== undefined && openedIdentity && originalMode !== undefined) {
      const current = lstatOrNull(path);
      if (current && sameNodeIdentity(openedIdentity, current)) {
        try {
          fchmodSync(descriptor, originalMode);
        } catch {
          // A failed restore is surfaced by the enclosing operation; never chmod by a replaced path.
        }
      }
    }
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function quarantineIdentityDigest(identity: BigIntStats): string {
  const typeMask = BigInt(constants.S_IFMT);
  return createHash("sha256").update(JSON.stringify([
    identity.dev.toString(),
    identity.ino.toString(),
    (identity.mode & typeMask).toString(),
  ])).digest("hex");
}

async function removeQuarantinedTree(
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let entry: BigIntStats;
  try {
    entry = await lstatAsync(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameNodeIdentity(expected, entry)) {
    throw new PreparedReviewHandoffStoreError(
      "prepared-review quarantine entry changed before physical cleanup",
    );
  }
  await removeQuarantinedNode(path, entry, signal);
}

async function removeQuarantinedNode(
  path: string,
  expected: BigIntStats,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!expected.isDirectory() || expected.isSymbolicLink()) {
    const current = await lstatAsync(path, { bigint: true });
    if (!sameNodeIdentity(expected, current)) {
      throw new PreparedReviewHandoffStoreError(
        "prepared-review quarantine node changed during physical cleanup",
      );
    }
    await rmAsync(path, { force: true });
    return;
  }
  await chmodAsync(path, 0o700);
  const directory = await opendir(path);
  let visited = 0;
  for await (const child of directory) {
    throwIfAborted(signal);
    const childPath = join(path, child.name);
    const childIdentity = await lstatAsync(childPath, { bigint: true });
    await removeQuarantinedNode(childPath, childIdentity, signal);
    visited += 1;
    if (visited % MAINTENANCE_SCAN_BATCH === 0) await cooperativeYield(signal);
  }
  throwIfAborted(signal);
  const current = await lstatAsync(path, { bigint: true });
  if (!sameNodeIdentity(expected, current)) {
    throw new PreparedReviewHandoffStoreError(
      "prepared-review quarantine directory changed during physical cleanup",
    );
  }
  await rmdirAsync(path);
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function fileMode(entry: BigIntStats): number {
  return Number(entry.mode & 0o777n);
}

function sameNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  const typeMask = BigInt(constants.S_IFMT);
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & typeMask) === (right.mode & typeMask);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameNodeIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function requireNoFollowFlag(): number {
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new PreparedReviewHandoffStoreError("prepared-review handoffs require O_NOFOLLOW support");
  }
  return constants.O_NOFOLLOW;
}

function requireDirectoryFlag(): number {
  if (!Number.isSafeInteger(constants.O_DIRECTORY) || constants.O_DIRECTORY === 0) {
    throw new PreparedReviewHandoffStoreError("prepared-review handoffs require O_DIRECTORY support");
  }
  return constants.O_DIRECTORY;
}

function changedDuringScavenge(): PreparedReviewHandoffStoreError {
  return new PreparedReviewHandoffStoreError("prepared-review cache changed during atomic scavenge");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
